"""The local Laya decision model: support check, download with progress, load-once/warm, and inference.

MLX binds work to the thread that created its arrays, so the model is loaded and every forward pass runs on one
dedicated worker thread (`run`). The model is loaded once per process and reused by every task.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, TypeVar

log = logging.getLogger("jarvis.laya")

DEFAULT_MODEL = "aac6fef/laya-typed-decisions-mlx"
T = TypeVar("T")


class LayaUnavailable(RuntimeError):
    """Laya cannot run here (unsupported hardware, missing weights, load failure)."""


def check_support() -> tuple[bool, str]:
    """Laya needs MLX: Apple Silicon (arm64) on macOS 14+. Report why not, never crash."""
    if platform.system() != "Darwin":
        return False, "Laya runs through MLX, which needs macOS."
    if platform.machine() != "arm64":
        return False, (
            "This Mac has an Intel processor. Laya runs through MLX, which requires Apple Silicon (M1 or newer). "
            "Jarvis does not substitute a hosted decision API."
        )
    try:
        major = int(platform.mac_ver()[0].split(".")[0] or 0)
    except ValueError:
        major = 0
    if 0 < major < 14:
        return False, f"macOS {platform.mac_ver()[0]} is too old; MLX needs macOS 14 or newer."
    try:
        import mlx.core  # noqa: F401
    except Exception as error:  # ImportError, or a Metal/driver failure at import
        return False, f"MLX could not be loaded: {error}"
    return True, "Apple Silicon with MLX."


def cached_path(repo_id: str) -> Path | None:
    """The local snapshot folder when the checkpoint is fully cached, else None (no network)."""
    if Path(repo_id).is_dir():
        return Path(repo_id)
    try:
        from huggingface_hub import snapshot_download

        return Path(snapshot_download(repo_id, local_files_only=True))
    except Exception:
        return None


def folder_size(path: Path | None) -> int | None:
    if not path:
        return None
    total = 0
    for root, _dirs, files in os.walk(path, followlinks=True):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                pass
    return total


class LayaEngine:
    def __init__(self, model_name: str = DEFAULT_MODEL, emit: Callable[[str, dict], Any] | None = None):
        self.model_name = model_name
        self.emit = emit
        self._model: Any = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="laya")
        self._load_lock = asyncio.Lock()
        self.state = "missing"  # missing | idle | downloading | loading | ready | unsupported | error
        self.error: str | None = None
        self.load_ms: int | None = None
        self.warm_ms: int | None = None
        self._download_task: asyncio.Task | None = None
        self.calls = 0
        self.total_ms = 0.0
        self.refresh()

    # Status -----------------------------------------------------------------------------------------------

    def refresh(self) -> None:
        """Recompute the resting state: unsupported / ready / idle (downloaded, not loaded) / missing."""
        supported, reason = check_support()
        if not supported:
            self.state, self.error = "unsupported", reason
        elif self.state in {"downloading", "loading", "error"}:
            return  # transient or sticky until the next explicit action
        elif self._model is not None:
            self.state = "ready"
        else:
            self.state = "idle" if cached_path(self.model_name) is not None else "missing"

    def set_model(self, name: str) -> None:
        if name != self.model_name:
            self.model_name = name
            self._model = None
            self.state, self.error = "missing", None
            self.refresh()

    def status(self) -> dict[str, Any]:
        self.refresh()
        path = cached_path(self.model_name) if self.state != "unsupported" else None
        return {
            "model": self.model_name,
            "downloaded": path is not None,
            "size_bytes": folder_size(path),
            "state": self.state,
            "load_ms": self.load_ms,
            "warm_ms": self.warm_ms,
            "error": self.error,
        }

    async def _publish(self) -> None:
        if self.emit:
            result = self.emit("laya.status", self.status())
            if asyncio.iscoroutine(result):
                await result

    # Download ---------------------------------------------------------------------------------------------

    async def download(self) -> dict[str, Any]:
        if self.state == "unsupported":
            return self.status()
        if self._download_task and not self._download_task.done():
            return self.status()
        self.state, self.error = "downloading", None
        self._download_task = asyncio.create_task(self._download(), name="laya-download")
        await self._publish()
        return self.status()

    async def _download(self) -> None:
        loop = asyncio.get_running_loop()
        bars: dict[int, list[float]] = {}
        last_emit = 0.0
        emit = self.emit

        def report(done: bool = False, file: str = "") -> None:
            nonlocal last_emit
            now = time.monotonic()
            if not done and now - last_emit < 0.25:
                return
            last_emit = now
            got = sum(b[0] for b in bars.values())
            total = sum(b[1] for b in bars.values())
            if emit:
                loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(_maybe(emit("laya.download", {"bytes": int(got), "total": int(total), "file": file, "done": done})))
                )

        from tqdm.auto import tqdm

        class Progress(tqdm):  # type: ignore[misc]
            def __init__(self, *args: Any, **kwargs: Any):
                kwargs.pop("name", None)
                super().__init__(*args, **kwargs)
                if getattr(self, "unit", "") == "B":
                    bars[id(self)] = [0, self.total or 0]

            def update(self, n: float | None = 1) -> bool | None:
                result = super().update(n)
                if id(self) in bars:
                    bars[id(self)] = [self.n, self.total or 0]
                    report(file=str(self.desc or ""))
                return result

        def work() -> str:
            from huggingface_hub import snapshot_download

            return snapshot_download(self.model_name, tqdm_class=Progress)

        try:
            await asyncio.to_thread(work)
            report(done=True)
            self.state = "missing"  # refresh() promotes it to "idle" now that the cache is complete
            self.refresh()
        except Exception as error:
            log.warning("Laya download failed: %s", error)
            self.state, self.error = "error", f"Download failed: {error}"
        await self._publish()

    # Load ---------------------------------------------------------------------------------------------------

    async def run(self, fn: Callable[..., T], *args: Any) -> T:
        """Run `fn` on the dedicated Laya thread."""
        return await asyncio.get_running_loop().run_in_executor(self._executor, lambda: fn(*args))

    async def ensure_loaded(self) -> None:
        async with self._load_lock:
            if self._model is not None:
                return
            supported, reason = check_support()
            if not supported:
                self.state, self.error = "unsupported", reason
                raise LayaUnavailable(reason)
            path = cached_path(self.model_name)
            if path is None:
                self.state = "missing"
                raise LayaUnavailable("The Laya model is not downloaded yet. Download it from Settings or onboarding.")
            self.state, self.error = "loading", None
            await self._publish()
            try:
                load_ms, warm_ms = await self.run(self._load_and_warm, str(path))
            except Exception as error:
                self.state, self.error = "error", f"Could not load Laya: {error}"
                await self._publish()
                raise LayaUnavailable(self.error) from error
            self.load_ms, self.warm_ms = load_ms, warm_ms
            self.state = "ready"
            await self._publish()

    def _load_and_warm(self, path: str) -> tuple[int, int]:
        import laya_mlx

        started = time.perf_counter()
        self._model = laya_mlx.load(path)
        loaded = time.perf_counter()
        # The first forward passes compile Metal kernels; do it now, with a short and a long question.
        short = {"q": {"type": "choice", "instructions": "Warm up.", "criteria": ["a", "b"]}}
        self._model.system_one("Warm up.", short)
        long_options = {f"o{i}": f"element {i} button label text here" for i in range(14)}
        self._model.system_one(
            "Requirement: destination = Madrid\nPage: Search flights",
            {"q": {"type": "choice", "instructions": "Which element sets destination?", "criteria": long_options}},
        )
        done = time.perf_counter()
        return round((loaded - started) * 1000), round((done - loaded) * 1000)

    # Inference ----------------------------------------------------------------------------------------------

    def system_one(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        """Synchronous; call only from the Laya thread (`run`)."""
        if self._model is None:
            raise LayaUnavailable("Laya is not loaded.")
        started = time.perf_counter()
        result = self._model.system_one(state, questions)
        self.calls += 1
        self.total_ms += (time.perf_counter() - started) * 1000
        return result


async def _maybe(value: Any) -> None:
    if asyncio.iscoroutine(value):
        await value

