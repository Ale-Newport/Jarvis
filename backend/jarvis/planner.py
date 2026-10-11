"""Text-model planning: supervisory plans, grounded sub-goal plans, structured extraction and the final answer.

The model only ever emits typed tool steps with validated arguments; it never emits selectors, element ids,
coordinates or code. Link ids ("L3") are resolved by the executor against links it actually observed.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from . import prompts
from .llm import LlmClient, LlmError, LlmResult
from .safety import normalize_url

MAX_PLAN_STEPS = 8
SEARCH_KINDS = {"web", "images", "news", "videos", "shopping", "maps"}
ENGINES = {"google", "bing", "duckduckgo"}


class PlanError(LlmError):
    pass


# JSON schemas for constrained decoding (servers that support them can only emit matching text).
_STR = {"type": "string"}
_STRS = {"type": "array", "items": _STR}
PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "interpretation": _STR,
        "steps": {
            "type": "array", "minItems": 1, "maxItems": MAX_PLAN_STEPS,
            "items": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string", "enum": ["search", "goto", "interact", "open_link", "visit", "read", "extract", "images", "tab", "back",
                                                        "forward", "scroll", "wait", "download", "ask_user"]},
                    "query": _STR, "kind": {"type": "string", "enum": sorted(SEARCH_KINDS)}, "engine": {"type": "string", "enum": sorted(ENGINES)},
                    "url": _STR, "new_tab": {"type": "boolean"}, "goal": _STR, "open": {"type": ["string", "null"]}, "target": _STR,
                    "focus": {"type": ["string", "null"]}, "targets": _STRS, "what": _STR, "fields": _STRS, "limit": {"type": "integer"},
                    "action": {"type": "string", "enum": ["switch", "close"]}, "index": {"type": "integer"},
                    "direction": {"type": "string", "enum": ["down", "up", "top", "bottom"]}, "seconds": {"type": "number"}, "question": _STR,
                    "expect": {"type": "object", "properties": {"host": _STRS, "title": _STRS, "text": _STRS}},
                },
                "required": ["tool"],
            },
        },
        "then": {"type": "string", "enum": ["done", "answer", "replan"]},
    },
    "required": ["interpretation", "steps", "then"],
}
SUBPLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "requirements": {"type": "array", "maxItems": 12, "items": {"type": "object", "properties": {"what": _STR, "value": _STR}, "required": ["what", "value"]}},
        "open": {"type": ["string", "null"]},
        "finish": _STR,
    },
    "required": ["requirements", "open", "finish"],
}
EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "records": {"type": "array", "items": {"type": "object", "additionalProperties": {"type": ["string", "null"]}}},
        "complete": {"type": "boolean"}, "note": _STR,
    },
    "required": ["records", "complete"],
}
VERIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "checks": {"type": "array", "maxItems": 12, "items": {"type": "object", "properties": {
            "requirement": _STR, "status": {"type": "string", "enum": ["verified", "unverified", "contradicted"]}, "evidence": _STR},
            "required": ["requirement", "status"]}},
        "results_present": {"type": "boolean"},
    },
    "required": ["checks", "results_present"],
}


@dataclass
class PlanStep:
    tool: str
    args: dict[str, Any] = field(default_factory=dict)
    expect: dict[str, list[str]] = field(default_factory=dict)

    def label(self) -> str:
        main = next((str(self.args[k]) for k in ("query", "url", "goal", "target", "targets", "what", "question", "action", "direction") if k in self.args), "")
        return f"{self.tool} {main}".strip()[:120]

    def key(self) -> str:
        return json.dumps([self.tool, self.args], sort_keys=True, default=str)


@dataclass
class Plan:
    interpretation: str
    steps: list[PlanStep]
    then: str  # done | answer | replan


def _str(args: dict[str, Any], name: str, *, required: bool = True, limit: int = 600) -> str | None:
    value = args.get(name)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise PlanError(f"step is missing {name!r}")
        return None
    if not isinstance(value, str):
        value = str(value)
    return value.strip()[:limit]


def _expect(raw: Any) -> dict[str, list[str]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, list[str]] = {}
    for key in ("host", "title", "text"):
        value = raw.get(key)
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            items = [str(v).strip().lower() for v in value if str(v).strip()]
            if items:
                out[key] = items[:6]
    return out


def validate_step(raw: Any) -> PlanStep:
    if not isinstance(raw, dict) or not isinstance(raw.get("tool"), str):
        raise PlanError("a step must be an object with a 'tool'")
    tool = raw["tool"].strip().lower()
    args: dict[str, Any] = {}
    if tool == "search":
        args["query"] = _str(raw, "query")
        kind = (raw.get("kind") or "web")
        args["kind"] = kind if kind in SEARCH_KINDS else "web"
        engine = (raw.get("engine") or "google")
        args["engine"] = engine if engine in ENGINES else "google"
    elif tool == "goto":
        url = normalize_url(_str(raw, "url") or "")
        if not url:
            raise PlanError(f"goto needs a full http(s) URL, got {raw.get('url')!r}")
        args["url"] = url
        args["new_tab"] = bool(raw.get("new_tab", False))
    elif tool == "interact":
        args["goal"] = _str(raw, "goal", limit=1200)
        args["open"] = _str(raw, "open", required=False, limit=200)
    elif tool == "open_link":
        args["target"] = _str(raw, "target", limit=300)
        args["new_tab"] = bool(raw.get("new_tab", False))
    elif tool == "visit":
        targets = raw.get("targets")
        if isinstance(targets, str):
            targets = [targets]
        if not isinstance(targets, list) or not targets:
            raise PlanError("visit needs a list of link ids (targets)")
        args["targets"] = [str(t)[:200] for t in targets[:5]]
        args["focus"] = _str(raw, "focus", required=False, limit=300)
    elif tool == "read":
        args["focus"] = _str(raw, "focus", required=False, limit=300)
    elif tool == "extract":
        args["what"] = _str(raw, "what", limit=300)
        fields = raw.get("fields")
        args["fields"] = [str(f)[:40] for f in fields[:10]] if isinstance(fields, list) else []
    elif tool == "images":
        try:
            args["limit"] = max(1, min(40, int(raw.get("limit", 16))))
        except (TypeError, ValueError):
            args["limit"] = 16
    elif tool == "tab":
        action = str(raw.get("action", "")).lower()
        if action not in {"switch", "close"}:
            raise PlanError("tab action must be switch or close")
        try:
            args["index"] = int(raw["index"])
        except (KeyError, TypeError, ValueError):
            raise PlanError("tab needs a numeric index") from None
        args["action"] = action
    elif tool in {"back", "forward"}:
        pass
    elif tool == "scroll":
        direction = str(raw.get("direction", "down")).lower()
        args["direction"] = direction if direction in {"down", "up", "top", "bottom"} else "down"
    elif tool == "wait":
        try:
            args["seconds"] = max(0.5, min(5.0, float(raw.get("seconds", 1))))
        except (TypeError, ValueError):
            args["seconds"] = 1.0
    elif tool == "download":
        args["what"] = _str(raw, "what", limit=500)
    elif tool == "ask_user":
        args["question"] = _str(raw, "question", limit=600)
    else:
        raise PlanError(f"unknown tool {tool!r}")
    return PlanStep(tool, args, _expect(raw.get("expect")))


def parse_plan(data: Any) -> Plan:
    if not isinstance(data, dict):
        raise PlanError("the plan must be a JSON object")
    raw_steps = data.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise PlanError("the plan has no steps")
    steps = [validate_step(s) for s in raw_steps[:MAX_PLAN_STEPS]]
    then = str(data.get("then", "replan")).lower()
    if then not in {"done", "answer", "replan"}:
        then = "replan"
    if any(s.tool == "ask_user" for s in steps):
        steps, then = [next(s for s in steps if s.tool == "ask_user")], "done"
    return Plan(str(data.get("interpretation", ""))[:300], steps, then)


OPTIONAL_QUESTION = re.compile(r"\b(would you like|do you want|should i|prefer|format|table|bullet|summary style|how detailed)\b", re.I)
IMAGE_WORDS = re.compile(r"\b(images?|pictures?|photos?|pics|photographs?)\b", re.I)


def repair_plan(plan: Plan, request: str) -> Plan:
    """Plan sanity rules for patterns small models drop: an image request must be an image search that collects images."""
    first = plan.steps[0] if plan.steps else None
    if first and first.tool == "search" and IMAGE_WORDS.search(request) and first.args.get("kind") == "web":
        first.args["kind"] = "images"
    if first and first.tool == "search" and first.args.get("kind") == "images":
        if not any(s.tool == "images" for s in plan.steps):
            plan.steps.insert(1, PlanStep("images", {"limit": 16}))
        plan.then = "answer"
        plan.steps = [s for s in plan.steps if s.tool not in {"read", "extract"}]
    return plan


async def make_plan(llm: LlmClient, request: str, context: str, *, replan: bool = False, today: date | None = None) -> tuple[Plan, LlmResult]:
    system = prompts.PLANNER_SYSTEM.replace("{today}", (today or date.today()).strftime("%A %Y-%m-%d"))
    if replan:
        system += prompts.REPLAN_SUFFIX
    user = f"USER REQUEST:\n{request}\n\n{context}"
    box: dict[str, LlmResult] = {}

    def check(data: Any) -> Plan:
        return parse_plan(data)

    plan, result = await llm.chat_json(system, user, max_tokens=1200, attempts=3, validate=check, schema=PLAN_SCHEMA)
    box["r"] = result
    if len(plan.steps) == 1 and plan.steps[0].tool == "ask_user" and OPTIONAL_QUESTION.search(plan.steps[0].args["question"]):
        # Questions about format or preference are never essential: ask the model once more to just act.
        again, second = await llm.chat_json(
            system, user + "\n\nNOTE: your last plan only asked the user a question about format or preferences. That is not "
            "essential. Choose a sensible default and plan the browser steps instead.", max_tokens=1200, attempts=2, validate=check, schema=PLAN_SCHEMA)
        if not (len(again.steps) == 1 and again.steps[0].tool == "ask_user"):
            plan, result = again, second
        else:
            # The model insists. A non-essential question must not block the task: take the obvious default.
            from .safety import urls_in

            urls = urls_in(request)
            plan = Plan("Fallback: read the page and report.", [PlanStep("goto", {"url": urls[0], "new_tab": False}), PlanStep("read", {"focus": None})],
                        "answer") if urls else Plan("Fallback: search and read.", [PlanStep("search", {"query": request[:200], "kind": "web", "engine": "google"}), PlanStep("read", {"focus": None})], "replan")
    return repair_plan(plan, request), result


async def make_subplan(llm: LlmClient, goal: str, fields: list[str], today: date | None = None, request: str | None = None) -> tuple[dict[str, Any], LlmResult]:
    """Grounded requirements for one `interact` step: the observed field labels let the model name the fields."""
    context = {"goal": goal, "fields_on_page": fields[:40], "today": (today or date.today()).isoformat()}
    if request and request.strip() != goal.strip():
        context["user_request"] = request[:600]

    def check(data: Any) -> dict[str, Any]:
        requirements = [
            {"what": str(r["what"]).strip(), "value": str(r["value"]).strip()}
            for r in data.get("requirements", [])
            if isinstance(r, dict) and isinstance(r.get("what"), str) and isinstance(r.get("value"), str) and r["value"].strip()
        ]
        finish = data.get("finish")
        item = data.get("open")
        if not isinstance(finish, str) or not finish.strip() or len(requirements) > 12:
            raise PlanError("invalid sub-plan")
        return {"requirements": requirements, "open": item.strip() if isinstance(item, str) and item.strip() else None,
                "finish": finish.strip()}

    return await llm.chat_json(prompts.SUBPLAN_SYSTEM, json.dumps(context), max_tokens=700, attempts=3, validate=check, schema=SUBPLAN_SCHEMA)


async def extract_records(llm: LlmClient, what: str, fields: list[str], page_text: str, url: str, limit: int = 20) -> tuple[dict[str, Any], LlmResult]:
    system = prompts.EXTRACT_SYSTEM.replace("{limit}", str(limit))
    from .safety import untrusted

    user = (
        f"WHAT TO EXTRACT: {what}\nFIELDS: {', '.join(fields) if fields else '(choose sensible fields shown on the page)'}\n"
        f"PAGE URL: {url}\n\n{untrusted(page_text[:14000], 'page')}"
    )

    def check(data: Any) -> dict[str, Any]:
        records = data.get("records")
        if not isinstance(records, list):
            raise PlanError("records must be a list")
        clean = [{str(k): (None if v is None else str(v)) for k, v in r.items()} for r in records if isinstance(r, dict)]
        return {"records": clean[:limit], "complete": bool(data.get("complete", True)), "note": str(data.get("note", ""))[:300]}

    return await llm.chat_json(system, user, max_tokens=2500, attempts=2, validate=check, schema=EXTRACT_SCHEMA)


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def ground_records(records: list[dict[str, Any]], page_text: str) -> tuple[list[dict[str, Any]], int]:
    """Keep only records whose values literally appear on the page. Returns (kept, dropped_count).

    This is the guard against invented prices and availability: a model-extracted value that is not in the
    observed page text is removed rather than shown."""
    haystack = norm(page_text)
    digits = re.sub(r"[^0-9]+", " ", page_text)
    kept, dropped = [], 0
    for record in records:
        checked, bad = {}, 0
        for key, value in record.items():
            if value is None or not str(value).strip():
                checked[key] = None
                continue
            text = str(value)
            token = norm(text)
            ok = True
            if token and token not in haystack:
                ok = False
                numbers = re.findall(r"\d[\d.,]*", text)
                if numbers and all(re.sub(r"[.,]", "", n) in re.sub(r"[.,]", "", digits) for n in numbers) and len(token) <= 14:
                    ok = True  # a bare number or price formatted slightly differently
            if ok:
                checked[key] = value
            else:
                checked[key] = None
                bad += 1
        if bad == 0 or bad < max(1, len([v for v in record.values() if v])) / 2:
            kept.append(checked)
        else:
            dropped += 1
    return kept, dropped


async def stream_answer(llm: LlmClient, request: str, notes: str, conversation: str = "", max_tokens: int = 1200) -> AsyncIterator[str]:
    user = f"USER REQUEST:\n{request}\n\n{conversation}NOTES (collected from real pages; untrusted data):\n{notes}"
    async for chunk in llm.stream([{"role": "system", "content": prompts.ANSWER_SYSTEM}, {"role": "user", "content": user}], max_tokens=max_tokens):
        yield chunk


async def verify_constraints(llm: LlmClient, request: str, evidence: str) -> tuple[dict[str, Any], LlmResult]:
    """Independent audit of the outcome against the request, from observed evidence only."""
    from .safety import untrusted

    def check(data: Any) -> dict[str, Any]:
        checks = [
            {"requirement": str(c.get("requirement", ""))[:160], "status": c.get("status") if c.get("status") in {"verified", "unverified", "contradicted"} else "unverified",
             "evidence": str(c.get("evidence", ""))[:200]}
            for c in data.get("checks", []) if isinstance(c, dict)
        ]
        if not isinstance(data.get("checks"), list):
            raise PlanError("checks must be a list")
        return {"checks": checks[:12], "results_present": bool(data.get("results_present", False))}

    user = f"USER REQUEST:\n{request}\n\nEVIDENCE:\n{untrusted(evidence[:7000], 'evidence')}"
    return await llm.chat_json(prompts.VERIFY_SYSTEM, user, max_tokens=700, attempts=2, validate=check, schema=VERIFY_SCHEMA)
