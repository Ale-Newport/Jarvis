"""Locating, launching and probing the user's real Google Chrome.

Two connection modes:

* managed  – launch the installed Chrome with a separate, persistent automation profile
             (never the user's normal profile) and a loopback DevTools port picked by Chrome itself.
* existing – attach to the user's already running Chrome. Chrome 144+ only exposes DevTools there after the
             user ticks "Allow remote debugging" at chrome://inspect/#remote-debugging and then answers a
             per-connection "Allow remote debugging?" sheet. We never click that sheet and never restart Chrome.
"""

from __future__ import annotations

import asyncio
import json
import os
import plistlib
import shlex
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

CHROME_BUNDLE_IDS = {"com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary"}
STANDARD_APP_PATHS = (
    Path("/Applications/Google Chrome.app"),
    Path.home() / "Applications" / "Google Chrome.app",
)
DEFAULT_CHROME_ROOT = Path.home() / "Library/Application Support/Google/Chrome"

HOW_TO_ENABLE = (
    "1. In Chrome, open `chrome://inspect/#remote-debugging`.\n"
    '2. Tick **Allow remote debugging for this browser instance**.\n'
    '3. Come back here and press **Connect**. Chrome will ask **"Allow remote debugging?"** — click **Allow**.\n\n'
    "Jarvis only opens and controls its own tabs. It never restarts Chrome or changes your profile."
)


class ChromeError(RuntimeError):
    pass


@dataclass(frozen=True)
class ChromeInstall:
    app: Path
    binary: Path
    version: str | None
    bundle_id: str


def inspect_app(app: Path) -> ChromeInstall:
    """Validate that `app` is a Google Chrome bundle."""
    app = Path(app).expanduser()
    if app.suffix != ".app":
        # Allow a path straight to the binary inside the bundle.
        for parent in app.parents:
            if parent.suffix == ".app":
                app = parent
                break
    info_path = app / "Contents/Info.plist"
    try:
        info = plistlib.loads(info_path.read_bytes())
    except (OSError, plistlib.InvalidFileException) as error:
        raise ChromeError(f"{app} is not an application bundle") from error
    bundle_id = info.get("CFBundleIdentifier", "")
    if bundle_id not in CHROME_BUNDLE_IDS:
        raise ChromeError(f"{app.name} is not Google Chrome (bundle id {bundle_id or 'unknown'})")
    executable = info.get("CFBundleExecutable", "Google Chrome")
    binary = app / "Contents/MacOS" / executable
    if not binary.exists():
        raise ChromeError(f"Chrome executable missing: {binary}")
    return ChromeInstall(app=app, binary=binary, version=info.get("CFBundleShortVersionString"), bundle_id=bundle_id)


def find_chrome(custom: str | None = None) -> ChromeInstall | None:
    """The user's Chrome: an explicit choice first, then the standard macOS locations."""
    if custom:
        return inspect_app(Path(custom))
    for candidate in STANDARD_APP_PATHS:
        if candidate.exists():
            try:
                return inspect_app(candidate)
            except ChromeError:
                continue
    # Spotlight knows about relocated copies.
    try:
        out = subprocess.run(
            ["mdfind", "kMDItemCFBundleIdentifier == 'com.google.Chrome'"],
            capture_output=True, text=True, timeout=4, check=False,
        ).stdout.splitlines()
        for line in out:
            try:
                return inspect_app(Path(line))
            except ChromeError:
                continue
    except (OSError, subprocess.SubprocessError):
        pass
    return None


# DevToolsActivePort ----------------------------------------------------------------------------------------


def read_active_port(profile_root: Path) -> tuple[int, str] | None:
    """(port, websocket path) written by Chrome when DevTools is listening for this user-data-dir."""
    try:
        lines = (profile_root / "DevToolsActivePort").read_text(errors="replace").splitlines()
        return int(lines[0].strip()), (lines[1].strip() if len(lines) > 1 else "")
    except (OSError, ValueError, IndexError):
        return None


def port_is_live(port: int, host: str = "127.0.0.1", timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_json(url: str, timeout: float = 1.5) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 - loopback only
            return json.loads(response.read())
    except (OSError, ValueError, urllib.error.URLError):
        return None


def browser_ws_url(port: int, ws_path: str = "") -> str | None:
    """Resolve the browser WebSocket URL for a loopback DevTools port."""
    info = http_json(f"http://127.0.0.1:{port}/json/version")
    if info and info.get("webSocketDebuggerUrl"):
        return info["webSocketDebuggerUrl"]
    # Chrome 147+ disables /json/* discovery on the default user-data-dir; the path in DevToolsActivePort works.
    if ws_path and port_is_live(port):
        return f"ws://127.0.0.1:{port}{ws_path}"
    return None


# Existing Chrome ----------------------------------------------------------------------------------------


def chrome_processes(exclude_profile: Path | None = None) -> list[int]:
    """PIDs of running main Chrome processes, optionally ignoring the one using our automation profile."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=4).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    pids = []
    for line in out.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if "/Contents/MacOS/Google Chrome" not in command or "Helper" in command or "--type=" in command:
            continue
        if exclude_profile and str(exclude_profile) in command:
            continue
        try:
            pids.append(int(pid_text))
        except ValueError:
            continue
    return pids


def remote_debugging_toggle(root: Path = DEFAULT_CHROME_ROOT) -> bool | None:
    """The chrome://inspect "Allow remote debugging" switch recorded in Local State (None = not recorded)."""
    try:
        state = json.loads((root / "Local State").read_text(errors="replace"))
        value = ((state.get("devtools") or {}).get("remote_debugging") or {}).get("user-enabled")
        return value if isinstance(value, bool) else None
    except (OSError, ValueError, AttributeError):
        return None


@dataclass
class ExistingProbe:
    running: bool
    debugging: str  # "unknown" | "off" | "on"
    ws_url: str | None
    detail: str


def probe_existing(managed_profile: Path | None, hint_port: int | None = None) -> ExistingProbe:
    running = bool(chrome_processes(exclude_profile=managed_profile))
    if not running:
        return ExistingProbe(False, "unknown", None, "Google Chrome is not running. Open Chrome first.")
    candidates: list[tuple[int, str]] = []
    if hint_port:
        candidates.append((hint_port, ""))
    active = read_active_port(DEFAULT_CHROME_ROOT)
    if active:
        candidates.append(active)
    candidates += [(9222, ""), (9223, "")]
    for port, ws_path in candidates:
        if port_is_live(port):
            ws = browser_ws_url(port, ws_path)
            if ws:
                return ExistingProbe(True, "on", ws, f"Remote debugging is available on port {port}.")
    toggle = remote_debugging_toggle()
    if toggle is False:
        return ExistingProbe(True, "off", None, "Chrome is running but remote debugging is turned off.")
    if toggle is True:
        return ExistingProbe(True, "off", None, "Remote debugging is enabled but Chrome is not listening yet.")
    return ExistingProbe(True, "off", None, "Chrome is running without remote debugging.")


# Managed Chrome ------------------------------------------------------------------------------------------


MANAGED_FLAGS = (
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1280,900",
)


class ManagedChrome:
    """Chrome launched by us with its own persistent user-data-dir."""

    def __init__(self, install: ChromeInstall, profile_dir: Path):
        self.install = install
        self.profile_dir = profile_dir
        self.process: subprocess.Popen | None = None

    def profile_pid(self) -> int | None:
        """PID holding the profile, from Chrome's SingletonLock symlink (`host-pid`)."""
        try:
            target = os.readlink(self.profile_dir / "SingletonLock")
            pid = int(target.rsplit("-", 1)[-1])
            os.kill(pid, 0)
            return pid
        except (OSError, ValueError):
            return None

    async def ensure_running(self, timeout: float = 25) -> str:
        """Return the browser WebSocket URL, launching Chrome only when the profile is not already in use."""
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        existing = self._live_ws()
        if existing:
            return existing
        if self.profile_pid():
            raise ChromeError(
                "The Jarvis automation profile is open in a Chrome window that has no DevTools port "
                "(it was started outside Jarvis). Close that window and press Connect again."
            )
        try:
            (self.profile_dir / "DevToolsActivePort").unlink()
        except OSError:
            pass
        args = [
            str(self.install.binary),
            f"--user-data-dir={self.profile_dir}",
            "--remote-debugging-port=0",
            *MANAGED_FLAGS,
            *shlex.split(os.environ.get("JARVIS_CHROME_FLAGS", "")),  # e.g. --headless=new for CI
            "about:blank",
        ]
        self.process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise ChromeError(f"Chrome exited immediately (code {self.process.returncode}).")
            ws = self._live_ws()
            if ws:
                return ws
            await asyncio.sleep(0.1)
        raise ChromeError("Chrome did not open its DevTools port in time.")

    def _live_ws(self) -> str | None:
        active = read_active_port(self.profile_dir)
        if active and port_is_live(active[0]):
            return browser_ws_url(*active)
        return None

    def stop(self, grace: float = 5.0) -> None:
        """Quit the Chrome we own (the caller normally sends Browser.close first so cookies flush)."""
        pids = {p for p in (self.process.pid if self.process else None, self.profile_pid()) if p}
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and any(_alive(p) for p in pids):
            time.sleep(0.1)
        for pid in pids:
            if _alive(pid):
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass

    def reset_profile(self) -> None:
        if self._live_ws() or self.profile_pid():
            raise ChromeError("Close the Jarvis Chrome window before resetting its profile.")
        shutil.rmtree(self.profile_dir, ignore_errors=True)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
