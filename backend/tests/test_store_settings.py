import json
import sqlite3

import pytest

from jarvis.settings import Secrets, Settings, SettingsError
from jarvis.store import Store


def test_conversations_messages_and_tasks_round_trip(tmp_path):
    store = Store(tmp_path / "t.db")
    conv = store.create_conversation()
    store.add_message({"id": "m1", "conversation_id": conv["id"], "role": "user", "text": "hi", "cards": [], "task_id": "t1", "created_at": "2026-01-01T00:00:00Z"})
    store.add_message({"id": "m2", "conversation_id": conv["id"], "role": "assistant", "text": "yo", "cards": [{"type": "sources", "items": []}], "task_id": "t1", "created_at": "2026-01-01T00:00:01Z"})
    store.save_task({"id": "t1", "conversation_id": conv["id"], "status": "done", "goal": "hi", "started_at": "2026-01-01T00:00:00Z", "steps": []})
    assert [m["role"] for m in store.messages(conv["id"])] == ["user", "assistant"]
    assert store.messages(conv["id"])[1]["cards"][0]["type"] == "sources"
    assert store.get_conversation(conv["id"])["last_task_status"] == "done"
    store.rename_conversation(conv["id"], "  Renamed  ")
    assert store.get_conversation(conv["id"])["title"] == "Renamed"
    store.clear_conversation(conv["id"])
    assert store.messages(conv["id"]) == [] and store.tasks_for(conv["id"]) == []
    store.delete_conversation(conv["id"])
    assert store.list_conversations() == []


def test_history_persists_across_restarts_and_unfinished_tasks_are_marked_failed(tmp_path):
    path = tmp_path / "t.db"
    store = Store(path)
    conv = store.create_conversation("Persisted")
    store.save_task({"id": "t1", "conversation_id": conv["id"], "status": "running", "goal": "g", "started_at": "2026-01-01T00:00:00Z"})
    store.save_task({"id": "t2", "conversation_id": conv["id"], "status": "done", "goal": "g", "started_at": "2026-01-01T00:00:01Z"})
    store.close()
    again = Store(path)
    assert again.get_conversation(conv["id"])["title"] == "Persisted"
    assert again.get_task("t1")["status"] == "failed" and "closed" in again.get_task("t1")["error"]
    assert again.get_task("t2")["status"] == "done"


def test_settings_have_defaults_validate_input_and_persist(tmp_path):
    store = Store(tmp_path / "t.db")
    settings = Settings(store, Secrets())
    assert settings.get("chrome.mode") == "managed" and settings.get("llm.base_url").endswith("11434/v1") and settings.get("agent.confirm_sensitive") is True
    settings.update({"agent": {"max_steps": 20}, "llm": {"model": "qwen3:8b"}, "appearance": "dark"})
    for bad in ({"nope": 1}, {"agent": {"max_steps": 0}}, {"agent": {"max_steps": True}}, {"chrome": {"mode": "weird"}}, {"llm": {"provider": "skynet"}}):
        with pytest.raises(SettingsError):
            settings.update(bad)
    assert settings.get("agent.max_steps") == 20  # a rejected patch changes nothing
    reloaded = Settings(store, Secrets())
    assert reloaded.get("llm.model") == "qwen3:8b" and reloaded.get("appearance") == "dark"


def test_secrets_never_reach_the_database_or_the_public_settings(tmp_path, monkeypatch):
    store = Store(tmp_path / "t.db")
    secrets = Secrets()
    secrets._keyring = None  # no Keychain in tests: memory only
    secrets.backend = "memory"
    settings = Settings(store, secrets)
    assert settings.public()["llm"]["api_key_set"] is False
    secrets.set("llm_api_key", "sk-very-secret")
    public = settings.public()
    assert public["llm"]["api_key_set"] is True and "sk-very-secret" not in json.dumps(public)
    settings.update({"llm": {"model": "x", "api_key_set": True}})  # the read-only flag is ignored, not stored
    raw = sqlite3.connect(tmp_path / "t.db").execute("SELECT value FROM settings").fetchall()
    assert "sk-very-secret" not in json.dumps(raw) and "api_key" not in json.dumps(raw)
    secrets.delete("llm_api_key")
    assert settings.public()["llm"]["api_key_set"] is False
