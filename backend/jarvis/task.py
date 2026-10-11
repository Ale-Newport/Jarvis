"""One user request, end to end: interpret → plan → observe → Laya → Chrome → verify → answer.

The supervisor is deliberately lazy about the text model: a plan is requested once, executed step by step with
independent checks, and the model is consulted again only when the browser's state requires a decision
(replanning), never per click.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import httpx

from . import planner, safety
from .browser import BrowserNotConnected, BrowserSession, NavigationError, StalePage
from .cdp import CDPError
from .events import EventBus, now_iso
from .goal_runner import GoalResult, Hooks
from .laya_engine import LayaEngine, LayaUnavailable
from .llm import LlmClient, LlmError
from .planner import Plan, PlanStep
from .tools import Observation, Tools

log = logging.getLogger("jarvis.task")

MAX_REPLANS = 6
MAX_CONSECUTIVE_FAILURES = 3
BROWSER_KINDS = {"navigate", "search", "click", "type", "select", "scroll", "key", "back", "forward", "tab", "download", "read"}
FAST_URL = re.compile(r"^\s*(?:please\s+)?(?:open|go to|goto|visit|navigate to|load|take me to)\s+(?:the\s+)?(?:website\s+|site\s+|page\s+)?<?(\S+?)>?[.!]?\s*$", re.I)


class TaskCancelled(Exception):
    pass


class BudgetExceeded(Exception):
    pass


class UserDenied(Exception):
    pass


@dataclass
class Note:
    kind: str  # page | records | images | download
    url: str
    title: str
    text: str
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Services:
    browser: BrowserSession
    laya: LayaEngine
    llm: LlmClient
    settings: Any
    bus: EventBus
    store: Any
    downloads_dir: Path
    search_override: Any = None  # tests: (query, kind, engine) -> URL, so no real search engine is needed


@dataclass
class ConversationContext:
    """What a follow-up needs from earlier tasks in the same conversation."""

    tab_id: str | None = None
    summaries: list[dict[str, Any]] = field(default_factory=list)
    links: dict[str, dict[str, Any]] = field(default_factory=dict)
    images: list[dict[str, Any]] = field(default_factory=list)
    last_task_id: str | None = None

    def summary_text(self) -> str:
        if not self.summaries:
            return ""
        lines = [f"- Earlier request: {s['goal'][:160]} → {s['outcome'][:240]}" + (f" (page: {s['title'][:60]} {s['url']})" if s.get("url") else "")
                 for s in self.summaries[-4:]]
        return "CONVERSATION CONTEXT (earlier tasks; follow-ups refer to this):\n" + "\n".join(lines) + "\n\n"


class TaskRun:
    def __init__(self, services: Services, *, task_id: str, conversation_id: str, message_id: str, goal: str,
                 ctx: ConversationContext, parent_task_id: str | None = None):
        self.services = services
        self.id, self.conversation_id, self.message_id, self.goal = task_id, conversation_id, message_id, goal
        self.parent_task_id = parent_task_id
        self.ctx = ctx
        self.emit = services.bus.emitter(conversation_id=conversation_id, task_id=task_id)
        self.status = "queued"
        self.error: str | None = None
        self.steps: list[dict[str, Any]] = []
        self.notes: list[Note] = []
        self.cards: list[dict[str, Any]] = []
        self.progress: list[tuple[PlanStep, Observation]] = []
        self.current: dict[str, Any] | None = None
        self.waiting: dict[str, Any] | None = None
        self.timings: dict[str, Any] | None = None
        self.question: str | None = None
        self.started_at: str | None = now_iso()  # tasks start the moment they are created; the UI's clock needs this immediately
        self.finished_at: str | None = None
        self._t0 = time.perf_counter()
        self._elapsed_ms = 0
        self._wait_ms = 0.0
        self._running = asyncio.Event()
        self._running.set()
        self._cancelled = False
        self._manual: asyncio.Future[None] | None = None
        self._confirms: dict[str, asyncio.Future[bool]] = {}
        self._asyncio_task: asyncio.Task | None = None
        self.user_urls = frozenset(safety.urls_in(goal))
        self.tab = None
        self.page: dict[str, Any] | None = None
        self.llm_ms = 0
        self.llm_calls = 0
        self.laya_ms = 0
        self.laya_calls = 0
        self.actions_used = 0
        self.tools = Tools(self)
        self.tools.links, self.tools.images = ctx.links, ctx.images
        self.result: dict[str, Any] | None = None
        self.assistant_message_id = str(uuid.uuid4())
        self.verification: dict[str, Any] | None = None
        self.hint = ""
        self.completion_replans = 0
        self.denied = False
        self.final_then = "done"
        self.verification_text = ""
        self.audit_failed = False

    # Settings ---------------------------------------------------------------------------------------------

    def cfg(self, path: str) -> Any:
        return self.services.settings.get(path)

    def screenshots(self) -> bool:
        return self.cfg("agent.screenshots") == "per_step"

    def actions_left(self) -> int:
        return max(1, int(self.cfg("agent.max_steps")) - self.actions_used)

    # Status & snapshot -----------------------------------------------------------------------------------

    def elapsed_ms(self) -> int:
        if self.finished_at or not self.started_at:
            return self._elapsed_ms
        return round((time.perf_counter() - self._t0) * 1000)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "conversation_id": self.conversation_id, "message_id": self.message_id, "goal": self.goal,
            "status": self.status, "started_at": self.started_at, "finished_at": self.finished_at, "elapsed_ms": self.elapsed_ms(),
            "steps": self.steps, "current": self.current, "waiting": self.waiting, "error": self.error, "timings": self.timings,
            "parent_task_id": self.parent_task_id,
        }

    def set_status(self, status: str, *, waiting: dict[str, Any] | None = None) -> None:
        self.status = status
        self.waiting = waiting
        payload: dict[str, Any] = {"status": status, "waiting": waiting, "error": self.error, "current": self.current,
                                   "started_at": self.started_at, "elapsed_ms": self.elapsed_ms()}
        self.emit("task.status", payload)
        self.services.store.save_task(self.to_dict())

    @property
    def finished(self) -> bool:
        return self.status in {"done", "partial", "failed", "cancelled"}

    # Control ----------------------------------------------------------------------------------------------

    def start(self) -> asyncio.Task:
        self._asyncio_task = asyncio.create_task(self.run(), name=f"task-{self.id[:8]}")
        return self._asyncio_task

    def pause(self) -> None:
        if self.status == "running":
            self._running.clear()
            self.set_status("paused")

    def resume(self) -> None:
        if self.status == "paused":
            self._running.set()
            self.set_status("running")
        elif self.status == "waiting_user" and self._manual and not self._manual.done():
            self._manual.set_result(None)

    def cancel(self) -> None:
        if self.finished:
            return
        self._cancelled = True
        self._running.set()
        for future in self._confirms.values():
            if not future.done():
                future.set_result(False)
        if self._manual and not self._manual.done():
            self._manual.set_result(None)
        if self._asyncio_task and not self._asyncio_task.done():
            self._asyncio_task.cancel()

    def answer_confirmation(self, confirmation_id: str, approved: bool) -> bool:
        future = self._confirms.get(confirmation_id)
        if future is None or future.done():
            return False
        future.set_result(approved)
        return True

    async def checkpoint(self) -> None:
        """Called between every step: honours pause, cancel and the time budget."""
        if self._cancelled:
            raise TaskCancelled()
        if not self._running.is_set():
            started = time.perf_counter()
            await self._running.wait()
            self._wait_ms += (time.perf_counter() - started) * 1000
        if self._cancelled:
            raise TaskCancelled()
        budget_ms = float(self.cfg("agent.max_minutes")) * 60_000
        if (time.perf_counter() - self._t0) * 1000 - self._wait_ms > budget_ms:
            raise BudgetExceeded(f"The {self.cfg('agent.max_minutes'):g}-minute time budget ran out.")
        if self.actions_used >= int(self.cfg("agent.max_steps")):
            raise BudgetExceeded(f"The {self.cfg('agent.max_steps')}-action budget ran out.")

    async def confirm(self, kind: str, question: str, detail: str = "") -> bool:
        confirmation_id = str(uuid.uuid4())
        future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._confirms[confirmation_id] = future
        waiting = {"kind": "confirm", "message": question, "confirmation_id": confirmation_id, "detail": detail}
        self.emit("confirm.request", {"confirmation_id": confirmation_id, "kind": kind, "question": question, "detail": detail})
        self.set_status("waiting_user", waiting=waiting)
        started = time.perf_counter()
        try:
            approved = await future
        finally:
            self._wait_ms += (time.perf_counter() - started) * 1000
            self._confirms.pop(confirmation_id, None)
        if self._cancelled:
            raise TaskCancelled()
        self.set_status("running")
        return approved

    async def handle_challenge(self, page: dict[str, Any]) -> bool:
        """CAPTCHA / bot check / sign-in wall: stop, let the user act in Chrome, continue when they say so."""
        reloaded = False
        for _ in range(4):
            found = safety.detect_challenge(page)
            if not found:
                return True
            kind, message = found
            self.emit("needs_user", {"kind": kind, "message": message, "url": page["url"]})
            self._manual = asyncio.get_running_loop().create_future()
            self.set_status("waiting_user", waiting={"kind": kind, "message": message})
            if self.tab is not None and self.services.browser.mode == "managed":
                try:
                    await self.tab.activate()
                except CDPError:
                    pass
            started = time.perf_counter()
            try:
                await asyncio.wait_for(self._manual, 15 * 60)
            except TimeoutError:
                self.set_status("running")
                return False
            finally:
                self._wait_ms += (time.perf_counter() - started) * 1000
            if self._cancelled:
                raise TaskCancelled()
            self.set_status("running")
            page = await self.tab.observe()
            if safety.detect_challenge(page) and not reloaded:
                # The user finished the check but this page was not refreshed (a cookie was set): load it again once.
                reloaded = True
                await self.tab.reload()
                page = await self.tab.observe()
            self.page = page
        return not safety.detect_challenge(page)

    # Steps (timeline) -----------------------------------------------------------------------------------------

    def begin_step(self, kind: str, title: str, detail: str | None = None, url: str | None = None) -> dict[str, Any]:
        step = {"id": str(uuid.uuid4()), "index": len(self.steps) + 1, "kind": kind, "title": title, "detail": detail or None,
                "url": url, "status": "running", "started_at": now_iso(), "elapsed_ms": None, "error": None, "_t": time.perf_counter()}
        self.steps.append(step)
        if kind in BROWSER_KINDS:
            self.actions_used += 1
        self.current = {"title": title, "url": url or (self.page or {}).get("url"), "page_title": (self.page or {}).get("title")}
        self.emit("step.started", self.public_step(step))
        return step

    def end_step(self, step: dict[str, Any], status: str = "ok", error: str | None = None, url: str | None = None) -> None:
        step["status"], step["error"] = status, error
        step["elapsed_ms"] = round((time.perf_counter() - step["_t"]) * 1000)
        if url:
            step["url"] = url
        self.emit("step.finished", self.public_step(step))
        self.services.store.save_task(self.to_dict())

    @staticmethod
    def public_step(step: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in step.items() if not k.startswith("_")}

    @asynccontextmanager
    async def step(self, kind: str, title: str, detail: str | None = None, url: str | None = None):
        step = self.begin_step(kind, title, detail, url)
        try:
            yield step
        except asyncio.CancelledError:
            self.end_step(step, "skipped")
            raise
        except Exception as error:
            self.end_step(step, "error", str(error))
            raise
        else:
            self.end_step(step, "ok", url=(self.page or {}).get("url"))

    def hooks(self) -> Hooks:
        async def step_started(d: dict) -> dict:
            return self.begin_step(d["kind"], d["title"], d.get("detail"), d.get("url"))

        async def step_finished(step: dict, info: dict) -> None:
            self.end_step(step, info["status"], info.get("error"), info.get("url"))

        async def before_action(action: dict, page: dict, _decision: dict) -> None:
            kind = safety.classify_action(action, page)
            if kind and (kind in {"payment", "purchase"} or self.cfg("agent.confirm_sensitive")):
                question, detail = safety.describe_sensitive(kind, action, page)
                if not await self.confirm(kind, question, detail):
                    raise UserDenied(f'You declined "{action.get("label", "that action")}".')

        async def page_changed(page: dict) -> None:
            self.page = page
            self.emit("page.updated", {"url": page["url"], "title": page["title"]})

        async def challenge(page: dict) -> bool:
            return await self.handle_challenge(page)

        return Hooks(checkpoint=self.checkpoint, before_action=before_action, step_started=step_started,
                     step_finished=step_finished, page_changed=page_changed, challenge=challenge)

    def count_laya(self, result: GoalResult) -> None:
        self.laya_ms += result.laya_ms
        self.laya_calls += result.laya_calls

    # Model accounting -----------------------------------------------------------------------------------------

    async def llm_call(self, coro):
        await self.checkpoint()
        data, result = await coro
        self.llm_ms += result.latency_ms
        self.llm_calls += 1
        return data, result

    # Notes ------------------------------------------------------------------------------------------------------

    async def note_page(self, page: dict[str, Any]) -> None:
        self.emit("page.updated", {"url": page["url"], "title": page["title"]})
        self.current = {"title": (self.current or {}).get("title", ""), "url": page["url"], "page_title": page["title"]}

    async def add_note(self, **kwargs: Any) -> None:
        self.notes.append(Note(**kwargs))

    def add_card(self, card: dict[str, Any]) -> None:
        self.cards.append(card)

    # Main loop ----------------------------------------------------------------------------------------------------

    async def run(self) -> None:
        self._t0 = time.perf_counter()
        self.services.browser.metrics = type(self.services.browser.metrics)()
        self.set_status("running")
        final_state = "done"
        try:
            await self.prepare()
            plan = await self.first_plan()
            final_state = await self.execute(plan)
        except TaskCancelled:
            final_state = "cancelled"
            self.error = None
        except asyncio.CancelledError:
            if not self._cancelled:
                log.warning("task %s was cancelled from outside the user's cancel button", self.id[:8], exc_info=True)
            final_state = "cancelled"
            self.error = None
        except BudgetExceeded as error:
            self.error = str(error)
            final_state = "partial"
        except (LlmError, LayaUnavailable, BrowserNotConnected) as error:
            self.error = str(error)
            final_state = "failed"
        except Exception as error:  # a bug must still end the task cleanly
            log.exception("task crashed")
            self.error = f"Unexpected error: {error}"
            final_state = "failed"
        try:
            await asyncio.shield(self.finish(final_state))
        except asyncio.CancelledError:
            pass

    async def prepare(self) -> None:
        browser = self.services.browser
        if not browser.connected:
            async with self.step("tab", "Connecting to Chrome…"):
                await browser.ensure_connected()
        tab = browser.get_tab(self.ctx.tab_id)
        if tab is None or tab.closed:
            tab = await browser.new_tab("about:blank")
        self.tab = tab
        browser.active = tab
        self.ctx.tab_id = tab.id
        if tab.url and not tab.url.startswith(("about:", "chrome://")):
            self.page = await tab.observe()
        # Laya loads in the background while the plan is being made, so the first browser decision is instant.
        asyncio.create_task(self._warm_laya())

    async def _warm_laya(self) -> None:
        try:
            await self.services.laya.ensure_loaded()
        except LayaUnavailable:
            pass

    async def first_plan(self) -> Plan:
        fast = self.fast_path()
        if fast:
            return fast
        async with self.step("plan", "Planning…", detail=self.goal[:100]):
            plan, _ = await self.llm_call(planner.make_plan(self.services.llm, self.goal, self.context_text()))
        return plan

    def fast_path(self) -> Plan | None:
        """"Open github.com/x" needs no text model: the URL is the plan."""
        match = FAST_URL.match(self.goal)
        if not match:
            return None
        url = safety.normalize_url(match[1])
        if not url:
            return None
        host = (url.split("//", 1)[1].split("/")[0]).removeprefix("www.")
        return Plan(f"Open {url}.", [PlanStep("goto", {"url": url, "new_tab": False}, {"host": [host.split(":")[0]]})], "done")

    # Context for the model -----------------------------------------------------------------------------------------

    def context_text(self, *, replan: bool = False) -> str:
        browser = self.services.browser
        parts = [self.ctx.summary_text()]
        tabs = [t for t in browser.tabs.values() if not t.closed]
        if tabs:
            lines = [f'{i}. "{(t.title or t.url or "new tab")[:70]}" {t.url[:100]}' + (" (current)" if t is self.tab else "") for i, t in enumerate(tabs, 1)]
            parts.append("BROWSER STATE (tabs opened by Jarvis):\n" + "\n".join(lines) + "\n\n")
        else:
            parts.append("BROWSER STATE: no tabs are open yet.\n\n")
        if self.page and not self.page["url"].startswith(("about:", "chrome://")):
            body = safety.untrusted(self.page["text"][:1400], "page")
            parts.append(f'CURRENT PAGE: "{self.page["title"]}" {self.page["url"]}\n{body}\n\n')
        if self.tools.links:
            parts.append("LINKS FROM THE LATEST READ (untrusted text):\n" + safety.untrusted(self.tools.links_text(25), "links") + "\n\n")
        if replan or self.progress:
            lines = [f"{i}. {s.label()} → {o.text()[:700]}" for i, (s, o) in enumerate(self.progress[-10:], 1)]
            parts.append("PROGRESS SO FAR IN THIS TASK:\n" + "\n".join(lines) + "\n\n")
        if self.hint:
            parts.append("ATTENTION: " + self.hint + "\n\n")
        return "".join(parts)

    # Execution --------------------------------------------------------------------------------------------------------

    async def execute(self, plan: Plan) -> str:
        self.final_then = plan.then
        replans = failures = 0
        last_keys: list[str] = []
        while True:
            interrupted = False
            for step in plan.steps:
                await self.checkpoint()
                key = step.key()
                observation = await self.run_step(step)
                self.progress.append((step, observation))
                if not observation.ok:
                    if self.denied:
                        return "partial"  # the user said no: never re-plan around a declined action
                    failures += 1
                    interrupted = True
                    break
                failures = 0
                last_keys.append(key)
                if self.question:
                    return "done"
            if not interrupted and plan.then in {"done", "answer"}:
                unconfirmed = [w.split(": ", 1)[-1] for _s, o in self.progress[-len(plan.steps):] for w in o.warnings if w.startswith("could not confirm")]
                audit_ok, audit_text = (True, "") if unconfirmed else await self.audit()
                if not audit_ok and self.completion_replans < 2 and replans < MAX_REPLANS:
                    self.completion_replans += 1
                    self.hint = ("The independent check of the final page found problems.\n" + audit_text +
                                 "Fix them with different steps (do not repeat a step that already ran), or if the request cannot be met, stop.")
                elif unconfirmed and self.completion_replans < 2 and replans < MAX_REPLANS and not self.question:
                    # Independent check found values the page does not show: give the planner one chance to set them
                    # (typically a filter or sort control that only exists on the results page).
                    self.completion_replans += 1
                    self.hint = ("These requested values could NOT be confirmed on the current page: " + "; ".join(dict.fromkeys(unconfirmed))
                                 + ". If this page offers controls for them (filters, sort order, passengers, dates), set them with one "
                                 "interact step now; otherwise continue and report the results you have.")
                else:
                    if unconfirmed:  # the code checks above could not settle it: audit once, then report honestly
                        audit_ok, audit_text = await self.audit()
                    self.verification_text, self.audit_failed = audit_text, not audit_ok
                    return "done"
            elif not interrupted and plan.then == "replan" and not plan.steps:
                return "done"
            replans += 1
            if replans > MAX_REPLANS:
                self.error = "Stopped after too many replans without finishing."
                return "partial"
            if failures >= MAX_CONSECUTIVE_FAILURES:
                self.error = "The same kind of step kept failing."
                return "partial"
            async with self.step("plan", "Re-planning…" if interrupted else "Choosing next steps…"):
                new_plan, _ = await self.llm_call(planner.make_plan(self.services.llm, self.goal, self.context_text(replan=True), replan=True))
            self.hint = ""
            if self.repeats(new_plan, last_keys):
                # Nothing new left to try. With evidence in hand that means "enough": answer from it.
                if any(n.kind in {"page", "records", "images"} for n in self.notes) and not interrupted:
                    return "done"
                self.error = "The plan started repeating steps that already ran."
                return "partial"
            plan = new_plan
            self.final_then = plan.then

    @staticmethod
    def repeats(plan: Plan, done_keys: list[str]) -> bool:
        keys = [s.key() for s in plan.steps]
        return bool(keys) and all(k in done_keys[-6:] and not k.startswith('["wait"') for k in keys)

    async def run_step(self, step: PlanStep) -> Observation:
        handler = {
            "search": self.tools.search, "goto": self.tools.goto, "interact": self.tools.interact, "open_link": self.tools.open_link, "visit": self.tools.visit,
            "read": self.tools.read, "extract": self.tools.extract, "images": self.tools.images_tool, "tab": self.tools.tab_tool,
            "back": self.tools.back, "forward": self.tools.forward, "scroll": self.tools.scroll, "wait": self.tools.wait,
            "download": self.tools.download, "ask_user": self.tools.ask_user,
        }[step.tool]
        try:
            observation = await handler(step.args)
            if observation.ok:
                misses = self.tools.check_expect(step)
                if misses:
                    observation = Observation(False, f"The page is not what was expected: {'; '.join(misses)}. {observation.summary}")
            return observation
        except (TaskCancelled, asyncio.CancelledError, BudgetExceeded):
            raise
        except UserDenied as error:
            self.error = str(error)
            self.denied = True
            return Observation(False, str(error))
        except (NavigationError, StalePage, CDPError, LlmError, LayaUnavailable, BrowserNotConnected, ValueError, httpx.HTTPError) as error:
            return Observation(False, f"{type(error).__name__}: {error}")

    # Finishing ----------------------------------------------------------------------------------------------------------

    async def finish(self, state: str) -> None:
        had_progress = any(o.ok for _s, o in self.progress)
        unresolved = bool(self.progress) and not self.progress[-1][1].ok
        if state == "done" and unresolved:
            state = "partial" if had_progress else "failed"
        text, cards = "", list(self.cards)
        verification_text = self.verification_text
        if state == "done" and self.audit_failed:
            state = "partial"
            self.error = self.error or "The final page could not be confirmed as what you asked for."
        try:
            if state == "cancelled":
                text = "Task cancelled."
            elif self.question:
                text = self.question
            elif state == "failed" and not had_progress:
                text = f"I couldn't complete that: {self.error or self.last_failure() or 'nothing worked'}."
            else:
                needs_answer = self.progress and (self.progress[-1][0].tool in {"extract", "images", "read"} or any(n.kind in {"records", "images"} for n in self.notes)
                                                  or any(n.kind == "page" for n in self.notes) and self.wants_answer())
                if needs_answer and self.notes and state in {"done", "partial"}:
                    text = await self.compose_answer(state, verification_text)
                else:
                    text = self.summary_text(state)
        except (LlmError, TaskCancelled, asyncio.CancelledError) as error:
            text = self.summary_text(state) + (f"\n\n_The written summary could not be generated: {error}_" if isinstance(error, LlmError) else "")
        if state == "partial" and self.error and self.error not in text:
            text += f"\n\n> Partially completed: {self.error}"
        sources = self.source_items()
        if sources and state in {"done", "partial"} and not any(c["type"] == "sources" for c in cards) and len(self.notes) > 1:
            cards.append({"type": "sources", "items": sources})
        text = self.sanitize_links(text)
        self._elapsed_ms = round((time.perf_counter() - self._t0) * 1000)
        browser_metrics = self.services.browser.metrics.snapshot()
        self.result = {"markdown": text, "cards": cards, "sources": sources}
        message = {"id": self.assistant_message_id, "conversation_id": self.conversation_id, "role": "assistant", "text": text,
                   "cards": cards, "task_id": self.id, "created_at": now_iso()}
        self.timings = {
            "total_ms": self._elapsed_ms, "planning_ms": self.llm_ms, "laya_ms": self.laya_ms, "laya_calls": self.laya_calls,
            "llm_calls": self.llm_calls, **browser_metrics,
        }
        self.finished_at = now_iso()
        self.status = state
        self.waiting = None
        self.services.store.add_message(message)
        self.emit("assistant.message", message)
        self.emit("task.timings", self.timings)
        self.set_status(state)
        self.update_context(state, text)
        self.services.store.save_task(self.to_dict())

    def wants_answer(self) -> bool:
        return not all(s.tool in {"goto", "open_link", "search", "tab", "back", "forward", "scroll", "wait"} for s, _ in self.progress) or any(
            s.tool == "read" for s, _ in self.progress)

    def last_failure(self) -> str | None:
        for _s, obs in reversed(self.progress):
            if not obs.ok:
                return obs.summary[:300]
        return None

    def summary_text(self, state: str) -> str:
        """Deterministic reply for action tasks: what happened, the page reached, anything not confirmed."""
        page = self.page
        lines = []
        if page and not page["url"].startswith("about:"):
            lines.append(f"Done — **{page['title'] or page['url']}** is open: <{page['url']}>" if state == "done" else f"Stopped on **{page['title'] or page['url']}**: <{page['url']}>")
        else:
            lines.append("Done." if state == "done" else "I could not finish this.")
        warnings = [w for _s, o in self.progress for w in o.warnings][-4:]
        if warnings:
            lines.append("\n**Could not verify:**\n" + "\n".join(f"- {w}" for w in dict.fromkeys(warnings)))
        failure = self.last_failure() if state != "done" else None
        if failure:
            lines.append(f"\n> {failure}")
        return "\n".join(lines)

    def notes_text(self) -> str:
        budget = max(700, 11000 // max(1, len(self.notes)))
        blocks = []
        for n in self.notes[-14:]:
            if n.kind == "records":
                rows = "\n".join(" | ".join(str(r.get(c) or "-") for c in n.extra["columns"]) for r in n.extra["records"][:25])
                blocks.append(f"### {n.extra['what']} — [{n.title}]({n.url})\ncolumns: {' | '.join(n.extra['columns'])}\n{rows}")
            elif n.kind == "images":
                blocks.append(f"### Image results — [{n.title}]({n.url})\n{n.extra['count']} images, e.g.: " + "; ".join(n.extra["titles"]))
            elif n.kind == "download":
                blocks.append(f"### Downloaded file {n.title} → {n.extra.get('path')}")
            else:
                blocks.append(f"### [{n.title}]({n.url})\n{n.text[:budget]}")
        return "\n\n".join(blocks)

    def cards_text(self) -> str:
        lines = []
        for card in self.cards:
            if card["type"] == "table":
                lines.append(f"- table \"{card.get('title', '')}\" with {len(card['rows'])} rows (columns: {', '.join(card['columns'])})")
            elif card["type"] == "images":
                lines.append(f"- image grid with {len(card['items'])} images")
            elif card["type"] == "files":
                lines.append(f"- {len(card['items'])} downloaded file(s)")
        return ("CARDS shown to the user separately:\n" + "\n".join(lines) + "\n\n") if lines else ""

    def evidence_text(self) -> str:
        page = self.page or {}
        fields = []
        for a in page.get("actions", []):
            if a.get("kind") in {"fill", "select"} or a.get("role") in {"checkbox", "radio", "switch"} or a.get("checked") or a.get("selected"):
                label = a.get("label", "").split(" → ")[0]
                value = a.get("current_value", a.get("value", ""))
                fields.append(f"{label} = {value or a.get('checked', '')}")
            elif a.get("role") == "button" and a.get("expanded") is not None:
                fields.append(f"{a.get('label', '')} (button)")
        kind = ("navigation: the request is to reach a page; the final page itself is the result" if self.final_then == "done"
                else "information: the request wants data reported from pages")
        lines = [f"REQUEST TYPE: {kind}", f"FINAL PAGE: {page.get('title', '')} — {page.get('url', '')}",
                 "FORM STATE:\n" + "\n".join(dict.fromkeys(fields))[:1800]]
        lines.append("VISIBLE TEXT:\n" + page.get("text", "")[:2600])
        for n in self.notes:
            if n.kind == "records":
                rows = "\n".join(" | ".join(str(r.get(c) or "-") for c in n.extra["columns"]) for r in n.extra["records"][:6])
                lines.append(f"EXTRACTED {n.extra['what']} ({len(n.extra['records'])} rows):\n{rows}")
            elif n.kind == "images":
                lines.append(f"IMAGE RESULTS: {n.extra['count']} images")
        unconfirmed = [w for _s, o in self.progress for w in o.warnings]
        if unconfirmed:
            lines.append("NOT CONFIRMED BY CODE CHECKS: " + "; ".join(unconfirmed))
        return "\n\n".join(lines)

    def needs_audit(self) -> bool:
        used = {s.tool for s, o in self.progress if o.ok}
        if {"interact", "extract"} & used:
            if self.final_then != "done" and not any(o.warnings for _s, o in self.progress) and "interact" not in used:
                return False  # plain extraction with nothing unconfirmed: the grounded rows speak for themselves
            return True
        # Navigation without any expectation to check (no expected host/title): the page itself must be audited.
        navigated = [s for s, o in self.progress if o.ok and s.tool in {"goto", "open_link", "search"}]
        return bool(navigated) and self.final_then == "done" and not any(s.expect for s in navigated)

    async def audit(self) -> tuple[bool, str]:
        """Independent check of the final page against the request, from observed evidence only (never the model's own claim)."""
        if not self.needs_audit() or self.question:
            return True, ""
        async with self.step("verify", "Verifying the results…"):
            data, _ = await self.llm_call(planner.verify_constraints(self.services.llm, self.goal, self.evidence_text()))
        self.verification = data
        lines = []
        for c in data["checks"]:
            tag = {"verified": "VERIFIED", "unverified": "COULD NOT CONFIRM", "contradicted": "CONTRADICTED"}[c["status"]]
            lines.append(f"- {tag}: {c['requirement']}" + (f" ({c['evidence']})" if c["evidence"] else ""))
        navigation = self.final_then == "done"
        if not navigation and not data["results_present"]:
            lines.append("- NO RESULTS were visible or extracted for the request.")
        bad = [c for c in data["checks"] if c["status"] == "contradicted"]
        weak = [c for c in data["checks"] if c["status"] == "unverified"]
        passed = not bad and (navigation or data["results_present"]) and not (data["checks"] and len(weak) * 2 >= len(data["checks"]))
        return passed, "VERIFICATION of the final page against the request:\n" + "\n".join(lines) + "\n\n"

    async def compose_answer(self, state: str, verification_text: str = "") -> str:
        async with self.step("verify", "Writing the answer…"):
            pass
        parts: list[str] = []
        started = time.perf_counter()
        extra = ""
        if state == "partial" and self.error:
            extra = f"NOTE: the task was only partly completed: {self.error}\n\n"
        extra += self.cards_text() + verification_text
        async for chunk in planner.stream_answer(self.services.llm, self.goal, self.notes_text(), self.ctx.summary_text() + extra, max_tokens=500 if self.cards else 1200):
            parts.append(chunk)
            self.emit("assistant.delta", {"message_id": self.assistant_message_id, "text": chunk})
        self.llm_ms += round((time.perf_counter() - started) * 1000)
        self.llm_calls += 1
        text = "".join(parts).strip()
        if not text:
            raise LlmError("The text model returned an empty answer.")
        return text

    def evidence_urls(self) -> set[str]:
        urls = {n.url.rstrip("/") for n in self.notes if n.url}
        urls |= {link["href"].rstrip("/") for link in self.tools.links.values()}
        urls |= {i[k].rstrip("/") for i in self.tools.images for k in ("source_url", "image_url") if i.get(k)}
        if self.page:
            urls.add(self.page["url"].rstrip("/"))
        urls |= {u.rstrip("/") for u in self.user_urls}
        return urls

    def sanitize_links(self, markdown: str) -> str:
        """A model may not cite a URL the browser never saw: unknown links are shown as plain text."""
        evidence = self.evidence_urls()

        def fix(match: re.Match[str]) -> str:
            label, url = match[1], match[2].rstrip("/")
            return match[0] if url in evidence or any(url == e.split("#")[0] for e in evidence) else f"{label} (unverified link removed)"

        return re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", fix, markdown)

    def source_items(self) -> list[dict[str, str]]:
        seen, items = set(), []
        for n in self.notes:
            if n.kind in {"page", "records", "images"} and n.url and n.url not in seen:
                seen.add(n.url)
                items.append({"title": n.title or n.url, "url": n.url})
        return items[:10]

    def update_context(self, state: str, text: str) -> None:
        outcome = {"done": "completed", "partial": "partly completed", "failed": "failed", "cancelled": "cancelled"}[state]
        digest = re.sub(r"\s+", " ", text)[:300]
        self.ctx.summaries.append({"goal": self.goal, "outcome": f"{outcome}: {digest}", "url": (self.page or {}).get("url"),
                                   "title": (self.page or {}).get("title", "")})
        self.ctx.summaries = self.ctx.summaries[-6:]
        self.ctx.links, self.ctx.images = self.tools.links, self.tools.images
        self.ctx.last_task_id = self.id


__all__ = ["ConversationContext", "Services", "TaskCancelled", "TaskRun", "date"]
