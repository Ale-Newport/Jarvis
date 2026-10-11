"""Application state shared by the HTTP layer: services, conversations, the single running task, onboarding."""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import httpx

from . import __version__
from . import chrome as chrome_mod
from .browser import BrowserSession
from .events import EventBus, now_iso
from .laya_engine import LayaEngine, check_support
from .llm import (
    PRESETS,
    LlmClient,
    LlmConfig,
    LlmError,
    disclosure_for,
    ollama_pull,
    pick_default_model,
)
from .settings import Secrets, Settings, SettingsError
from .store import Store
from .task import ConversationContext, Services, TaskRun

log = logging.getLogger("jarvis.app")

RECOMMENDED_MODEL = "qwen3:8b"
OLLAMA_CANDIDATES = ("/Applications/Ollama.app/Contents/Resources/ollama", "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class App:
    def __init__(self, data_dir: Path, *, downloads_dir: Path | None = None, secrets: Secrets | None = None):
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self.bus = EventBus()
        self.store = Store(data_dir / "jarvis.db")
        self.settings = Settings(self.store, secrets)
        self.downloads_dir = downloads_dir or Path.home() / "Downloads" / "Jarvis"
        self.browser = BrowserSession(data_dir, emit=self._emit_system)
        self.laya = LayaEngine(self.settings.get("laya.model"), emit=self._emit_system)
        self.llm = LlmClient(self._llm_config())
        self.services = Services(self.browser, self.laya, self.llm, self.settings, self.bus, self.store, self.downloads_dir)
        self.contexts: dict[str, ConversationContext] = {}
        self.tasks: dict[str, TaskRun] = {}
        self.running: TaskRun | None = None
        self._pull_task: asyncio.Task | None = None
        self.apply_chrome_settings()

    # Config ------------------------------------------------------------------------------------------------

    def _llm_config(self) -> LlmConfig:
        s = self.settings
        return LlmConfig(provider=s.get("llm.provider"), base_url=s.get("llm.base_url"), model=s.get("llm.model"),
                         api_key=s.secrets.get("llm_api_key"), json_mode=s.get("llm.json_mode"), reasoning=s.get("llm.reasoning"))

    def apply_chrome_settings(self) -> None:
        self.browser.mode = self.settings.get("chrome.mode") if not self.browser.connected else self.browser.mode
        self.browser.custom_path = self.settings.get("chrome.path")
        self.browser.keep_open_on_quit = self.settings.get("chrome.keep_open_on_quit")
        self.browser.hint_port = self.settings.get("chrome.existing_debug_port")

    def _emit_system(self, type_: str, data: Any) -> None:
        self.bus.publish(type_, data)

    async def update_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        try:
            public = self.settings.update(patch)
        except SettingsError as error:
            raise ApiError(400, "invalid_setting", str(error)) from error
        self.llm.configure(self._llm_config())
        if "laya" in patch:
            self.laya.set_model(self.settings.get("laya.model"))
        if "chrome" in patch:
            self.apply_chrome_settings()
            self._emit_system("chrome.status", self.browser.status())
        return public

    # Lifecycle ---------------------------------------------------------------------------------------------------

    async def start(self) -> None:
        """Warm the heavy parts in the background so the first task starts instantly."""
        if self.laya.status()["downloaded"]:
            asyncio.create_task(self._warm_laya())

    async def _warm_laya(self) -> None:
        try:
            await self.laya.ensure_loaded()
        except Exception as error:
            log.warning("Laya warm-up failed: %s", error)

    async def shutdown(self) -> None:
        if self.running:
            self.running.cancel()
            await asyncio.sleep(0.1)
        await self.browser.shutdown()
        await self.llm.aclose()
        self.store.close()

    # Conversations & tasks ---------------------------------------------------------------------------------------

    def context_for(self, conversation_id: str) -> ConversationContext:
        ctx = self.contexts.get(conversation_id)
        if ctx is None:
            ctx = ConversationContext()
            # Rebuild what a follow-up needs after a restart: the earlier requests and their outcomes.
            messages = self.store.messages(conversation_id)
            pending: str | None = None
            for m in messages:
                if m["role"] == "user":
                    pending = m["text"]
                elif m["role"] == "assistant" and pending:
                    ctx.summaries.append({"goal": pending, "outcome": " ".join(m["text"].split())[:300], "url": None, "title": ""})
                    pending = None
            ctx.summaries = ctx.summaries[-6:]
            self.contexts[conversation_id] = ctx
        return ctx

    async def send_message(self, conversation_id: str, text: str, *, parent_task_id: str | None = None) -> tuple[dict, dict]:
        conversation = self.store.get_conversation(conversation_id)
        if conversation is None:
            raise ApiError(404, "not_found", "Conversation not found.")
        text = text.strip()
        if not text:
            raise ApiError(400, "empty", "Type a request first.")
        if len(text) > 8000:
            raise ApiError(400, "too_long", "That request is too long (8,000 characters maximum).")
        if self.running and not self.running.finished:
            raise ApiError(409, "task_running", "Another task is running. Wait for it, or cancel it first.")
        user_message = {"id": str(uuid.uuid4()), "conversation_id": conversation_id, "role": "user", "text": text, "cards": [],
                        "task_id": None, "created_at": now_iso()}
        if conversation["title"] == "New chat":
            self.store.rename_conversation(conversation_id, " ".join(text.split())[:60])
        ctx = self.context_for(conversation_id)
        run = TaskRun(self.services, task_id=str(uuid.uuid4()), conversation_id=conversation_id, message_id=user_message["id"], goal=text,
                      ctx=ctx, parent_task_id=parent_task_id or ctx.last_task_id)
        user_message["task_id"] = run.id
        self.store.add_message(user_message)
        self.tasks[run.id] = run
        self.running = run
        self.store.save_task(run.to_dict())
        self.bus.publish("task.created", run.to_dict(), conversation_id=conversation_id, task_id=run.id)
        await self.ensure_llm_ready()
        task = run.start()
        task.add_done_callback(lambda _t: self._task_done(run))
        return user_message, run.to_dict()

    def _task_done(self, run: TaskRun) -> None:
        if self.running is run:
            self.running = None

    async def ensure_llm_ready(self) -> None:
        """Pick a model automatically when none is configured and the server has exactly what we need."""
        if self.settings.get("llm.model"):
            return
        try:
            models = await self.llm.list_models()
        except Exception:
            return
        chosen = pick_default_model(models)
        if chosen:
            self.settings.update({"llm": {"model": chosen}})
            self.llm.configure(self._llm_config())

    def task(self, task_id: str) -> TaskRun | None:
        return self.tasks.get(task_id)

    # Status ---------------------------------------------------------------------------------------------------------

    async def llm_status(self) -> dict[str, Any]:
        cfg = self.llm.config
        models: list[str] = []
        error = None
        reachable = False
        try:
            models = await self.llm.list_models()
            reachable = True if models else await self._reachable(cfg.base_url)
        except Exception as e:  # list_models swallows most errors
            error = str(e)
        if not reachable and not error:
            error = self.llm._unreachable()
        model_ok = bool(cfg.model) and any(cfg.model == m or cfg.model.split(":")[0] == m.split(":")[0] and ":" not in cfg.model for m in models)
        if cfg.remote:
            model_ok = bool(cfg.model) and reachable if not models else model_ok or bool(cfg.model)
        return {"provider": cfg.provider, "base_url": cfg.base_url, "model": cfg.model, "remote": cfg.remote, "reachable": reachable,
                "model_available": model_ok, "models": models, "error": None if reachable and (model_ok or not cfg.model) else error,
                "disclosure": disclosure_for(cfg.base_url)}

    @staticmethod
    async def _reachable(base_url: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                r = await client.get(base_url.rstrip("/") + "/models")
                return r.status_code < 500
        except httpx.HTTPError:
            return False

    async def system_status(self) -> dict[str, Any]:
        supported, _reason = check_support()
        return {
            "version": __version__, "arch": platform.machine(), "macos": platform.mac_ver()[0] or platform.platform(),
            "mlx_supported": supported, "chrome": self.browser.status(), "laya": self.laya.status(), "llm": await self.llm_status(),
            "busy_task_id": self.running.id if self.running and not self.running.finished else None,
        }

    async def onboarding(self) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []

        def add(id_: str, title: str, status: str, detail: str, action: tuple[str, str] | None = None) -> None:
            checks.append({"id": id_, "title": title, "status": status, "detail": detail,
                           **({"action": {"id": action[0], "label": action[1]}} if action else {})})

        arch = platform.machine()
        add("apple_silicon", "Apple Silicon", "ok" if arch == "arm64" else "error",
            "Apple Silicon (arm64) detected." if arch == "arm64" else f"This Mac reports {arch}. Laya runs through MLX, which needs Apple Silicon (M1 or newer). Jarvis will not substitute a hosted decision API.")
        mac = platform.mac_ver()[0]
        try:
            major = int(mac.split(".")[0])
        except ValueError:
            major = 0
        add("macos", "macOS version", "ok" if major >= 14 else "error", f"macOS {mac or 'unknown'}" + ("" if major >= 14 else " — macOS 14 or newer is required."))
        try:
            install = chrome_mod.find_chrome(self.settings.get("chrome.path"))
        except chrome_mod.ChromeError as error:
            install = None
            chrome_error = str(error)
        else:
            chrome_error = "Google Chrome was not found in /Applications."
        add("chrome", "Google Chrome", "ok" if install else "error",
            f"Chrome {install.version} at {install.app}" if install else chrome_error, None if install else ("choose_chrome", "Choose Chrome…"))
        add("python", "Local engine", "ok", f"Python {sys.version.split()[0]} backend running (v{__version__}).")
        laya = self.laya.status()
        if laya["state"] == "unsupported":
            add("laya_model", "Laya decision model", "error", laya["error"] or "Laya cannot run on this Mac.")
        elif laya["downloaded"]:
            detail = f"{laya['model']} is downloaded" + (f" and loaded (load {laya['load_ms']} ms, warm-up {laya['warm_ms']} ms)." if laya["state"] == "ready" else ".")
            add("laya_model", "Laya decision model", "ok", detail)
        else:
            add("laya_model", "Laya decision model", "error", f"{laya['model']} is not downloaded (about 850 MB, one time).", ("download_laya", "Download model (850 MB)"))
        await self.ensure_llm_ready()  # a server with chat models and no choice yet: adopt the best one
        llm = await self.llm_status()
        ollama_installed = bool(self.find_ollama())
        if llm["reachable"] and llm["model_available"]:
            add("text_model", "Text model", "ok", f"{llm['model']} via {llm['provider']}" + (" (remote — see disclosure in Settings)" if llm["remote"] else " (local)"))
        elif llm["reachable"] and llm["models"]:
            add("text_model", "Text model", "warn", f"{llm['provider']} is running with {len(llm['models'])} models; choose one in Settings.", ("choose_model", "Choose a model"))
        elif llm["reachable"]:
            add("text_model", "Text model", "error", f"{llm['provider']} is running but has no chat model.", ("pull_model", f"Download {RECOMMENDED_MODEL} (5 GB)"))
        elif ollama_installed and llm["provider"] == "ollama":
            add("text_model", "Text model", "error", "Ollama is installed but not running.", ("start_ollama", "Start Ollama"))
        elif llm["provider"] == "ollama":
            add("text_model", "Text model", "error", "No local text model server found. Install Ollama (ollama.com) or pick another provider in Settings.", ("open_settings", "Open AI settings"))
        else:
            add("text_model", "Text model", "error", llm["error"] or "The text model is not reachable.", ("open_settings", "Open AI settings"))
        chrome_status = self.browser.status()
        add("chrome_connection", "Chrome connection", "ok" if chrome_status["state"] == "connected" else "pending",
            "Connected." if chrome_status["state"] == "connected" else "Not tested yet." if not chrome_status["error"] else chrome_status["error"],
            None if chrome_status["state"] == "connected" else ("connect_chrome", "Test connection"))
        ready = all(c["status"] == "ok" for c in checks if c["id"] != "chrome_connection")
        return {"checks": checks, "ready": ready}

    # Ollama --------------------------------------------------------------------------------------------------------------

    @staticmethod
    def find_ollama() -> str | None:
        return next((p for p in OLLAMA_CANDIDATES if os.path.exists(p)), None) or shutil.which("ollama")

    async def start_ollama(self) -> bool:
        if await self._reachable(PRESETS["ollama"]):
            return True
        binary = self.find_ollama()
        if not binary:
            raise ApiError(404, "ollama_missing", "Ollama is not installed. Download it from ollama.com.")
        env = {**os.environ, "OLLAMA_CONTEXT_LENGTH": os.environ.get("OLLAMA_CONTEXT_LENGTH", "16384"),
               "OLLAMA_KEEP_ALIVE": os.environ.get("OLLAMA_KEEP_ALIVE", "30m")}
        subprocess.Popen([binary, "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)  # noqa: S603
        for _ in range(60):
            await asyncio.sleep(0.25)
            if await self._reachable(PRESETS["ollama"]):
                return True
        return False

    async def pull_model(self, model: str) -> None:
        if self._pull_task and not self._pull_task.done():
            raise ApiError(409, "pull_running", "A model download is already running.")
        if not await self._reachable(PRESETS["ollama"]):
            await self.start_ollama()

        async def run() -> None:
            try:
                await ollama_pull(model, lambda p: self.bus.publish("llm.pull", p))
                if not self.settings.get("llm.model"):
                    await self.update_settings({"llm": {"model": model}})
                self.bus.publish("llm.pull", {"status": "success", "completed": 1, "total": 1, "done": True})
            except LlmError as error:
                self.bus.publish("llm.pull", {"status": "error", "completed": 0, "total": 0, "done": True, "error": str(error)})

        self._pull_task = asyncio.create_task(run())
