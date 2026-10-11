"""SQLite persistence: conversations, messages, tasks (with their step timelines) and settings. Local only."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, cards TEXT NOT NULL DEFAULT '[]', task_id TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL, goal TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

RUNNING = ("queued", "running", "paused", "waiting_user")


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.executescript(SCHEMA)
            # A previous run that died mid-task leaves tasks "running": they can never continue.
            self._db.execute(
                "UPDATE tasks SET status='failed', data=json_set(data,'$.status','failed','$.error','The app was closed while this task was running.') "
                f"WHERE status IN ({','.join('?' * len(RUNNING))})", RUNNING,
            )

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # Conversations ------------------------------------------------------------------------------------------

    def create_conversation(self, title: str | None = None) -> dict[str, Any]:
        row = {"id": str(uuid.uuid4()), "title": title or "New chat", "created_at": now(), "updated_at": now()}
        with self._lock:
            self._db.execute("INSERT INTO conversations VALUES (:id,:title,:created_at,:updated_at)", row)
        return row

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT c.*, (SELECT status FROM tasks t WHERE t.conversation_id=c.id ORDER BY t.created_at DESC LIMIT 1) AS last_task_status "
                "FROM conversations c WHERE id=?", (conversation_id,)).fetchone()
        return self._conv(row) if row else None

    def list_conversations(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT c.*, (SELECT status FROM tasks t WHERE t.conversation_id=c.id ORDER BY t.created_at DESC LIMIT 1) AS last_task_status "
                "FROM conversations c ORDER BY updated_at DESC").fetchall()
        return [self._conv(r) for r in rows]

    @staticmethod
    def _conv(row: sqlite3.Row) -> dict[str, Any]:
        out = {k: row[k] for k in ("id", "title", "created_at", "updated_at")}
        if row["last_task_status"]:
            out["last_task_status"] = row["last_task_status"]
        return out

    def rename_conversation(self, conversation_id: str, title: str) -> dict[str, Any] | None:
        with self._lock:
            self._db.execute("UPDATE conversations SET title=?, updated_at=? WHERE id=?", (title.strip()[:120] or "New chat", now(), conversation_id))
        return self.get_conversation(conversation_id)

    def touch(self, conversation_id: str) -> None:
        with self._lock:
            self._db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now(), conversation_id))

    def delete_conversation(self, conversation_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))

    def clear_conversation(self, conversation_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM messages WHERE conversation_id=?", (conversation_id,))
            self._db.execute("DELETE FROM tasks WHERE conversation_id=?", (conversation_id,))
            self._db.execute("UPDATE conversations SET title='New chat', updated_at=? WHERE id=?", (now(), conversation_id))

    # Messages ---------------------------------------------------------------------------------------------------

    def add_message(self, message: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO messages (id,conversation_id,role,text,cards,task_id,created_at) VALUES (?,?,?,?,?,?,?)",
                (message["id"], message["conversation_id"], message["role"], message["text"], json.dumps(message.get("cards", [])),
                 message.get("task_id"), message["created_at"]),
            )
        self.touch(message["conversation_id"])

    def messages(self, conversation_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM messages WHERE conversation_id=? ORDER BY seq", (conversation_id,)).fetchall()
        return [{"id": r["id"], "conversation_id": r["conversation_id"], "role": r["role"], "text": r["text"],
                 "cards": json.loads(r["cards"]), "task_id": r["task_id"], "created_at": r["created_at"]} for r in rows]

    # Tasks --------------------------------------------------------------------------------------------------------

    def save_task(self, task: dict[str, Any]) -> None:
        data = json.dumps(task, default=str)
        with self._lock:
            self._db.execute(
                "INSERT INTO tasks (id,conversation_id,status,goal,created_at,updated_at,data) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data",
                (task["id"], task["conversation_id"], task["status"], task["goal"], task.get("started_at") or now(), now(), data),
            )

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT data FROM tasks WHERE id=?", (task_id,)).fetchone()
        return json.loads(row["data"]) if row else None

    def tasks_for(self, conversation_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT data FROM tasks WHERE conversation_id=? ORDER BY created_at", (conversation_id,)).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def recent_tasks(self, limit: int = 30) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT data FROM tasks ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r["data"]) for r in rows]

    # Settings ----------------------------------------------------------------------------------------------------

    def load_settings(self) -> dict[str, Any]:
        with self._lock:
            rows = self._db.execute("SELECT key,value FROM settings").fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    def save_setting(self, key: str, value: Any) -> None:
        with self._lock:
            self._db.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
