"""The real backend as the desktop shell runs it: a subprocess that prints one ready line, authenticates every call, runs a task in
real Chrome and exits cleanly (closing the Chrome it launched) when asked."""

import asyncio
import json
import os
import subprocess
import sys
import time

import httpx
import pytest
import websockets

from jarvis.chrome import find_chrome

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest.mark.skipif(find_chrome() is None, reason="Google Chrome is not installed")
async def test_the_packaged_style_sidecar_lifecycle(site, tmp_path):
    token = "a1" * 32
    env = {**os.environ, "JARVIS_TOKEN": token, "JARVIS_DATA_DIR": str(tmp_path / "data"), "JARVIS_DOWNLOADS_DIR": str(tmp_path / "dl"),
           "JARVIS_PORT": "0", "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen([sys.executable, "-m", "jarvis.server"], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        ready = json.loads(await asyncio.get_running_loop().run_in_executor(None, proc.stdout.readline))
        assert ready["event"] == "ready" and ready["port"] > 0 and ready["pid"] == proc.pid
        base = f"http://127.0.0.1:{ready['port']}"
        auth = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(base_url=base, headers=auth, timeout=60) as http:
            assert (await http.get("/health")).json()["status"] == "ready"
            assert (await httpx.AsyncClient().get(f"{base}/api/status")).status_code == 401
            await http.put("/api/settings", json={"agent": {"allow_local_urls": True}})  # the fixture site is on loopback
            conversation = (await http.post("/api/conversations", json={})).json()
            events = []

            async def listen():
                async with websockets.connect(f"ws://127.0.0.1:{ready['port']}/api/events", subprotocols=["jarvis.v1", f"bearer.{token}"]) as ws:
                    assert ws.subprotocol == "jarvis.v1"
                    async for raw in ws:
                        events.append(json.loads(raw))

            listener = asyncio.create_task(listen())
            await asyncio.sleep(0.5)
            posted = (await http.post(f"/api/conversations/{conversation['id']}/messages", json={"text": f"Open {site.url}/search?q=python"})).json()
            task_id = posted["task"]["id"]
            for _ in range(240):
                task = (await http.get(f"/api/tasks/{task_id}")).json()
                if task["status"] not in {"queued", "running"}:
                    break
                await asyncio.sleep(0.25)
            assert task["status"] == "done", task
            await asyncio.sleep(0.3)
            listener.cancel()
            types = [e["type"] for e in events]
            assert types[0] == "hello" and {"task.created", "task.status", "step.started", "step.finished", "assistant.message", "task.timings"} <= set(types)
            assert [e["seq"] for e in events] == sorted(e["seq"] for e in events)
            timings = next(e for e in events if e["type"] == "task.timings")["data"]
            assert timings["llm_calls"] == 0 and timings["total_ms"] > 0  # a URL needs no text model
            detail = (await http.get(f"/api/conversations/{conversation['id']}")).json()
            assert [m["role"] for m in detail["messages"]] == ["user", "assistant"] and detail["conversation"]["title"].startswith("Open http")
            chrome = (await http.get("/api/chrome/status")).json()
            assert chrome["state"] == "connected" and chrome["tabs"][0]["url"].endswith("/search?q=python")
            assert (await http.post("/api/shutdown")).json() == {"ok": True}
        for _ in range(100):
            if proc.poll() is not None:
                break
            await asyncio.sleep(0.1)
        assert proc.poll() == 0, "the sidecar must exit cleanly on shutdown"
        deadline = time.time() + 10
        while time.time() < deadline and any(str(tmp_path / "data") in line for line in os.popen("ps -axo command").read().splitlines()
                                              if "Google Chrome" in line and "--type=" not in line):
            await asyncio.sleep(0.3)
        leftover = [line for line in os.popen("ps -axo command").read().splitlines() if str(tmp_path / "data") in line and "--type=" not in line and "chrome-profile" in line]
        assert not leftover, "the managed Chrome must be closed with the app"
    finally:
        if proc.poll() is None:
            proc.kill()
