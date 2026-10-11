"""Local decisions with Laya: open weights on Apple Silicon (MLX), no decision API.

Derived from laya-ultrafast's laya.py (MIT, Copyright (c) 2026 Browser Use), itself a port of jev-ultrafast.
Changes for Jarvis: the sub-goal plan is supplied by the supervisor planner instead of a per-task text-model
call, inference goes through the shared LayaEngine, there is a keyboard fallback for fields without a submit
button, and every decision reports its Laya call count and time.

A 421M typed-decision encoder answers narrow questions well: which field sets X, does this value
satisfy Y, which suggestion matches Z. It does not reliably answer "what should a browser do next?".
So each step asks narrow questions and composes them with rules that hold on any site:
fill the values the goal states, pick what a typed query or an opened control offers,
submit, then check the goal's finish condition. Every target is an observed element.
"""

import math
import re
import time
import unicodedata
from urllib.parse import urlparse

FIELD_ROLES = {"combobox", "textbox", "searchbox", "spinbutton", "checkbox", "radio", "switch"}
TOGGLES = {"checkbox", "radio", "switch"}
OPTION_ROLES = {"option", "menuitem", "menuitemradio", "radio", "tab"}
NEGATIVE = {"no", "off", "false", "unchecked", "disabled", "without", "none"}
SUBMIT_WORDS = {"search", "submit", "find", "go", "apply", "done", "continue", "next", "confirm", "show"}
STOP_WORDS = {"the", "and", "for", "with", "from", "find", "open", "stop", "when", "visib", "page", "are", "this", "only"}
MONTH_DAY = re.compile(
    r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ober|ember)?"
    r"\s+(\d{1,2})\b|\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)"
)
YES_NO = {"yes": "the current value satisfies the requirement", "no": "the current value does not satisfy it"}
# Contrasting page kinds separated finished from unfinished pages far better than a yes/no question.
UNFINISHED = {
    "form": "a search form that still has to be submitted",
    "results": "a list of search results, without the requested item opened",
    "other": "some other page",
}

MAX_RESULT_WAITS = 12  # about 2 s of observation while submitted results load

def validate_choice(answer, ids):
    """A Laya choice must name one offered option and carry a proper probability distribution."""
    try:
        probabilities = answer["probabilities"]
        numbers = [*probabilities.values(), answer["confidence"]]
        valid = (
            answer["choice"] in ids
            and set(probabilities) == set(ids)
            and all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in numbers)
            and abs(sum(probabilities.values()) - 1) < 0.02
            and probabilities[answer["choice"]] >= max(probabilities.values()) - 1e-6
        )
    except (KeyError, TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError("Invalid Laya response; no action executed.")
    return answer


def fold(text):
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def words(text):
    return {w[:5] for w in fold(text).split() if (len(w) > 2 or w.isdigit()) and w[:5] not in STOP_WORDS}


def month_day(text):
    m = MONTH_DAY.search(fold(text))
    return (m[1] or m[4], int(m[2] or m[3])) if m else None


def observed(page):
    """One entry per DOM node, indexed in the same order as model.action_space (the inspector's indices)."""
    elements, nodes = [], {}
    for action in page["actions"]:
        if action["kind"] not in {"click", "fill", "select"}:
            continue
        e = nodes.get(action["node"])
        if e is None:
            e = nodes[action["node"]] = {
                "node": action["node"],
                "index": str(len(elements) + 1),
                "role": action.get("role", ""),
                "label": action["label"].split(" → ")[0].strip(),
                "value": action.get("current_value", action.get("value", "")) or "",
                "checked": action.get("checked"),
                "expanded": action.get("expanded"),
                "haspopup": action.get("haspopup"),
                "chrome": bool(action.get("chrome")),
                "hint": action.get("hint", ""),
                "actions": {},
                "options": [],
            }
            elements.append(e)
        if action["kind"] == "select":
            e["options"].append(action)
        else:
            e["actions"].setdefault(action["kind"], action)
    for e in elements:
        if e["role"] in TOGGLES:
            e["current"] = "checked" if e["checked"] in {"true", True} else "unchecked"
        elif e["value"] or (is_field(e) and e["role"] != "button"):
            e["current"] = e["value"]
        else:
            e["current"] = e["label"]
    return elements


def is_field(e):
    # Buttons that display a count ("1 passenger") act as fields; dated buttons are calendar choices.
    counter = e["role"] == "button" and re.search(r"\d", e["label"]) and not month_day(e["label"])
    # Menu buttons (aria-expanded) are the controls behind filters and sort orders ("Stops", "Sort by").
    menu = e["role"] == "button" and (e.get("expanded") is not None or bool(e.get("haspopup"))) and len(e["label"]) <= 60
    return e["role"] in FIELD_ROLES or bool(e["options"]) or bool(counter) or menu


def display(e):
    """The name the planner sees and may copy as a requirement's "what"."""
    return f"{e['label'][:80]} ({e['hint'][:60]})" if e.get("hint") else e["label"][:80]


def plannable(e):
    """Elements a requirement can name: fields, and buttons, which often open pickers for dates or counts."""
    return is_field(e) or e["role"] == "button"


def describe(e):
    text = f"{e['role']} {e['label'][:70]}"
    if e.get("hint"):
        text += f" ({e['hint'][:50]})"
    if is_field(e) and e["current"] != e["label"]:
        text += f" = {e['current'][:40] or '(empty)'}"
    if e["options"]:
        text += " (options: " + ", ".join(option_label(o) for o in e["options"][:6]) + ")"
    return text


def option_label(option):
    return option["label"].split(" → ")[-1]


def settled(requirement, e):
    """True or False when plain code can tell; None asks Laya."""
    value = requirement["value"]
    if e["role"] in TOGGLES:
        return (e["current"] == "checked") != bool(set(fold(value).split()) & NEGATIVE)
    current = e["current"]
    if not fold(current):
        return False
    if any(fold(option_label(o)) == fold(value) for o in e["options"]):
        return False  # The requested value is still offered as an unselected option.
    wanted, shown = month_day(value), month_day(current)
    if wanted and shown:
        return wanted == shown
    # A single count against a single count ("1 adult" vs "1 passenger", "2 adults" vs "1 passenger") is plain arithmetic.
    wanted_numbers, shown_numbers = re.findall(r"\b\d+\b", value), re.findall(r"\b\d+\b", current)
    if len(wanted_numbers) == 1 and len(shown_numbers) == 1 and not wanted and not shown and len(fold(value).split()) <= 3:
        return int(wanted_numbers[0]) == int(shown_numbers[0])
    fv, fc = fold(value), fold(current)
    if fv and (fv in fc or (len(fc) >= 3 and fc in fv)):
        return True
    if (e.get("haspopup") or e.get("expanded") is not None) and "fill" not in e.get("actions", {}):
        # A menu button's name carries its current choice ("Sorted by top flights", "Nonstop, Stops, Selected"), so
        # plain word overlap decides, and the model's unreliable yes/no is not needed.
        wanted_words = words(value)
        return bool(wanted_words) and len(wanted_words & words(current)) / len(wanted_words) >= 0.5
    return None


def summary(text, about, limit=200):
    """The page lines sharing the most words with `about`, in page order. Page chrome comes first on most
    sites, so the opening characters rarely describe the page."""
    lines = [line for line in text.splitlines() if line.strip()]
    target = words(about)
    ranked = sorted(range(len(lines)), key=lambda i: -len(words(lines[i]) & target))
    kept, size = set(), 0
    for i in ranked:
        if size >= limit:
            break
        kept.add(i)
        size += len(lines[i])
    return " | ".join(lines[i] for i in sorted(kept))[: limit * 2]


def location(url):
    """Sites often rewrite the query on every edit; a new host or path means a new page."""
    parsed = urlparse(url)
    return parsed.netloc, parsed.path


def titled(title, name):
    """The page title carries most of the name's words, and they make up most of the title. A search results
    page ("X - Search results - Site") names the item too, but is not its page."""
    wanted, shown = words(name), words(title)
    shared = len(wanted & shown)
    return bool(wanted) and shared >= max(1, round(0.6 * len(wanted))) and shared >= 0.6 * len(shown)


def relevance(e, text):
    s = len(words(f"{e['label']} {e.get('hint', '')} {e['current']}") & words(text))
    date = month_day(text)
    return s + 5 if date and month_day(e["label"]) == date else s


DATE_WORD = re.compile(r"\b(date|dates|dd/mm|mm/dd|yyyy)\b", re.I)


def is_date_field(e):
    """A field that asks for a calendar date says so in its name, hint or placeholder ("Enter a date or ...")."""
    return bool(DATE_WORD.search(f"{e['label']} {e.get('hint', '')}"))


def compatible(requirement, e):
    """Keep obviously wrong pairings out of the assignment: a non-date value never belongs in a date field."""
    value = requirement["value"]
    if e["role"] in TOGGLES or e["options"]:
        return True
    dated = bool(month_day(value)) or bool(re.search(r"\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b", value))
    return dated or not is_date_field(e)


def plausible(requirement, e):
    """May this element hold this requirement? Typing into a compatible text field is low risk; a click-only
    control (menu, toggle, dropdown) must share a word or a number with the requirement, or offer its value."""
    if "fill" in e["actions"]:
        return compatible(requirement, e)
    if any(fold(option_label(o)) == fold(requirement["value"]) for o in e["options"]):
        return True
    if e.get("chrome"):
        # A header/navigation button must name the *value* itself ("Language" for "English"): a model naming it in "what"
        # is not evidence, because "what" is copied from the label.
        return bool(words(f"{e['label']} {e.get('hint', '')}") & words(requirement["value"]))
    target = f"{requirement['what']} {requirement['value']}"
    if words(f"{e['label']} {e.get('hint', '')}") & words(target):
        return True
    return bool(set(re.findall(r"\d+", e["label"])) & set(re.findall(r"\d+", requirement["value"])))


def lexical_field(requirement, fields):
    """The one field whose name shares the most words with the requirement's name, when that is unambiguous.
    Sub-planners usually name a requirement after its field ("ticket type", "seating class"); plain word overlap
    then settles the mapping without asking the model."""
    target = words(requirement["what"])
    if not target:
        return None
    scored = sorted(((len(words(f"{e['label']} {e.get('hint', '')}") & target), e) for e in fields
                     if compatible(requirement, e)), key=lambda t: -t[0])
    if not scored or scored[0][0] == 0:
        return None
    best = scored[0][0]
    runner_up = scored[1][0] if len(scored) > 1 else 0
    if best >= 2 and best > runner_up or (len(target) == 1 and best == 1 and runner_up == 0):
        return scored[0][1]
    return None


def shortlist(candidates, text, limit, bonus=None, top_tier=False, margin=1):
    """Keep the likeliest candidates, in document order, so options fit Laya's 256-token question budget.
    With top_tier, only candidates scoring within `margin` points of the best remain."""
    scores = {e["node"]: relevance(e, text) + (bonus(e) if bonus else 0) for e in candidates}
    if top_tier and candidates:
        best = max(scores.values())
        candidates = [e for e in candidates if scores[e["node"]] >= best - margin]
    kept = {e["node"] for e in sorted(candidates, key=lambda e: -scores[e["node"]])[:limit]}
    return [e for e in candidates if e["node"] in kept]


class LayaPolicy:
    """Decides one browser action at a time for a sub-goal. `plan` is {"requirements", "open", "finish"}."""

    def __init__(self, goal, plan, engine):
        self.goal = goal
        self.plan = plan
        self.engine = engine
        self.fields = {}  # requirement index -> observed node
        self.met = set()
        self.skipped = set()
        self.attempts = {}
        self.pending = None  # the latest decision, until history shows it executed
        self.last = None  # the latest executed step
        self.edit_url = None
        self.edit_doc = None
        self.submitted = False
        self.waits = 0
        self.seen = 0
        self.tried = {}  # label -> times clicked as the next step
        self.typed = False  # text entered since the last submit
        self.acted = None
        self.search_added = False
        self.frozen = set()  # requirements submitted to an earlier page
        self.failed = {}  # node -> decisions on it that could not execute
        self.escapes = 0  # popups closed with Escape
        self.nav_seen = None  # the last new page whose requirements were re-evaluated
        self.doc = None  # identity of the document the remembered node ids belong to
        self.month_req = None  # the date requirement a calendar is being paged for
        self.month_steps = 0
        self.rejected = set()  # (requirement, node) pairs found implausible
        self.tried_sig = {}  # requirement -> the candidate fields last offered to the model

    # Bookkeeping ---------------------------------------------------------------------------------------------

    def sync(self, history):
        step = self.pending
        if step and step["node"] is not None and len(history) == self.seen:
            # The decision never ran: the target was covered or the page changed first.
            self.failed[step["node"]] = self.failed.get(step["node"], 0) + 1
        if len(history) > self.seen and step and history[-1].get("choice") == step["choice"]:
            self.last = step
            if step["req"] is not None:
                self.attempts[step["req"]] = self.attempts.get(step["req"], 0) + 1
                self.edit_url, self.edit_doc, self.submitted = step["url"], step.get("doc"), False
            if step["kind"] == "fill":
                self.typed = True
            if step["kind"] in {"submit", "item"}:
                self.submitted = True
            if step["kind"] in {"submit", "item", "next"}:
                self.tried[step["label"]] = self.tried.get(step["label"], 0) + 1
            self.waits = self.waits + 1 if step["kind"] == "wait" else 0
            if step["kind"] != "wait":
                self.acted = step["kind"]  # the latest non-wait step
        self.seen, self.pending = len(history), None

    def ask(self, state, questions):
        result = self.engine.system_one(state, questions)
        self.laya_calls += 1
        for key, answer in result["answers"].items():
            if questions[key]["type"] == "choice":
                try:
                    validate_choice(answer, questions[key]["criteria"])
                except ValueError:
                    raise ValueError("Invalid Laya response; no action executed.") from None
        self.answers.update(result["answers"])
        self.questions.update(questions)
        self.tokens += result["usage"]["input_tokens"]
        return result["answers"]

    def pick(self, qid, candidates, state, instructions, text, limit=20, bonus=None, allow_none=False,
             top_tier=False, margin=1):
        date = month_day(text)
        dated = [e for e in candidates if date and month_day(e["label"]) == date]
        if len(dated) == 1:
            return dated[0], None  # An exact calendar match needs no model call; Laya confused adjacent days.
        ranked = shortlist(candidates, text, limit, bonus, top_tier, margin)
        if not ranked:
            return None
        criteria = {str(e["node"]): describe(e) for e in ranked}
        if allow_none:
            criteria["none"] = "none of these"
        answer = self.ask(state, {qid: {"type": "choice", "instructions": instructions, "criteria": criteria}})[qid]
        if answer["choice"] == "none":
            return None
        return next(e for e in ranked if str(e["node"]) == answer["choice"]), answer

    # Decisions ----------------------------------------------------------------------------------------------

    def choose(self, page, history):
        started = time.perf_counter()
        self.sync(history)
        document = (page.get("page_key") or [None])[0]
        if document != self.doc:
            # Node ids restart with every document, so everything remembered per node is meaningless on a new page.
            self.doc = document
            self.fields.clear()
            self.failed.clear()
            self.rejected.clear()
            self.tried_sig.clear()
        if self.moved(page):
            # The form was submitted to a new page. Its values were used; a new page's empty copy of the
            # form (a site-wide search box, say) does not undo them.
            self.typed = False
            self.frozen |= self.met
            if location(page["url"]) != self.nav_seen:
                # Once per new page: what was worked on has been submitted, and a requirement that found no control
                # on the old page (a results filter such as "nonstop only") gets a fresh budget on this one.
                self.nav_seen = location(page["url"])
                self.frozen |= {i for i, n in self.attempts.items() if n > 0 and i not in self.skipped}
                reopened = self.skipped - self.frozen
                self.skipped -= reopened
                for i in reopened:
                    self.attempts[i] = 0
        elements = observed(page)
        self.answers, self.questions, self.tokens, self.laya_calls = {}, {}, 0, 0
        op, element, action, picked, kind, req, text = self.decide(page, elements)
        answer = picked[1] if picked else None
        indices = {str(e["node"]): e["index"] for e in elements}
        choice = action["id"] if action else {"DONE": "DONE", "BLOCKED": "BLOCKED"}.get(op, "wait")
        probability = answer["probabilities"][answer["choice"]] if answer else 1.0
        target = element["index"] if element else None
        if action and action["kind"] == "select":
            target = f"{element['index']}:{element['options'].index(action) + 1}"
        self.pending = {
            "choice": choice, "kind": kind, "req": req, "node": element["node"] if element else None,
            "url": page["url"], "doc": (page.get("page_key") or [None])[0], "before": {e["node"] for e in elements},
            "label": element["label"] if element else None,
        }
        return {
            "choice": choice,
            "operation": op,
            "target": target,
            "text": text,
            "confidence": answer["confidence"] if answer else 1.0,
            "probabilities": {choice: probability},
            "operation_probabilities": {op: probability},
            "target_probabilities": {
                indices.get(k, k): p for k, p in (answer or {}).get("probabilities", {}).items() if k in indices
            },
            "target_confidence": answer["confidence"] if answer and element else None,
            "raw_answers": self.answers,
            "model": self.engine.model_name,
            "laya_calls": self.laya_calls,
            "usage": {"input_tokens": self.tokens, "output_tokens": 0},
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "request": {"plan": self.plan, "questions": self.questions},
        }

    def decide(self, page, elements):
        """Return (operation, element, action, (element, answer) or None, step kind, requirement, text)."""
        reqs = self.plan["requirements"]
        by_node = {e["node"]: e for e in elements}
        clickable = [e for e in elements if "click" in e["actions"] and self.failed.get(e["node"], 0) < 2]
        last = self.last

        # 1. A typed query or an opened control offers new choices: take the one its requirement asks for.
        # (Node ids restart on every document, so "new since the decision" only means something within one document.)
        same_document = bool(last) and last.get("doc") == (page.get("page_key") or [None])[0]
        month_req = last["req"] if last and last["req"] is not None else self.month_req
        if last and same_document and last["kind"] in {"fill", "open", "month"} and month_req is not None:
            r = reqs[month_req]
            wanted_day = month_day(r["value"])
            if wanted_day and not any(month_day(e["label"]) == wanted_day for e in clickable):
                # A calendar is open but shows other months: page forward, as a person would (bounded).
                days = [e for e in clickable if month_day(e["label"])]
                forward = [e for e in clickable if e["role"] == "button" and re.match(r"^(next|next month|forward|›|»|>)\b", e["label"].strip(), re.I)]
                if days and forward and self.month_steps < 14:
                    self.month_steps += 1
                    self.month_req = month_req
                    return self.click((forward[0], None), "month", None)
            last = {**last, "req": month_req}
            new = [e for e in clickable if e["node"] not in last["before"]]
            # Suggestions name the value; controls that appear beside them ("Clear", "Swap") do not.
            new = [e for e in new if relevance(e, r["value"]) and len(e["label"]) <= 80]
            option_like = [e for e in new if e["role"] in OPTION_ROLES]
            new = option_like or new  # menu entries beat stray text that merely shares a word with the value
            state = f"Requirement: {r['what']} = {r['value']}"
            wanted = fold(r["value"])
            direct = [e for e in new if wanted and (fold(e["label"]) == wanted or wanted in fold(e["label"]) or
                                                    (len(fold(e["label"])) >= 4 and fold(e["label"]) in wanted))]
            if len(direct) == 1:
                return self.click((direct[0], None), "pick", last["req"])  # one option names the value: no model call
            picked = self.pick("option", new, state, f"Which option sets {r['what']} to {r['value']}?",
                               r["value"], allow_none=True)
            if picked:
                return self.click(picked, "pick", last["req"])

        # An item to open that nothing on the page names has to be searched for first.
        item = self.plan.get("open")
        covered = any(words(r["value"]) & words(item) for r in reqs) if item else False  # a stated value already is the search
        if item and not self.search_added and not covered and not titled(page["title"], item):
            search = [e for e in elements if "fill" in e["actions"] and
                      (e["role"] == "searchbox" or "searc" in words(e["label"]))]
            if search and not any(relevance(e, item) for e in clickable):
                reqs.append({"what": "search", "value": item})
                self.search_added = True

        # 2. Requirements in the goal's order: map each to an observed element, then check its value.
        unsettled = [i for i in range(len(reqs)) if i not in self.met and i not in self.skipped and i not in self.frozen]
        if unsettled and not any(plannable(e) for e in elements):
            # Nothing to fill: either the page is still loading, or a popup (menu, listbox) hides the rest of the page.
            popup = [e for e in clickable if e["role"] in {"option", "menuitem", "menuitemradio"}]
            if popup:
                wanted = [(i, r) for i, r in enumerate(reqs) if i in unsettled]
                about = " ".join(f"{r['what']} {r['value']}" for _i, r in wanted)
                picked = self.pick("option", popup, f"An open menu. Still to set: {about}",
                                   f"Which option helps set: {about}?", about, allow_none=True)
                if picked:
                    best = max(wanted, key=lambda ir: relevance(picked[0], ir[1]["value"]), default=(None, None))[0]
                    return self.click(picked, "pick", best)
                if self.escapes < 3:  # nothing in the menu is wanted: close it, as a person would
                    self.escapes += 1
                    return "KEY", None, {"id": "key_escape", "kind": "key", "key": "Escape", "label": "Press Escape"}, \
                        None, "next", None, None
            # The page is still loading or showing an interstitial. This costs no attempt.
            return "WAIT", None, None, None, "wait", None, None
        self.refresh(page, elements, by_node)
        for i, r in enumerate(reqs):
            if i in self.met or i in self.skipped or i in self.frozen:
                continue
            if self.attempts.get(i, 0) >= 3:
                self.skipped.add(i)
                continue
            e = by_node.get(self.fields.get(i))
            state = f"Requirement: {r['what']} = {r['value']}"
            if e is None:
                # A control about this requirement that already displays its value ("Travellers and cabin
                # class: 1 Adult, Economy") settles it. Both the name and the value must appear.
                # Calendar days name a date too, but they are choices, not displays.
                shown = [c for c in elements if plannable(c) and c["role"] not in TOGGLES and not month_day(c["label"])
                         and words(c["label"]) & words(r["what"]) and words(c["label"]) & words(r["value"])
                         and settled(r, {**c, "current": c["label"], "options": []})]
                if shown:
                    self.met.add(i)
                    continue
                about = f"{r['what']} {r['value']}"
                options = [c for c in clickable if c["role"] not in TOGGLES or words(c["label"]) & words(about)]
                # Controls have short names; long labels are result cards or articles that merely share a word.
                options = [c for c in options if relevance(c, about) and len(c["label"]) <= 70]
                picked = self.pick(f"set_{i}", options, state, f"Which element sets {r['what']} to {r['value']}?",
                                   about, allow_none=True)
                if not picked:
                    if self.last and self.last["kind"] in {"pick", "open"} and self.escapes < 3:
                        # A menu opened for an earlier requirement can stay open and hide the rest of the page.
                        self.escapes += 1
                        return "KEY", None, {"id": "key_escape", "kind": "key", "key": "Escape", "label": "Press Escape"}, \
                            None, "next", None, None
                    # Often the page is mid-render. Wait (one attempt); the attempt limit skips it for good.
                    return "WAIT", None, None, None, "wait", i, None
                # It may open a picker (a trip-type menu, a calendar); step 1 then chooses from what appears.
                return self.click(picked, "open", i)
            if "fill" in e["actions"]:
                return "TYPE_TEXT", e, e["actions"]["fill"], None, "fill", i, r["value"]
            if e["options"]:
                exact = [o for o in e["options"] if fold(option_label(o)) == fold(r["value"])]
                similar = [o for o in e["options"] if words(option_label(o)) & words(r["value"])]
                if exact or len(similar) == 1:
                    return "SELECT", e, (exact or similar)[0], None, "select", i, None
                answer = self.ask(state, {f"select_{i}": {
                    "type": "choice",
                    "instructions": f"Which option sets {r['what']} to {r['value']}?",
                    "criteria": {str(n): option_label(o) for n, o in enumerate(e["options"])},
                }})[f"select_{i}"]
                option = e["options"][int(answer["choice"])]
                return "SELECT", e, option, (e, answer), "select", i, None
            return "CLICK", e, e["actions"]["click"], None, "toggle" if e["role"] in TOGGLES else "open", i, None

        # 3. Everything stated is set. Check the finish condition once something was submitted or navigated.
        finish = self.plan["finish"]
        navigated = self.moved(page)
        if item:
            # An opened item names its page. Accept its title when it carries the item's words, or the words
            # of the element Laya chose to open it.
            chosen = (last and last["kind"] == "item" and relevance({"label": last["label"], "current": ""}, item)
                      and titled(page["title"], last["label"]))
            if chosen or titled(page["title"], item):
                return "DONE", None, None, None, "done", None, None
        elif self.submitted or navigated or not reqs:
            # Laya's yes/no finish check was unreliable; contrasting page kinds separated real outcomes.
            state = f"Page title: {page['title']}\nPage: {summary(page['text'], finish)}"
            done = self.ask(state, {"done": {
                "type": "choice", "instructions": "Which best describes the current page?",
                "criteria": {"finish": finish, **UNFINISHED},
            }})["done"]
            # A submit that led to a new page while every stated value still holds is a search outcome:
            # accept it once Laya sees results, and wait while they load.
            searched = self.acted == "submit" and navigated and self.met | self.skipped | self.frozen >= set(range(len(reqs)))
            # Laya rarely labels a real results page as one, so also count results that name the requested
            # values: two or more elements mentioning at least three of them (route, date, ...).
            wanted = set().union(*(words(r["value"]) for r in reqs)) if reqs else set()
            matching = [e for e in clickable if len(words(e["label"]) & wanted) >= min(3, len(wanted))]
            # Laya called a loading results skeleton "finish", so with stated values it needs rows naming them,
            # or its verdict after the full wait for results.
            laya_done = done["choice"] in {"finish", "results"}
            if (not reqs and done["choice"] == "finish") or (
                searched and (len(matching) >= 2 or (laya_done and self.waits >= MAX_RESULT_WAITS))
            ):
                return "DONE", None, None, None, "done", None, None
            if searched and self.waits < MAX_RESULT_WAITS:
                return "WAIT", None, None, None, "wait", None, None
            if searched:
                # Submitted, navigated, and given time to load: the outcome page is what it is. Poking at its results
                # (flight cards, listings) would only risk opening or selecting something the goal never asked for.
                return "DONE", None, None, None, "done", None, None
        if last and last["kind"] in {"submit", "item", "next"} and self.waits < 2 and (self.submitted or navigated):
            return "WAIT", None, None, None, "wait", None, None
        mapped = {self.fields.get(i) for i in range(len(reqs))}
        fresh = {e["node"] for e in clickable if last and e["node"] not in last["before"]}
        # A next-step target clicked twice already has shown it does not advance the goal.
        candidates = [e for e in clickable if e["node"] not in mapped and self.tried.get(e["label"], 0) < 2]

        def submits(e):
            return 2 * bool(set(fold(e["label"]).split()) & SUBMIT_WORDS) + (e["node"] in fresh)

        state = f"Goal: {self.goal}\nFinish condition: {finish}\nPage title: {page['title']}\nPage: {page['text']}"
        if reqs and not item and not self.typed:
            # Every stated value is set (or could not be). Controls that apply immediately (filters, sort orders) need
            # nothing more; a dialog with an explicit Apply/Done/Show button gets one click. A generic "click what looks
            # relevant" guess here would poke at results (flight cards, listings), so otherwise the sub-goal ends; the
            # executor's independent verification reports anything still unmet.
            applies = [e for e in candidates if e["role"] == "button" and submits(e) >= 2 and len(e["label"]) <= 40]
            if applies and self.last and self.last["kind"] in {"pick", "open", "toggle", "select"}:
                picked = self.pick("submit", applies, state, "Which button applies the chosen options?", "", bonus=submits,
                                   top_tier=True, margin=0)
                if picked:
                    return self.click(picked, "submit", None)
            return "DONE", None, None, None, "done", None, None
        if self.typed:
            # Typed search text is not applied until its form is submitted, so submit before opening results.
            buttons = [e for e in candidates if e["role"] == "button"]
            # Keyboard-driven forms: when the field was just typed into and no button looks like a submit
            # control, pressing Enter in that field is what a person would do.
            if last and last["kind"] == "fill" and not any(submits(e) >= 2 for e in buttons):
                field = by_node.get(last["node"])
                return "KEY", field, {"id": "key_enter", "kind": "key", "key": "Enter", "label": "Press Enter"}, \
                    None, "submit", None, None
            # A button whose label says Search / Find / Submit outranks incidental fresh buttons (result cards).
            tight = 0 if any(submits(e) >= 2 for e in buttons) else 1
            picked = self.pick("submit", buttons, state, "Which button submits the filled form?", "",
                               bonus=submits, top_tier=True, margin=tight)
            if picked:
                return self.click(picked, "submit", None)
        if item:
            named = [e for e in candidates if relevance(e, item) and not is_field(e)]
            # Near-duplicates ("completeness" vs "incompleteness") fooled Laya, so only the elements naming
            # the most of the item's words stay; Laya breaks exact ties.
            # An exact name needs no model; otherwise prefer the candidate with the fewest words beyond the item's
            # ("Artificial intelligence" over "Philosophy of artificial intelligence").
            exact = [e for e in named if fold(e["label"]) == fold(item)]
            if len(exact) == 1:
                return self.click((exact[0], None), "item", None)
            wanted = words(item)
            named = shortlist(named, item, 20, bonus=lambda e: -len(words(e["label"]) - wanted) / 100, top_tier=True, margin=0)
            picked = self.pick("item", named, state, f"Which element opens {item}?", item, top_tier=True, margin=0)
            if picked:
                return self.click(picked, "item", None)
        # Otherwise click what the goal names: the elements sharing the most words with it; Laya breaks ties.
        picked = self.pick("next", candidates, state, "Which element should be clicked next to reach the goal?",
                           f"{self.goal} {finish}", bonus=lambda e: e["node"] in fresh, top_tier=True, margin=0)
        if not picked:
            return "BLOCKED", None, None, None, "blocked", None, None
        return self.click(picked, "next", None)

    def moved(self, page):
        """The submitted form led to a new page: a different path or host, or simply a new document (query-only changes
        such as /search?q=a → /search?q=b are page loads too)."""
        if self.edit_url is None:
            return False
        document = (page.get("page_key") or [None])[0]
        return location(page["url"]) != location(self.edit_url) or (self.edit_doc is not None and document != self.edit_doc)

    def debug_state(self, elements):
        by_node = {e["node"]: e for e in elements}
        out = []
        for i, r in enumerate(self.plan["requirements"]):
            e = by_node.get(self.fields.get(i))
            out.append(f"{i}:{r['what'][:22]}={r['value'][:18]} -> {e['label'][:34] if e else None!r}"
                       f" [{'MET' if i in self.met else 'skip' if i in self.skipped else 'frozen' if i in self.frozen else '...'} a{self.attempts.get(i, 0)}]")
        return "; ".join(out) + f" | last={self.last and self.last['kind']} typed={self.typed} submitted={self.submitted} acted={self.acted}"

    def click(self, picked, kind, req):
        e = picked[0]
        return "CLICK", e, e["actions"]["click"], picked, kind, req, None

    def assign(self, todo, free):
        """Match requirements to fields. Laya is asked both ways (which field sets this requirement, which
        requirement does this field hold); the product matched Flights fields better than either direction.
        The most confident pairs are assigned first, so two requirements never share one field.
        There is no "none" option: in tests it outvoted the right field. Requirements no field can hold
        reach the attempt limit instead. Laya shares one state per request, so each question is one call."""
        reqs = self.plan["requirements"]
        free = shortlist(free, " ".join(f"{reqs[i]['what']} {reqs[i]['value']}" for i in todo), 20)
        fields = {str(e["node"]): describe(e) for e in free}
        options = {str(i): f"{reqs[i]['what']} = {reqs[i]['value']}" for i in todo}
        by_requirement = {
            i: self.ask(f"Requirement: {options[str(i)]}", {f"field_{i}": {
                "type": "choice", "instructions": "Which element shows or sets this requirement?", "criteria": fields,
            }})[f"field_{i}"]["probabilities"]
            for i in todo
        }
        by_field = {
            node: self.ask(f"Form field: {text}", {f"holds_{node}": {
                "type": "choice", "instructions": "Which requirement does this form field hold?",
                "criteria": {**options, "none": "none of these"},
            }})[f"holds_{node}"]["probabilities"]
            for node, text in fields.items()
        }
        # A shared word between the field's label and the requirement's name ("Departure", "departure date")
        # doubles the pair's score.
        label = {str(e["node"]): words(e["label"]) for e in free}
        element = {str(e["node"]): e for e in free}
        pairs = sorted(
            (
                (by_requirement[i][node] * by_field[node][str(i)] * (1 + bool(label[node] & words(reqs[i]["what"])))
                 * compatible(reqs[i], element[node]) * ((i, int(node)) not in self.rejected), i, node)
                for i in todo for node in fields
            ),
            reverse=True,
        )
        done, used = set(), set()
        for score, i, node in pairs:
            if score > 0 and i not in done and node not in used:
                self.fields[i] = int(node)
                done.add(i)
                used.add(node)

    def refresh(self, page, elements, by_node):
        """Map unmapped requirements to observed elements, then check their current values."""
        reqs = self.plan["requirements"]
        open_reqs = [i for i in range(len(reqs)) if i not in self.skipped and i not in self.frozen]
        fields = [e for e in elements if is_field(e)]
        # One field holds one requirement. Fields kept by other requirements are not offered again.
        taken = {self.fields.get(i) for i in open_reqs if self.fields.get(i) in by_node}
        todo = []
        for i in open_reqs:
            if i in self.met or self.fields.get(i) in by_node:
                continue
            r = reqs[i]
            free = [e for e in fields if e["node"] not in taken]
            # A dropdown offering exactly the requested value needs no model call.
            exact = [e for e in free if any(fold(option_label(o)) == fold(r["value"]) for o in e["options"])]
            # The planner names requirements by the observed field label when one sets them.
            named = [e for e in elements if plannable(e) and e["node"] not in taken
                     and fold(r["what"]) in {fold(e["label"]), fold(display(e))}]
            if len(exact) == 1 or len(named) == 1:
                self.fields[i] = (exact or named)[0]["node"]
                taken.add(self.fields[i])
            elif (lex := lexical_field(r, [e for e in free if e["role"] not in TOGGLES or words(e["label"]) & words(f"{r['what']} {r['value']}")])):
                self.fields[i] = lex["node"]
                taken.add(lex["node"])
            else:
                todo.append(i)
        free = [e for e in fields if e["node"] not in taken]
        offered = frozenset(e["node"] for e in free)
        todo = [i for i in todo if self.tried_sig.get(i) != offered]  # unchanged candidates: do not ask again
        if todo and free:
            for i in todo:
                self.tried_sig[i] = offered
            self.assign(todo, free)
        for i in range(len(reqs)):
            e = by_node.get(self.fields.get(i))
            if e is not None and (i, e["node"]) not in self.rejected and not plausible(reqs[i], e):
                # A control sharing no word, number or option with the requirement cannot hold it: forcing the
                # pairing would click something unrelated (a trip-type menu for a "nonstop" filter, say).
                self.rejected.add((i, e["node"]))
                del self.fields[i]
        checks = {}
        for i in open_reqs:
            e = by_node.get(self.fields.get(i))
            if e is None:
                continue
            verdict = settled(reqs[i], e)
            if verdict is None and i not in self.met:
                checks[i] = e
            elif verdict:
                self.met.add(i)
            else:
                self.met.discard(i)
        for i, e in checks.items():
            r = reqs[i]
            answer = self.ask(f"Requirement: {r['what']} = {r['value']}\nCurrent value: {e['current']}", {
                f"met_{i}": {"type": "choice", "instructions": "Does the current value satisfy the requirement?",
                             "criteria": YES_NO},
            })[f"met_{i}"]
            if answer["choice"] == "yes":
                self.met.add(i)
