"""Existing-session mode against a Chrome that already runs with DevTools enabled (a stand-in for the user's own Chrome after they
ticked "Allow remote debugging"): Jarvis opens only its own tabs and leaves everything else alone."""

import asyncio
import socket
import subprocess

import pytest

from jarvis.browser import BrowserSession
from jarvis.chrome import find_chrome

pytestmark = pytest.mark.asyncio(loop_scope="session")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.skipif(find_chrome() is None, reason="Google Chrome is not installed")
async def test_existing_session_uses_only_its_own_tabs(site, tmp_path):
    install = find_chrome()
    port = free_port()
    user_chrome = subprocess.Popen(
        [str(install.binary), f"--user-data-dir={tmp_path / 'users-chrome'}", f"--remote-debugging-port={port}", "--no-first-run",
         "--no-default-browser-check", f"{site.url}/wiki"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    session = BrowserSession(tmp_path / "jarvis")
    try:
        session.hint_port = port
        for _ in range(60):
            status = await session.connect("existing", wait=20)
            if status["state"] == "connected":
                break
            await asyncio.sleep(0.5)
        assert status["state"] == "connected" and status["mode"] == "existing" and status["debugging"] == "on", status
        before = {t["targetId"] for t in (await session.conn.send("Target.getTargets"))["targetInfos"] if t["type"] == "page"}
        assert before, "the user's own tab exists"
        tab = await session.new_tab(f"{site.url}/search?q=python")  # opened in the background in existing mode
        assert (await tab.observe())["title"].endswith("Fixture Search")
        assert tab.id not in before and len(session.status()["tabs"]) == 1  # only the tab Jarvis opened is listed
        await session.disconnect()
        # Reconnect and check the user's tab survived and ours is gone.
        await session.connect("existing", wait=20)
        after = {t["targetId"] for t in (await session.conn.send("Target.getTargets"))["targetInfos"] if t["type"] == "page"}
        assert before <= after and tab.id not in after
    finally:
        await session.disconnect()
        user_chrome.terminate()


async def test_existing_mode_explains_how_to_enable_debugging_when_it_is_off(tmp_path, monkeypatch):
    from jarvis import chrome

    monkeypatch.setattr(chrome, "chrome_processes", lambda exclude_profile=None: [1])
    monkeypatch.setattr(chrome, "read_active_port", lambda root: None)
    monkeypatch.setattr(chrome, "port_is_live", lambda *a, **k: False)
    monkeypatch.setattr(chrome, "remote_debugging_toggle", lambda root=chrome.DEFAULT_CHROME_ROOT: None)
    session = BrowserSession(tmp_path)
    status = await session.connect("existing", wait=10)
    assert status["state"] == "error" and status["debugging"] == "off"
    assert "chrome://inspect/#remote-debugging" in status["how_to_enable"] and "Allow" in status["how_to_enable"]
