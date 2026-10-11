"""Run one sub-goal on a tab: observe → Laya decision → validated Chrome action → verify, until done or bounded out.

This is the agent loop of jev-ultrafast / laya-ultrafast (Agent.command: predict, act) made asynchronous. The
invariants are preserved: every target is an observed element, a decision is consumed once, a browser mutation
is never retried, and a stale page triggers a fresh observation and a new decision instead.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .browser import ActionFailed, BrowserSession, StalePage, Tab
from .laya_engine import LayaEngine
from .policy import LayaPolicy

log = logging.getLogger("jarvis.goal")

MAX_STALE_IN_A_ROW = 5
MAX_UNCHANGED = 3
MAX_WAITS_IN_A_ROW = 30  # ~3 s of polling; the policy itself waits at most ~12 times for results


@dataclass
class SubGoal:
    goal: str
    requirements: list[dict[str, str]] = field(default_factory=list)
    open: str | None = None
    finish: str = "The requested page is visible."

    @property
    def plan(self) -> dict[str, Any]:
        return {"requirements": [dict(r) for r in self.requirements], "open": self.open, "finish": self.finish}


@dataclass
class GoalResult:
    status: str  # done | blocked | budget | stale
    reason: str
    page: dict[str, Any]
    tab: Tab
    history: list[dict[str, Any]]
    laya_ms: int = 0
    laya_calls: int = 0
    elapsed_ms: int = 0


@dataclass
class Hooks:
    """Callbacks into the task runner (all optional)."""

    checkpoint: Callable[[], Awaitable[None]] | None = None  # pause / cancel / time budget
    before_action: Callable[[dict, dict, dict], Awaitable[None]] | None = None  # safety confirmation
    step_started: Callable[[dict], Awaitable[Any]] | None = None
    step_finished: Callable[[Any, dict], Awaitable[None]] | None = None
    page_changed: Callable[[dict], Awaitable[None]] | None = None
    challenge: Callable[[dict], Awaitable[bool]] | None = None  # True = user resolved it


KIND_FOR = {"fill": "type", "select": "select", "click": "click", "key": "key", "scroll": "scroll", "wait": "wait"}


def describe_step(decision: dict, action: dict, text: str | None) -> tuple[str, str]:
    """Human-readable title and detail for the timeline."""
    label = (action.get("label") or "").split(" → ")[0].strip() or action.get("role", "element")
    kind = action["kind"]
    if kind == "fill":
        return f"Typing into {label}…", text or ""
    if kind == "select":
        return f"Selecting in {label}…", action.get("label", "").split(" → ")[-1]
    if kind == "key":
        return ("Closing the menu…" if action.get("key") == "Escape" else "Submitting with Enter…"), ""
    if kind == "wait":
        return "Waiting for the page…", ""
    if kind == "scroll":
        return "Scrolling…", ""
    verb = {"pick": "Choosing", "open": "Opening", "submit": "Submitting", "item": "Opening", "toggle": "Setting"}.get(decision.get("kind", ""), "Clicking")
    return f"{verb} {label[:60]}…", ""


async def run_subgoal(
    session: BrowserSession,
    tab: Tab,
    engine: LayaEngine,
    subgoal: SubGoal,
    *,
    max_actions: int = 40,
    hooks: Hooks | None = None,
    screenshots: bool = False,
    page: dict[str, Any] | None = None,
) -> GoalResult:
    hooks = hooks or Hooks()
    started = time.perf_counter()
    policy = LayaPolicy(subgoal.goal, subgoal.plan, engine)
    history: list[dict[str, Any]] = []
    laya_ms = laya_calls = stale = waits = 0
    page = page or await tab.observe(screenshot=screenshots)

    def result(status: str, reason: str) -> GoalResult:
        return GoalResult(status, reason, page, tab, history, laya_ms, laya_calls, round((time.perf_counter() - started) * 1000))

    while True:
        if hooks.checkpoint:
            await hooks.checkpoint()
        if hooks.challenge:
            from .safety import detect_challenge

            found = detect_challenge(page)
            if found and not await hooks.challenge(page):
                return result("blocked", found[1])
            if found:
                page = await tab.observe()
        if len(history) >= max_actions:
            return result("budget", f"Stopped after {max_actions} browser actions without finishing.")

        decide_started = time.perf_counter()
        decision = await engine.run(policy.choose, page, history)
        session.metrics.add("decide", decide_started)
        laya_ms += decision["latency_ms"]
        laya_calls += decision.get("laya_calls", 0)
        choice = decision["choice"]

        if choice in {"DONE", "BLOCKED"}:
            if not await tab.fresh(page):
                page = await tab.observe()  # the page moved on since the decision; decide again
                continue
            return result("done" if choice == "DONE" else "blocked",
                          "The finish condition is visible." if choice == "DONE" else "No supported operation can make progress.")

        action = next((a for a in page["actions"] if a["id"] == choice), None)
        if action is None:
            keys = {"key_enter": "Enter", "key_escape": "Escape"}
            action = {"id": choice, "kind": "key", "key": keys[choice], "label": f"Press {keys[choice]}"} if choice in keys else None
        if action is None:
            return result("blocked", f"Laya chose {choice!r}, which is not an observed element.")

        if log.isEnabledFor(logging.DEBUG):
            from .policy import observed

            log.debug("state: %s", policy.debug_state(observed(page)))
        waits = waits + 1 if action["kind"] == "wait" else 0
        if waits == 8 and log.isEnabledFor(logging.DEBUG):
            log.debug("still waiting on %r: %d actions, text=%r", page["title"], len(page["actions"]), page["text"][:300])
            log.debug("  actions: %s", [(a["id"], a.get("role"), a.get("label", "")[:40]) for a in page["actions"][:30]])
        if waits >= MAX_WAITS_IN_A_ROW:
            return result("blocked", f"The page stopped offering controls ({len(page['actions']) - 1} usable elements) while waiting.")
        text = decision.get("text")
        log.debug("decision op=%s kind=%s %r text=%r laya=%dms/%d calls conf=%.2f", decision["operation"],
                  action["kind"], action.get("label"), text, decision["latency_ms"], decision.get("laya_calls", 0),
                  decision["confidence"])
        if log.isEnabledFor(logging.DEBUG):
            for qid, q in decision["request"]["questions"].items():
                log.debug("  q %s: %s -> %s %s", qid, q["instructions"], decision["raw_answers"].get(qid, {}).get("choice"),
                          {k: v[:40] for k, v in q["criteria"].items()} if isinstance(q["criteria"], dict) else q["criteria"])
        if action["kind"] == "fill" and not text:
            return result("blocked", "A field needs a value that the goal does not state.")

        if hooks.before_action:
            await hooks.before_action(action, page, decision)  # may raise TaskCancelled / Denied

        title, detail = describe_step(decision, action, text)
        step = await hooks.step_started({"kind": KIND_FOR.get(action["kind"], "click"), "title": title, "detail": detail,
                                          "url": page["url"]}) if hooks.step_started else None
        error: str | None = None
        act_started = time.perf_counter()
        try:
            if action["kind"] == "key":
                await tab.press(action["key"])
            else:
                await tab.act(action, page, text=text)
            stale = 0
        except StalePage as e:
            error = str(e)
            stale += 1
        except ActionFailed as e:
            error = str(e)
            stale += 1

        session.metrics.add("act", act_started)
        if error is not None:
            if hooks.step_finished and step is not None:
                await hooks.step_finished(step, {"status": "error", "error": error})
            if stale >= MAX_STALE_IN_A_ROW:
                return result("stale", f"The page kept changing under the agent ({error}).")
            page = await tab.observe(screenshot=screenshots)
            continue

        executed_at = round((time.perf_counter() - started) * 1000)
        # Record execution before observing, so a stale post-action observation cannot erase the action.
        history.append({
            "step": len(history) + 1, "action": action["label"], "kind": action["kind"], "choice": choice,
            "probability": decision["probabilities"].get(choice, 1.0), "confidence": decision["confidence"],
            "latency_ms": decision["latency_ms"], "text": text, "operation": decision["operation"],
            "target": decision["target"], "page_changed": None, "url": page["url"], "executed_ms": executed_at,
        })

        # An action may open a popup tab: follow it, like a person would.
        popups = session.take_popups()
        if popups:
            tab = popups[-1]
            session.active = tab
            await tab.wait_loaded(timeout=10)

        previous = page
        page = await tab.observe(screenshot=screenshots)
        from .safety import looks_like_checkout

        if looks_like_checkout(page["url"]) and not looks_like_checkout(previous["url"]):
            # Never continue on a booking/payment page by accident: go back and report it.
            history[-1].update(page_changed=True, url=page["url"])
            if step is not None and hooks.step_finished:
                await hooks.step_finished(step, {"status": "error", "error": "That click opened a booking page."})
            await tab.history(-1)
            page = await tab.observe(screenshot=screenshots)
            return result("blocked", "A click led to a booking or payment page, so I went back without continuing.")
        history[-1].update(page_changed=page["fingerprint"] != previous["fingerprint"], url=page["url"])
        if step is not None and hooks.step_finished:
            await hooks.step_finished(step, {"status": "ok", "url": page["url"]})
        if page["url"] != previous["url"] and hooks.page_changed:
            await hooks.page_changed(page)

        recent = history[-MAX_UNCHANGED:]
        if len(recent) == MAX_UNCHANGED and all(h["page_changed"] is False and h["kind"] != "wait" for h in recent):
            return result("blocked", "Three actions in a row changed nothing on the page.")
