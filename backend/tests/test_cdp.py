"""The CDP client against an in-process fake DevTools server."""

import asyncio
import json

import pytest
import websockets

from jarvis.cdp import CDPClosed, CDPConnection, CDPError


@pytest.fixture
async def server():
    received = []

    async def handler(ws):
        async for raw in ws:
            msg = json.loads(raw)
            received.append(msg)
            method = msg["method"]
            if method == "Echo.ping":
                await ws.send(json.dumps({"id": msg["id"], "result": {"pong": msg["params"].get("v")}}))
            elif method == "Boom":
                await ws.send(json.dumps({"id": msg["id"], "error": {"code": -32000, "message": "nope"}}))
            elif method == "Emit.event":
                await ws.send(json.dumps({"method": "Page.loadEventFired", "params": {"t": 1}, "sessionId": "S1"}))
                await ws.send(json.dumps({"id": msg["id"], "result": {}}))
            elif method == "Hang":
                pass
            elif method == "Close":
                await ws.close()

    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        yield f"ws://127.0.0.1:{port}", received


async def test_calls_return_results_and_errors(server):
    url, received = server
    conn = CDPConnection(url)
    await conn.connect()
    assert await conn.send("Echo.ping", {"v": 7}) == {"pong": 7}
    with pytest.raises(CDPError, match="nope") as info:
        await conn.send("Boom")
    assert info.value.code == -32000
    await conn.send("Echo.ping", {"v": 1}, session_id="S9")
    assert received[-1]["sessionId"] == "S9"
    assert conn.calls == 3
    await conn.close()


async def test_events_reach_listeners_and_one_shot_waiters(server):
    url, _ = server
    conn = CDPConnection(url)
    await conn.connect()
    seen = []
    off = conn.on("Page.loadEventFired", lambda event, session: seen.append((event["params"]["t"], session)))
    waiter = conn.expect("Page.loadEventFired", session_id="S1")
    other_session = conn.expect("Page.loadEventFired", session_id="S2")
    await conn.send("Emit.event")
    assert await asyncio.wait_for(waiter, 2) == {"t": 1}
    assert seen == [(1, "S1")] and not other_session.done()
    off()
    await conn.send("Emit.event")
    assert len(seen) == 1
    assert await conn.wait_for("Never.happens", timeout=0.1) is None
    await conn.close()


async def test_timeouts_and_a_lost_connection_fail_pending_calls_cleanly(server):
    url, _ = server
    conn = CDPConnection(url)
    await conn.connect()
    with pytest.raises(CDPError, match="timed out"):
        await conn.send("Hang", timeout=0.2)
    pending = asyncio.create_task(conn.send("Hang", timeout=5))
    await asyncio.sleep(0.05)
    await conn.close()
    with pytest.raises(CDPClosed):
        await pending
    with pytest.raises(CDPClosed):
        await conn.send("Echo.ping")


async def test_cancelling_a_caller_leaves_the_connection_usable(server):
    url, _ = server
    conn = CDPConnection(url)
    await conn.connect()
    task = asyncio.create_task(conn.send("Hang", timeout=30))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await conn.send("Echo.ping", {"v": 2}) == {"pong": 2}
    await conn.close()
