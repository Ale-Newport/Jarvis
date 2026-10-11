"""Shared fixtures. Unit tests need nothing. Integration tests drive the real Google Chrome and the real Laya model
against the local fixture web (tests/fixture_site.py) with a scripted text model, so they are deterministic and offline.
Live tests (`--live`) use real websites and a real text model and are skipped by default."""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).parent))

from fixture_site import FixtureSite  # noqa: E402

from jarvis.browser import BrowserSession  # noqa: E402
from jarvis.chrome import find_chrome  # noqa: E402
from jarvis.events import EventBus  # noqa: E402
from jarvis.laya_engine import LayaEngine, cached_path, check_support  # noqa: E402
from jarvis.llm import LlmClient, LlmConfig, LlmResult  # noqa: E402
from jarvis.settings import Secrets, Settings  # noqa: E402
from jarvis.store import Store  # noqa: E402
from jarvis.task import ConversationContext, Services, TaskRun  # noqa: E402


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--live", action="store_true", help="run tests that use real websites and a real text model")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if not config.getoption("--live"):
        skip = pytest.mark.skip(reason="live test: pass --live (uses real websites; may hit CAPTCHAs)")
        for item in items:
            if "live" in item.keywords:
                item.add_marker(skip)


@pytest.fixture(scope="session")
def site() -> FixtureSite:
    s = FixtureSite().start()
    yield s
    s.stop()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def chrome(tmp_path_factory) -> AsyncIterator[BrowserSession]:
    """One real Chrome (managed mode, throwaway profile) shared by the integration tests."""
    if find_chrome() is None:
        pytest.skip("Google Chrome is not installed")
    session = BrowserSession(tmp_path_factory.mktemp("jarvis-data"))
    session.keep_open_on_quit = False
    status = await session.connect("managed")
    assert status["state"] == "connected", status
    yield session
    await session.shutdown()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def laya() -> LayaEngine:
    supported, reason = check_support()
    if not supported:
        pytest.skip(reason)
    engine = LayaEngine()
    if cached_path(engine.model_name) is None:
        pytest.skip("the Laya checkpoint is not downloaded")
    await engine.ensure_loaded()
    return engine


class ScriptedLLM(LlmClient):
    """A deterministic stand-in for the text model. `rules` maps a stage ("plan", "subplan", "extract", "verify", "answer") to a
    callable taking the prompt text and returning the JSON (or answer text). Everything downstream of it is the real code."""

    def __init__(self, rules: dict[str, Any]):
        super().__init__(LlmConfig(model="scripted"))
        verified = lambda _user: {"checks": [{"requirement": "request", "status": "verified", "evidence": "page"}], "results_present": True}  # noqa: E731
        self.rules = {"verify": verified, **rules}
        self.log: list[tuple[str, str]] = []

    @staticmethod
    def stage(system: str) -> str:
        for marker, name in (("planner inside Jarvis", "plan"), ("Split the user's browser sub-goal", "subplan"), ("extract structured records", "extract"),
                             ("audit whether the evidence", "verify")):
            if marker in system:
                return name
        return "other"

    async def chat_json(self, system, user, *, max_tokens=1500, attempts=2, validate=None, schema=None):  # type: ignore[override]
        stage = self.stage(system)
        self.log.append((stage, user))
        rule = self.rules.get(stage)
        if rule is None:
            raise AssertionError(f"the scripted model got an unexpected {stage!r} request: {user[:200]}")
        data = rule(user)
        return (validate(data) if validate else data), LlmResult(json.dumps(data), 1)

    async def stream(self, messages, **kwargs):  # type: ignore[override]
        self.log.append(("answer", messages[-1]["content"]))
        rule = self.rules.get("answer", lambda user: "Summary of the notes.")
        text = rule(messages[-1]["content"])
        for i in range(0, len(text), 40):
            yield text[i : i + 40]

    async def list_models(self) -> list[str]:  # type: ignore[override]
        return ["scripted"]


class Harness:
    """Builds a TaskRun against the shared browser and runs it to completion."""

    def __init__(self, chrome: BrowserSession, laya: LayaEngine, site: FixtureSite, tmp: Path):
        self.chrome, self.laya, self.site = chrome, laya, site
        self.bus = EventBus()
        self.store = Store(":memory:")
        self.settings = Settings(self.store, Secrets())
        self.settings.update({"agent": {"allow_local_urls": True, "max_minutes": 3}})
        self.tmp = tmp
        self.conversation = self.store.create_conversation()
        self.ctx = ConversationContext()
        self.events: list[dict[str, Any]] = []
        self.bus.subscribe  # noqa: B018
        self._queue = self.bus.subscribe()
        self.runs: list[TaskRun] = []

    def services(self, llm: ScriptedLLM) -> Services:
        search = lambda query, kind, engine: f"{self.site.url}/images?q={query}" if kind == "images" else f"{self.site.url}/search?q={query}"  # noqa: E731
        return Services(self.chrome, self.laya, llm, self.settings, self.bus, self.store, self.tmp / "downloads", search_override=search)

    def new_run(self, goal: str, llm: ScriptedLLM) -> TaskRun:
        import uuid

        run = TaskRun(self.services(llm), task_id=str(uuid.uuid4()), conversation_id=self.conversation["id"], message_id=str(uuid.uuid4()), goal=goal,
                      ctx=self.ctx, parent_task_id=self.ctx.last_task_id)
        self.runs.append(run)
        return run

    def drain(self) -> list[dict[str, Any]]:
        while not self._queue.empty():
            self.events.append(self._queue.get_nowait())
        return self.events

    async def run(self, goal: str, llm: ScriptedLLM, *, timeout: float = 120) -> TaskRun:
        run = self.new_run(goal, llm)
        task = run.start()
        await asyncio.wait_for(task, timeout)
        self.drain()
        return run


@pytest_asyncio.fixture(loop_scope="session")
async def harness(chrome, laya, site, tmp_path) -> AsyncIterator[Harness]:
    h = Harness(chrome, laya, site, tmp_path)
    yield h
    for tab in list(chrome.tabs.values()):  # leave the shared Chrome with one clean tab
        if len(chrome.tabs) > 1:
            await chrome.close_tab(tab)
