"""Chrome tabs and the browser session on top of the CDP connection.

`Tab` is the observed-action surface from jev-ultrafast / laya-ultrafast (observe → indexed elements → act with
freshness checks), re-implemented over one persistent async CDP connection with event-driven waiting.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import chrome as chrome_mod
from .cdp import CDPClosed, CDPConnection, CDPError

log = logging.getLogger("jarvis.browser")

PAGE_JS = Path(__file__).with_name("page.js").read_text()
USER_AGENT_TOKEN = "Jarvis"

MODIFIER_META = 4  # CDP modifier bit for Cmd on macOS


class StalePage(ValueError):
    """A decision no longer refers to the observed page."""


class ActionFailed(RuntimeError):
    """The target could not be acted on (covered, disabled, gone). Never retried blindly."""


class NavigationError(RuntimeError):
    pass


class BrowserNotConnected(RuntimeError):
    pass


@dataclass
class Metrics:
    """Wall-clock accounting for one task: where the time actually went."""

    browser_ms: float = 0.0
    page_load_ms: float = 0.0
    browser_ops: int = 0
    cdp_calls_at_start: int = 0
    profile: dict[str, list[float]] = field(default_factory=dict)  # operation -> [count, total_ms]

    def add(self, op: str, started: float) -> None:
        entry = self.profile.setdefault(op, [0, 0.0])
        entry[0] += 1
        entry[1] += (time.perf_counter() - started) * 1000

    def snapshot(self) -> dict[str, Any]:
        return {"browser_ms": round(self.browser_ms), "page_load_ms": round(self.page_load_ms), "browser_ops": self.browser_ops}


def fingerprint(state: dict[str, Any]) -> str:
    content = {k: state[k] for k in ("url", "text", "actions", "scroll")}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


SPECIAL_KEYS = {
    "Enter": {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r"},
    "Escape": {"key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
    "Tab": {"key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9},
    "ArrowDown": {"key": "ArrowDown", "code": "ArrowDown", "windowsVirtualKeyCode": 40},
    "ArrowUp": {"key": "ArrowUp", "code": "ArrowUp", "windowsVirtualKeyCode": 38},
    "Backspace": {"key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8},
}


class Tab:
    """One Chrome tab the agent owns."""

    def __init__(self, session: BrowserSession, target_id: str, opener_id: str | None = None):
        self.session = session
        self.conn = session.conn
        self.id = target_id
        self.opener_id = opener_id
        self.session_id: str = ""
        self.url = ""
        self.title = ""
        self.closed = False
        self.loading = False
        self.main_frame: str | None = None
        self._reached: dict[str, set[str]] = {}
        self._loader: str | None = None
        self._changed = asyncio.Event()
        self.dialogs: list[dict[str, Any]] = []
        self._after: dict[str, Any] | None = None
        self._nav_requested = False  # a navigation was requested by the page since the last input
        self._nav_committed = asyncio.Event()

    # Attach ---------------------------------------------------------------------------------------------

    async def attach(self) -> None:
        r = await self.conn.send("Target.attachToTarget", {"targetId": self.id, "flatten": True})
        self.session_id = r["sessionId"]
        self.session.tabs_by_session[self.session_id] = self
        send = self._send
        await asyncio.gather(
            send("Page.enable"),
            send("Page.setLifecycleEventsEnabled", {"enabled": True}),
            send("Emulation.setFocusEmulationEnabled", {"enabled": True}),
            send("Page.addScriptToEvaluateOnNewDocument", {"source": PAGE_JS, "runImmediately": True}),
        )
        tree = await send("Page.getFrameTree")
        self.main_frame = tree["frameTree"]["frame"]["id"]
        self.url = tree["frameTree"]["frame"].get("url", "")

    async def _send(self, method: str, params: dict[str, Any] | None = None, timeout: float | None = 30) -> dict[str, Any]:
        if self.closed:
            raise CDPError("tab is closed")
        return await self.conn.send(method, params, session_id=self.session_id, timeout=timeout)

    # Events ---------------------------------------------------------------------------------------------

    def on_event(self, method: str, params: dict[str, Any]) -> None:
        if method == "Page.lifecycleEvent":
            if params.get("frameId") == self.main_frame:
                loader = params.get("loaderId")
                if params["name"] == "init":
                    self._reached[loader] = set()
                self._reached.setdefault(loader, set()).add(params["name"])
                self._loader = loader
                self._changed.set()
        elif method == "Page.frameRequestedNavigation":
            if params.get("frameId") == self.main_frame and params.get("disposition", "currentTab") == "currentTab":
                self._nav_requested = True
        elif method == "Page.frameStartedLoading":
            if params.get("frameId") == self.main_frame:
                self.loading = True
                self._changed.set()
        elif method == "Page.frameStoppedLoading":
            if params.get("frameId") == self.main_frame:
                self.loading = False
                self._changed.set()
        elif method == "Page.frameNavigated":
            frame = params["frame"]
            if not frame.get("parentId"):
                self.main_frame = frame["id"]
                self.url = frame.get("url", self.url)
                self._nav_committed.set()
                self._changed.set()
        elif method == "Page.navigatedWithinDocument":
            if params.get("frameId") == self.main_frame:
                self.url = params.get("url", self.url)
                self._nav_committed.set()
                self._changed.set()
        elif method == "Page.javascriptDialogOpening":
            asyncio.create_task(self._handle_dialog(params))

    async def _handle_dialog(self, params: dict[str, Any]) -> None:
        """Alerts and "leave page?" prompts are acknowledged; confirm/prompt are declined (the safe default)."""
        kind = params.get("type")
        accept = kind in {"alert", "beforeunload"}
        self.dialogs.append({"type": kind, "message": params.get("message", "")[:300], "accepted": accept})
        try:
            await self._send("Page.handleJavaScriptDialog", {"accept": accept})
        except CDPError:
            pass

    # Navigation -----------------------------------------------------------------------------------------

    async def goto(self, url: str, *, wait: str = "load", timeout: float = 20) -> dict[str, Any]:
        """Navigate and wait for a lifecycle event (event-driven; proceeds on timeout with whatever rendered)."""
        started = time.perf_counter()
        result = await self._send("Page.navigate", {"url": url}, timeout=timeout)
        if result.get("errorText"):
            raise NavigationError(f"{result['errorText']} while opening {url}")
        loader = result.get("loaderId")
        loaded = True
        if loader and wait != "none":
            loaded = await self._wait_lifecycle(loader, wait, timeout)
        else:
            await asyncio.sleep(0)  # same-document navigation: nothing to wait for
        ms = round((time.perf_counter() - started) * 1000)
        self.session.metrics.page_load_ms += ms
        return {"loaded": loaded, "ms": ms}

    async def _wait_lifecycle(self, loader: str, until: str, timeout: float) -> bool:
        names = {"dcl": "DOMContentLoaded", "load": "load", "idle": "networkAlmostIdle"}
        wanted = names.get(until, until)
        deadline = time.monotonic() + timeout
        while True:
            if wanted in self._reached.get(loader, set()):
                return True
            if self.closed:
                raise CDPClosed("tab closed during navigation")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            self._changed.clear()
            try:
                await asyncio.wait_for(self._changed.wait(), remaining)
            except TimeoutError:
                return False

    async def wait_loaded(self, timeout: float = 15) -> bool:
        """After an action that may have navigated: wait until the main frame stops loading."""
        started = time.perf_counter()
        deadline = time.monotonic() + timeout
        while self.loading:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            self._changed.clear()
            try:
                await asyncio.wait_for(self._changed.wait(), remaining)
            except TimeoutError:
                return False
        self.session.metrics.page_load_ms += (time.perf_counter() - started) * 1000
        return True

    async def history(self, step: int) -> bool:
        """Go back (step=-1) or forward (+1). Returns False when there is no such entry."""
        hist = await self._send("Page.getNavigationHistory")
        index = hist["currentIndex"] + step
        if not 0 <= index < len(hist["entries"]):
            return False
        started = time.perf_counter()
        await self._send("Page.navigateToHistoryEntry", {"entryId": hist["entries"][index]["id"]})
        await asyncio.sleep(0.02)
        await self.wait_loaded()
        self.session.metrics.page_load_ms += (time.perf_counter() - started) * 1000
        return True

    async def reload(self) -> None:
        await self._send("Page.reload")
        await asyncio.sleep(0.02)
        await self.wait_loaded()

    # Evaluate ---------------------------------------------------------------------------------------------

    async def evaluate(self, expression: str, *, await_promise: bool = False, timeout: float = 30) -> Any:
        """Run a *code-owned* expression. Model output is never passed here."""
        r = await self._send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": await_promise},
            timeout=timeout,
        )
        if r.get("exceptionDetails"):
            detail = r["exceptionDetails"]
            text = (detail.get("exception") or {}).get("description") or detail.get("text", "")
            raise StalePage(f"Document changed during evaluation: {text[:120]}")
        return r.get("result", {}).get("value")

    async def _ensure_runtime(self) -> None:
        present = await self.evaluate("typeof window.__jarvis === 'object' && window.__jarvis.version === 9")
        if not present:
            await self.evaluate(PAGE_JS)

    # Observation ---------------------------------------------------------------------------------------

    async def observe(self, *, screenshot: bool = False) -> dict[str, Any]:
        """Settle after the previous action (if any), then read the indexed page state in one round trip."""
        started = time.perf_counter()
        if self._after:
            action, self._after = self._after, None
            settle_started = time.perf_counter()
            await self._settle(action)
            self.session.metrics.add("settle", settle_started)
        for attempt in range(12):
            try:
                eval_started = time.perf_counter()
                info = await self.evaluate("window.__jarvis ? window.__jarvis.observe() : 'NO_RUNTIME'")
                self.session.metrics.add("observe.eval", eval_started)
                if info == "NO_RUNTIME":
                    await self._ensure_runtime()
                    continue
                if info is None:
                    raise StalePage("Document is navigating")
                info["fingerprint"] = fingerprint(info)
                if screenshot:
                    info["screenshot"] = await self.screenshot()
                self.url, self.title = info["url"], info["title"]
                self.session.metrics.browser_ms += (time.perf_counter() - started) * 1000
                self.session.metrics.browser_ops += 1
                return info
            except StalePage:
                if attempt == 11:
                    raise
                await self.wait_loaded(timeout=5)
                await asyncio.sleep(0.03)
        raise StalePage("Page did not settle")

    async def _settle(self, action: dict[str, Any]) -> None:
        """Event-driven wait after an input: two paints, no DOM churn, autocomplete options visible."""
        navigated = False
        node = action.get("node")
        budget = 400 if action["kind"] == "fill" else 350
        try:
            await self.evaluate(
                f"window.__jarvis ? window.__jarvis.settle({json.dumps(node)},{json.dumps(action['kind'])},{budget}) : true",
                await_promise=True, timeout=5,
            )
        except (StalePage, CDPError):
            navigated = True  # the execution context went away: a navigation started
        if self._nav_requested and not self._nav_committed.is_set():
            # The page asked for a navigation (a form submit, a link) that has not committed yet: wait for it.
            try:
                await asyncio.wait_for(self._nav_committed.wait(), 4)
            except TimeoutError:
                pass
        if navigated or self.loading or self._nav_requested:
            await asyncio.sleep(0.01)
            await self.wait_loaded(timeout=15)
            try:
                await self.evaluate("window.__jarvis ? window.__jarvis.settle(null,'wait',60) : true", await_promise=True, timeout=5)
            except (StalePage, CDPError):
                pass

    async def fresh(self, page: dict[str, Any], action: dict[str, Any] | None = None) -> bool:
        started = time.perf_counter()
        try:
            return await self._fresh(page, action)
        finally:
            self.session.metrics.add("fresh", started)

    async def _fresh(self, page: dict[str, Any], action: dict[str, Any] | None = None) -> bool:
        if action is not None and action.get("kind") in {"click", "select", "fill"}:
            node = action.get("node")
            if type(node) is not int:
                return False
            try:
                current = await self.evaluate(f"window.__jarvis ? window.__jarvis.current({node}) : null")
            except StalePage:
                return False
            return current == [page["page_key"], page["guards"].get(str(node))]
        try:
            return await self.evaluate("window.__jarvis ? window.__jarvis.marker() : null") == page["marker"]
        except StalePage:
            return False

    # Actions --------------------------------------------------------------------------------------------

    async def act(self, action: dict[str, Any], page: dict[str, Any], text: str | None = None) -> dict[str, Any]:
        """Execute one observed action. Raises StalePage/ActionFailed; never retries a mutation by itself."""
        started = time.perf_counter()
        kind = action["kind"]
        if kind == "wait":
            await asyncio.sleep(0.1)
            return {"executed": action["id"]}
        if kind == "scroll":
            await self._send(
                "Input.dispatchMouseEvent",
                {"type": "mouseWheel", "x": page["w"] / 2, "y": page["h"] / 2, "deltaX": 0, "deltaY": action["delta"]},
            )
            self._after = action
            return {"executed": action["id"]}
        if type(action.get("node")) is not int:
            raise ValueError("Invalid observed node")
        self._nav_requested = False
        self._nav_committed.clear()
        if not await self.fresh(page, action):
            raise StalePage("Page changed since this decision. Observe again.")
        locate_started = time.perf_counter()
        located = await self.evaluate(
            f"window.__jarvis.locate({action['node']},{json.dumps(kind)},{json.dumps(action.get('value'))})"
        )
        self.session.metrics.add("locate", locate_started)
        if not located or not located.get("ok"):
            reason = (located or {}).get("reason", "unknown")
            if kind == "select":
                raise ActionFailed(f"Dropdown execution was not confirmed ({reason}); inspect before retrying.")
            raise StalePage(f"Target changed or is covered ({reason}). Observe again.")
        if kind != "select":
            x, y = located["x"], located["y"]
            await self._send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
            for event in ("mousePressed", "mouseReleased"):
                await self._send(
                    "Input.dispatchMouseEvent",
                    {"type": event, "x": x, "y": y, "button": "left", "clickCount": 1,
                     "buttons": 1 if event == "mousePressed" else 0},
                )
            if kind == "fill":
                chord = {"key": "a", "code": "KeyA", "modifiers": MODIFIER_META, "commands": ["selectAll"]}
                await self._send("Input.dispatchKeyEvent", {"type": "keyDown", **chord})
                await self._send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "a", "code": "KeyA", "modifiers": MODIFIER_META})
                await self._send("Input.insertText", {"text": text or ""})
        self._after = action
        self.session.metrics.browser_ms += (time.perf_counter() - started) * 1000
        self.session.metrics.browser_ops += 1
        return {"executed": action["id"]}

    async def click_observed_node(self, node: int) -> bool:
        """Click a node the page script itself registered while reading (an image thumbnail). Hit-tested like any click."""
        located = await self.evaluate(f"window.__jarvis.locate({int(node)},'click',null)")
        if not located or not located.get("ok"):
            return False
        x, y = located["x"], located["y"]
        await self._send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
        for event in ("mousePressed", "mouseReleased"):
            await self._send("Input.dispatchMouseEvent", {"type": event, "x": x, "y": y, "button": "left", "clickCount": 1,
                                                          "buttons": 1 if event == "mousePressed" else 0})
        return True

    async def image_details(self, previous: dict[str, Any] | None = None, timeout: float = 2.0) -> dict[str, Any] | None:
        """Poll for the opened image's details. A viewer panel still showing the previous image does not count."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                details = await self.evaluate("window.__jarvis.imageDetails()")
            except StalePage:
                return None
            if details and (previous is None or (details["image_url"], details["source_url"]) != (previous["image_url"], previous["source_url"])):
                return details
            await asyncio.sleep(0.1)
        return None

    async def press(self, key: str) -> None:
        """A fixed vocabulary of keys for keyboard-driven widgets; nothing arbitrary."""
        spec = SPECIAL_KEYS.get(key)
        if spec is None:
            raise ValueError(f"Unsupported key {key!r}")
        self._nav_requested = False
        self._nav_committed.clear()
        down = {"type": "keyDown", **spec}
        if "text" not in spec:
            down["type"] = "rawKeyDown"
        await self._send("Input.dispatchKeyEvent", down)
        await self._send("Input.dispatchKeyEvent", {"type": "keyUp", **{k: v for k, v in spec.items() if k != "text"}})
        self._after = {"kind": "key", "node": None}

    async def scroll_by(self, delta: int) -> None:
        w, h = await self.evaluate("[innerWidth, innerHeight]")
        await self._send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": w / 2, "y": h / 2, "deltaX": 0, "deltaY": delta})
        self._after = {"kind": "scroll", "node": None}

    # Reading ----------------------------------------------------------------------------------------------

    async def read(self, **opts: Any) -> dict[str, Any]:
        started = time.perf_counter()
        await self.wait_loaded(timeout=10)
        for attempt in range(6):
            try:
                await self._ensure_runtime()
                data = await self.evaluate(f"window.__jarvis.read({json.dumps(opts)})")
                break
            except StalePage:
                if attempt == 5:
                    raise
                await asyncio.sleep(0.05)
        self.session.metrics.browser_ms += (time.perf_counter() - started) * 1000
        self.session.metrics.browser_ops += 1
        return data

    async def screenshot(self, quality: int = 70) -> str:
        r = await self._send("Page.captureScreenshot", {"format": "jpeg", "quality": quality})
        return r["data"]

    async def screenshot_bytes(self, quality: int = 70) -> bytes:
        return base64.b64decode(await self.screenshot(quality))

    # Lifecycle --------------------------------------------------------------------------------------------

    async def activate(self) -> None:
        await self.conn.send("Target.activateTarget", {"targetId": self.id})

    async def close(self) -> None:
        if self.closed:
            return
        try:
            await self.conn.send("Target.closeTarget", {"targetId": self.id}, timeout=5)
        except CDPError:
            pass
        self.mark_closed()

    def mark_closed(self) -> None:
        self.closed = True
        self.session.tabs_by_session.pop(self.session_id, None)
        self._changed.set()


@dataclass
class DownloadRecord:
    guid: str
    url: str
    name: str
    state: str = "inProgress"
    received: int = 0
    total: int = 0
    path: str | None = None


EmitFn = Callable[[str, dict[str, Any]], Awaitable[None] | None]


class BrowserSession:
    """The connection to Chrome plus the tabs Jarvis opened. One per app."""

    def __init__(self, data_dir: Path, emit: EmitFn | None = None):
        self.data_dir = data_dir
        self.emit = emit
        self.mode = "managed"
        self.state = "disconnected"  # disconnected | connecting | awaiting_permission | connected | error
        self.error: str | None = None
        self.conn: CDPConnection = None  # type: ignore[assignment]
        self.tabs: dict[str, Tab] = {}
        self.tabs_by_session: dict[str, Tab] = {}
        self.active: Tab | None = None
        self.managed: chrome_mod.ManagedChrome | None = None
        self.install: chrome_mod.ChromeInstall | None = None
        self.metrics = Metrics()
        self.popups: list[Tab] = []
        self.downloads: dict[str, DownloadRecord] = {}
        self.download_dir: Path | None = None
        self._connect_lock = asyncio.Lock()
        self._connect_task: asyncio.Task | None = None
        self._watch: asyncio.Task | None = None
        self.debugging = "unknown"
        self.how_to_enable: str | None = None
        self.custom_path: str | None = None
        self.keep_open_on_quit = False
        self.hint_port: int | None = None

    # Status -----------------------------------------------------------------------------------------------

    @property
    def profile_dir(self) -> Path:
        return self.data_dir / "chrome-profile"

    def status(self) -> dict[str, Any]:
        try:
            install = self.install or chrome_mod.find_chrome(self.custom_path)
        except chrome_mod.ChromeError:
            install = None
        return {
            "installed": install is not None,
            "path": str(install.app) if install else None,
            "version": install.version if install else None,
            "mode": self.mode,
            "state": self.state,
            "debugging": self.debugging,
            "how_to_enable": self.how_to_enable if self.mode == "existing" else None,
            "profile_dir": str(self.profile_dir) if self.mode == "managed" else None,
            "tabs": [
                {"id": t.id, "title": t.title or t.url or "New tab", "url": t.url, "active": t is self.active}
                for t in self.tabs.values() if not t.closed
            ],
            "error": self.error,
        }

    async def _notify(self) -> None:
        if self.emit:
            result = self.emit("chrome.status", self.status())
            if asyncio.iscoroutine(result):
                await result

    @contextmanager
    def timed(self, field_name: str):
        started = time.perf_counter()
        try:
            yield
        finally:
            setattr(self.metrics, field_name, getattr(self.metrics, field_name) + (time.perf_counter() - started) * 1000)

    @property
    def connected(self) -> bool:
        return self.state == "connected" and self.conn is not None and not self.conn.closed.is_set()

    # Connection ------------------------------------------------------------------------------------------

    async def connect(self, mode: str | None = None, wait: float | None = None) -> dict[str, Any]:
        """Connect (or report the connection). The attempt runs as its own task, so a request may stop waiting after `wait`
        seconds (Chrome's "Allow remote debugging?" sheet can stay open for as long as the user takes) without abandoning it."""
        if self._connect_task is None or self._connect_task.done():
            self._connect_task = asyncio.create_task(self._connect(mode), name="chrome-connect")
        if wait is None:
            await asyncio.shield(self._connect_task)
        else:
            await asyncio.wait({self._connect_task}, timeout=wait)
        return self.status()

    async def _connect(self, mode: str | None = None) -> dict[str, Any]:
        async with self._connect_lock:
            if mode:
                if mode != self.mode and self.connected:
                    await self._disconnect()
                self.mode = mode
            if self.connected:
                return self.status()
            self.error = None
            self.state = "connecting"
            await self._notify()
            try:
                self.install = chrome_mod.find_chrome(self.custom_path)
                if self.install is None:
                    raise chrome_mod.ChromeError("Google Chrome was not found. Install it or choose its location in Settings.")
                if self.mode == "managed":
                    self.managed = chrome_mod.ManagedChrome(self.install, self.profile_dir)
                    ws = await self.managed.ensure_running()
                    self.debugging = "on"
                    conn = CDPConnection(ws)
                    await conn.connect(open_timeout=30)
                else:
                    probe = await asyncio.to_thread(chrome_mod.probe_existing, self.profile_dir, self.hint_port)
                    self.debugging = probe.debugging
                    if not probe.ws_url:
                        self.how_to_enable = None if not probe.running else chrome_mod.HOW_TO_ENABLE
                        raise chrome_mod.ChromeError(probe.detail + ("" if probe.running else ""))
                    self.how_to_enable = None
                    conn = CDPConnection(probe.ws_url)
                    self.state = "awaiting_permission"
                    await self._notify()
                    # Chrome shows "Allow remote debugging?" and holds the handshake until the user answers.
                    await conn.connect(open_timeout=None)
                self.conn = conn
                await self._after_connect()
                self.state = "connected"
            except asyncio.CancelledError:
                self.state = "disconnected"
                await self._notify()
                raise
            except Exception as error:
                self.state = "error"
                self.error = str(error)
                log.warning("Chrome connection failed: %s", error)
            await self._notify()
            return self.status()

    async def _after_connect(self) -> None:
        conn = self.conn
        conn.on("*", self._route_event)
        await conn.send("Target.setDiscoverTargets", {"discover": True})
        self._watch = asyncio.create_task(self._watch_connection(), name="chrome-watch")

    async def _watch_connection(self) -> None:
        await self.conn.closed.wait()
        if self.state == "connected":
            self.state = "disconnected"
            self.error = "Chrome closed the DevTools connection."
            for tab in list(self.tabs.values()):
                tab.mark_closed()
            self.tabs.clear()
            self.active = None
            await self._notify()

    def _route_event(self, event: dict[str, Any], session_id: str | None) -> None:
        method, params = event["method"], event["params"]
        if session_id and (tab := self.tabs_by_session.get(session_id)):
            tab.on_event(method, params)
            return
        if method == "Target.targetInfoChanged":
            info = params["targetInfo"]
            if (tab := self.tabs.get(info["targetId"])) and info["type"] == "page":
                tab.title, tab.url = info.get("title", tab.title), info.get("url", tab.url)
        elif method == "Target.targetCreated":
            info = params["targetInfo"]
            opener = info.get("openerId")
            if info["type"] == "page" and opener in self.tabs and info["targetId"] not in self.tabs:
                asyncio.create_task(self._adopt_popup(info))
        elif method == "Target.targetDestroyed":
            if tab := self.tabs.pop(params["targetId"], None):
                tab.mark_closed()
                if self.active is tab:
                    self.active = next(iter(self.tabs.values()), None)
        elif method == "Browser.downloadWillBegin":
            self.downloads[params["guid"]] = DownloadRecord(
                params["guid"], params.get("url", ""), params.get("suggestedFilename", "download")
            )
        elif method == "Browser.downloadProgress":
            rec = self.downloads.get(params["guid"])
            if rec:
                rec.state, rec.received, rec.total = params["state"], params.get("receivedBytes", 0), params.get("totalBytes", 0)
                if params["state"] == "completed" and self.download_dir:
                    rec.path = str(self.download_dir / params["guid"])

    async def _adopt_popup(self, info: dict[str, Any]) -> None:
        tab = Tab(self, info["targetId"], opener_id=info.get("openerId"))
        tab.url, tab.title = info.get("url", ""), info.get("title", "")
        self.tabs[tab.id] = tab
        try:
            await tab.attach()
        except CDPError:
            self.tabs.pop(tab.id, None)
            return
        self.popups.append(tab)

    def take_popups(self) -> list[Tab]:
        popups, self.popups = [t for t in self.popups if not t.closed], []
        return popups

    async def disconnect(self) -> dict[str, Any]:
        if self._connect_task and not self._connect_task.done():
            self._connect_task.cancel()  # e.g. the user gave up on the permission sheet
            await asyncio.gather(self._connect_task, return_exceptions=True)
        async with self._connect_lock:
            await self._disconnect()
        await self._notify()
        return self.status()

    async def _disconnect(self, quit_managed: bool = False) -> None:
        if self._watch:
            self._watch.cancel()
            self._watch = None
        if self.conn and not self.conn.closed.is_set():
            if self.mode == "managed" and quit_managed and not self.keep_open_on_quit:
                try:
                    await self.conn.send("Browser.close", timeout=5)
                except CDPError:
                    pass
            else:
                # Leave the user's windows alone; close only the tabs this app opened.
                for tab in list(self.tabs.values()):
                    if self.mode == "existing" or not tab.closed:
                        try:
                            await tab.close()
                        except Exception:
                            pass
            await self.conn.close()
        for tab in self.tabs.values():
            tab.mark_closed()
        self.tabs.clear()
        self.tabs_by_session.clear()
        self.active = None
        self.state = "disconnected"
        if self.managed and quit_managed and not self.keep_open_on_quit:
            await asyncio.to_thread(self.managed.stop)

    async def shutdown(self) -> None:
        async with self._connect_lock:
            await self._disconnect(quit_managed=True)

    async def reset_profile(self) -> None:
        await self.disconnect_and_quit_managed()
        chrome_mod.ManagedChrome(self.install or chrome_mod.find_chrome(self.custom_path), self.profile_dir).reset_profile()

    async def disconnect_and_quit_managed(self) -> None:
        async with self._connect_lock:
            keep, self.keep_open_on_quit = self.keep_open_on_quit, False
            try:
                await self._disconnect(quit_managed=self.mode == "managed")
            finally:
                self.keep_open_on_quit = keep
        await asyncio.sleep(0.5)

    # Tabs ------------------------------------------------------------------------------------------------

    async def ensure_connected(self) -> None:
        if not self.connected:
            status = await self.connect()
            if status["state"] != "connected":
                raise BrowserNotConnected(status.get("error") or "Chrome is not connected.")

    async def new_tab(self, url: str = "about:blank", *, foreground: bool | None = None, wait: str = "load", make_active: bool = True) -> Tab:
        await self.ensure_connected()
        if foreground is None:
            foreground = self.mode == "managed"
        tab = None
        if self.mode == "managed" and not self.tabs:
            # Reuse Chrome's initial blank tab instead of leaving an empty one behind.
            targets = (await self.conn.send("Target.getTargets"))["targetInfos"]
            blanks = [t for t in targets if t["type"] == "page" and t["url"] in {"about:blank", "chrome://newtab/", "chrome://new-tab-page/"}]
            if blanks:
                tab = Tab(self, blanks[0]["targetId"])
        if tab is None:
            created = await self.conn.send("Target.createTarget", {"url": "about:blank", "background": not foreground})
            tab = Tab(self, created["targetId"])
        self.tabs[tab.id] = tab
        await tab.attach()
        if foreground:
            await tab.activate()
        if make_active:
            self.active = tab
        if url and url != "about:blank":
            await tab.goto(url, wait=wait)
        await self._notify()
        return tab

    def get_tab(self, tab_id: str | None = None) -> Tab | None:
        if tab_id:
            return self.tabs.get(tab_id)
        return self.active if self.active and not self.active.closed else None

    async def close_tab(self, tab: Tab) -> None:
        await tab.close()
        self.tabs.pop(tab.id, None)
        if self.active is tab:
            self.active = next((t for t in self.tabs.values() if not t.closed), None)
        await self._notify()

    async def focus(self) -> None:
        if self.active and not self.active.closed:
            await self.active.activate()

    # Downloads ----------------------------------------------------------------------------------------------

    async def allow_downloads(self, directory: Path) -> None:
        """Only while a user-requested download runs, so the user's own Chrome keeps its normal behaviour."""
        directory.mkdir(parents=True, exist_ok=True)
        self.download_dir = directory
        await self.conn.send(
            "Browser.setDownloadBehavior",
            {"behavior": "allowAndName", "downloadPath": str(directory), "eventsEnabled": True},
        )

    async def restore_downloads(self) -> None:
        try:
            await self.conn.send("Browser.setDownloadBehavior", {"behavior": "default", "eventsEnabled": False})
        except CDPError:
            pass
        self.download_dir = None


__all__ = [
    "ActionFailed", "BrowserNotConnected", "BrowserSession", "DownloadRecord", "Metrics",
    "NavigationError", "StalePage", "Tab", "field", "fingerprint",
]
