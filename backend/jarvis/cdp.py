"""A small asynchronous Chrome DevTools Protocol client.

One WebSocket to the *browser* endpoint carries every tab ("flat" sessions), so a single connection serves all
targets and nothing needs a per-step subprocess or IPC hop. Events are dispatched to listeners and one-shot waiters,
which is what makes event-driven waiting (load, lifecycle, dialogs, downloads) possible without polling.

The approach to discovering and attaching to Chrome follows browser-harness (MIT, Browser Use):
https://github.com/browser-use/browser-harness
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

log = logging.getLogger("jarvis.cdp")

Listener = Callable[[dict[str, Any], str | None], Awaitable[None] | None]


class CDPError(RuntimeError):
    """A protocol-level error or a lost connection."""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


class CDPClosed(CDPError):
    """The browser connection is gone."""


class CDPConnection:
    def __init__(self, url: str):
        self.url = url
        self._ws: ClientConnection | None = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._listeners: dict[str, list[Listener]] = defaultdict(list)
        self._waiters: list[tuple[asyncio.Future[dict[str, Any]], str, str | None, Callable | None]] = []
        self._reader: asyncio.Task | None = None
        self.closed = asyncio.Event()
        self.close_reason: str | None = None
        self.calls = 0  # protocol round trips, for timing instrumentation

    # Connection ---------------------------------------------------------------------------------------------

    async def connect(self, *, open_timeout: float | None = 30) -> None:
        """Open the WebSocket. Chrome's "Allow remote debugging?" sheet holds the handshake open until the user
        answers, so callers that expect it pass open_timeout=None and cancel the task themselves."""
        self._ws = await websockets.connect(
            self.url,
            max_size=64 * 1024 * 1024,
            open_timeout=open_timeout,
            ping_interval=None,  # Chrome does not answer protocol pings reliably while busy
            compression=None,
        )
        self._reader = asyncio.create_task(self._read_loop(), name="cdp-reader")

    async def close(self) -> None:
        self._fail_all("connection closed")
        if self._reader:
            self._reader.cancel()
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
        self.closed.set()

    def _fail_all(self, reason: str) -> None:
        self.close_reason = self.close_reason or reason
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(CDPClosed(reason))
        self._pending.clear()
        for fut, *_ in self._waiters:
            if not fut.done():
                fut.set_exception(CDPClosed(reason))
        self._waiters.clear()

    async def _read_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                message = json.loads(raw)
                if "id" in message:
                    fut = self._pending.pop(message["id"], None)
                    if fut and not fut.done():
                        if "error" in message:
                            error = message["error"]
                            fut.set_exception(CDPError(error.get("message", "CDP error"), error.get("code")))
                        else:
                            fut.set_result(message.get("result", {}))
                elif "method" in message:
                    self._dispatch(message["method"], message.get("params", {}), message.get("sessionId"))
        except asyncio.CancelledError:
            raise
        except Exception as error:  # websockets.ConnectionClosed and friends
            self._fail_all(f"browser connection lost: {error}")
        else:
            self._fail_all("browser connection closed")
        finally:
            self.closed.set()

    def _dispatch(self, method: str, params: dict[str, Any], session_id: str | None) -> None:
        remaining = []
        for fut, want_method, want_session, predicate in self._waiters:
            if fut.done():
                continue
            if want_method == method and want_session in (None, session_id) and (not predicate or predicate(params)):
                fut.set_result(params)
            else:
                remaining.append((fut, want_method, want_session, predicate))
        self._waiters = remaining
        for listener in list(self._listeners.get(method, ())) + list(self._listeners.get("*", ())):
            try:
                result = listener({"method": method, "params": params}, session_id)
                if asyncio.iscoroutine(result):
                    asyncio.create_task(self._guard(result))
            except Exception:
                log.exception("CDP listener failed for %s", method)

    @staticmethod
    async def _guard(coro: Awaitable[None]) -> None:
        try:
            await coro
        except Exception:
            log.exception("CDP async listener failed")

    # Calls and events ---------------------------------------------------------------------------------------

    async def send(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        session_id: str | None = None,
        timeout: float | None = 30,
    ) -> dict[str, Any]:
        if self._ws is None or self.closed.is_set():
            raise CDPClosed(self.close_reason or "not connected")
        self._next_id += 1
        call_id = self._next_id
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[call_id] = fut
        message: dict[str, Any] = {"id": call_id, "method": method, "params": params or {}}
        if session_id:
            message["sessionId"] = session_id
        self.calls += 1
        try:
            await self._ws.send(json.dumps(message))
        except Exception as error:
            self._pending.pop(call_id, None)
            raise CDPClosed(f"browser connection lost: {error}") from error
        try:
            return await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            self._pending.pop(call_id, None)
            raise CDPError(f"{method} timed out after {timeout:g}s") from None
        except asyncio.CancelledError:
            self._pending.pop(call_id, None)  # a cancelled task must not leave the connection in a bad state
            raise

    def on(self, method: str, listener: Listener) -> Callable[[], None]:
        """Subscribe to an event name ("*" for all). Returns an unsubscribe function."""
        self._listeners[method].append(listener)

        def off() -> None:
            if listener in self._listeners[method]:
                self._listeners[method].remove(listener)

        return off

    def expect(
        self, method: str, *, session_id: str | None = None, predicate: Callable[[dict], bool] | None = None
    ) -> asyncio.Future[dict[str, Any]]:
        """Register a one-shot waiter *before* triggering the action that fires the event."""
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._waiters.append((fut, method, session_id, predicate))
        return fut

    async def wait_for(
        self,
        method: str,
        *,
        session_id: str | None = None,
        predicate: Callable[[dict], bool] | None = None,
        timeout: float = 15,
    ) -> dict[str, Any] | None:
        fut = self.expect(method, session_id=session_id, predicate=predicate)
        try:
            return await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            return None
        finally:
            if not fut.done():
                fut.cancel()
