"""In-process event bus: ordered, sequenced envelopes fanned out to WebSocket subscribers (docs/API.md)."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import UTC, datetime
from typing import Any

log = logging.getLogger("jarvis.events")


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class EventBus:
    def __init__(self, history: int = 500):
        self.seq = 0
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._recent: deque[dict[str, Any]] = deque(maxlen=history)

    def publish(self, type_: str, data: Any, *, conversation_id: str | None = None, task_id: str | None = None) -> dict[str, Any]:
        self.seq += 1
        event: dict[str, Any] = {"seq": self.seq, "ts": now_iso(), "type": type_, "data": data}
        if conversation_id:
            event["conversation_id"] = conversation_id
        if task_id:
            event["task_id"] = task_id
        self._recent.append(event)
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                log.warning("dropping a slow event subscriber")
                self._subscribers.discard(queue)
        return event

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=2000)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def emitter(self, *, conversation_id: str | None = None, task_id: str | None = None):
        """A callable (type, data) bound to a task, for code that should not know about the bus."""

        def emit(type_: str, data: Any) -> dict[str, Any]:
            return self.publish(type_, data, conversation_id=conversation_id, task_id=task_id)

        return emit
