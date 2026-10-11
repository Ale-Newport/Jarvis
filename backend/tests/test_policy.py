"""Offline contracts for the Laya policy. A fake engine stands in for the model; nothing is downloaded.

Ported from laya-ultrafast's tests/test_laya.py (MIT, Copyright (c) 2026 Browser Use) and extended for the
Jarvis changes: supervisor-supplied plans, lexical field mapping, date/field compatibility, popup handling and
the Enter-key submit fallback.
"""

import pytest

from jarvis import policy as laya
from jarvis.browser import fingerprint


class FakeEngine:
    """Answers each choice question with `prefer(question_id, criteria)`, or the first option."""

    model_name = "fake-laya"

    def __init__(self, prefer=None):
        self.prefer = prefer or (lambda _qid, criteria: next(iter(criteria)))
        self.calls = []

    def system_one(self, state, questions):
        self.calls.append((state, questions))
        answers = {}
        for qid, q in questions.items():
            labels = list(q["criteria"])
            choice = self.prefer(qid, q["criteria"])
            rest = (1 - 0.7) / max(1, len(labels) - 1)
            probabilities = {label: 0.7 if label == choice else rest for label in labels}
            if len(labels) == 1:
                probabilities = {choice: 1.0}
            answers[qid] = {"choice": choice, "probabilities": probabilities, "confidence": 0.5}
        return {"answers": answers, "usage": {"input_tokens": 10}}


def page(actions, url="https://example.test/", title="Search", text="Search", doc=1):
    state = {"url": url, "title": title, "text": text, "scroll": {"y": 0}, "actions": actions, "page_key": [doc]}
    state["fingerprint"] = fingerprint(state)
    return state


FORM = [
    {"id": "e1", "kind": "fill", "label": "Destination", "role": "searchbox", "value": "", "node": 1},
    {"id": "e2", "kind": "click", "label": "Open Destination", "role": "searchbox", "value": "", "node": 1},
    {"id": "e3", "kind": "click", "label": "Find stays", "role": "button", "value": "", "node": 2},
    {"id": "e4", "kind": "click", "label": "View Casa Flora", "role": "button", "value": "", "node": 3},
    {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
]
PLAN = {"requirements": [{"what": "destination", "value": "Lisbon"}], "open": "Casa Flora", "finish": "It is open."}


@pytest.fixture
def fake():
    return FakeEngine()


def policy(fake, plan=PLAN):
    return laya.LayaPolicy("Find a stay in Lisbon and open Casa Flora.", plan, fake)


def executed(history, decision, label=""):
    history.append({"choice": decision["choice"], "action": label})


def test_a_requirement_named_by_its_field_label_needs_no_mapping_call(fake):
    p = policy(fake, {"requirements": [{"what": "Destination", "value": "Lisbon"}], "open": None, "finish": "Seen."})
    d = p.choose(page(FORM), [])
    assert d["choice"] == "e1" and not any(k.startswith("field_") for _s, q in fake.calls for k in q)


def test_goal_values_are_typed_without_a_per_field_text_call(fake):
    p = policy(fake)
    d = p.choose(page(FORM), [])
    assert (d["operation"], d["choice"], d["text"]) == ("TYPE_TEXT", "e1", "Lisbon")
    assert d["target"] == "1"


def test_typed_text_is_submitted_before_opening_a_result(fake):
    p, history = policy(fake), []
    executed(history, p.choose(page(FORM), history))
    filled = [dict(a, value="Lisbon") if a.get("node") == 1 else a for a in FORM]
    d = p.choose(page(filled), history)
    assert (d["operation"], d["choice"]) == ("CLICK", "e3")  # Find stays, not View Casa Flora


def test_item_page_title_finishes_the_goal(fake):
    p = policy(fake, {"requirements": [], "open": "Casa Flora", "finish": "Casa Flora is open."})
    d = p.choose(page(FORM, title="Casa Flora · Forma"), [])
    assert d["operation"] == "DONE" and d["choice"] == "DONE"


def test_a_search_results_title_is_not_the_item_page():
    assert laya.titled("Casa Flora · Forma", "Casa Flora")
    assert not laya.titled("Casa Flora - Search results - Forma", "Casa Flora")


def test_every_target_is_an_observed_action(fake):
    fake.prefer = lambda qid, criteria: list(criteria)[-1]
    p = policy(fake, {"requirements": [], "open": None, "finish": "Done."})
    d = p.choose(page(FORM), [])
    assert d["choice"] in {a["id"] for a in FORM} | {"DONE", "BLOCKED"}


def test_invalid_model_answer_executes_nothing():
    class Broken(FakeEngine):
        def system_one(self, state, questions):
            return {"answers": {k: {"choice": "999", "probabilities": {"999": 1.0}, "confidence": 1.0} for k in questions},
                    "usage": {"input_tokens": 1}}

    form = [dict(a) for a in FORM] + [
        {"id": "e5", "kind": "fill", "label": "Guests", "role": "textbox", "value": "", "node": 4},
    ]
    plan = {"requirements": [{"what": "city", "value": "Lisbon"}], "open": None, "finish": "Seen."}
    with pytest.raises(ValueError, match="Invalid Laya"):
        laya.LayaPolicy("g", plan, Broken()).choose(page(form), [])


def test_a_target_that_never_executes_is_dropped(fake):
    p = policy(fake, {"requirements": [], "open": "Casa Flora", "finish": "Casa Flora is open."})
    first = p.choose(page(FORM), [])
    assert first["choice"] == "e4"
    p.choose(page(FORM), [])  # The covered click raised StalePage; history did not grow.
    third = p.choose(page(FORM), [])
    assert third["choice"] != "e4"


@pytest.mark.parametrize(
    ("value", "current", "expected"),
    [
        ("October 20, 2026", "Tue, Oct 20", True),
        ("October 20, 2026", "Wed, Oct 21", False),
        ("Zurich", "Zürich", True),
        ("London", "", False),
        ("one-way", "Round trip", None),
        ("1 adult", "1 passenger, change number of passengers.", True),
        ("2 adults", "1 passenger", False),
    ],
)
def test_plain_code_settles_what_it_can(value, current, expected):
    element = {"role": "combobox", "current": current, "options": []}
    assert laya.settled({"what": "x", "value": value}, element) is expected


def test_checkbox_requirements_follow_the_checked_state():
    checked = {"role": "checkbox", "current": "checked", "options": []}
    assert laya.settled({"what": "free cancellation", "value": "checked"}, checked)
    assert not laya.settled({"what": "free cancellation", "value": "off"}, checked)


def field(node, label, role="textbox", hint="", value="", options=None):
    return {"node": node, "index": str(node), "role": role, "label": label, "hint": hint, "value": value, "current": value,
            "options": options or [], "actions": {}, "checked": None, "expanded": None}


def test_date_values_never_go_into_text_fields_that_are_not_dates_and_vice_versa():
    date_field = field(1, "Departure", hint="Enter a date or use the arrow keys")
    city_field = field(2, "Where to?")
    assert laya.compatible({"what": "departure", "value": "November 20, 2026"}, date_field)
    assert not laya.compatible({"what": "ticket type", "value": "one way"}, date_field)
    assert laya.compatible({"what": "destination", "value": "Madrid"}, city_field)


def test_a_requirement_named_after_its_field_maps_without_the_model():
    fields = [field(1, "Change ticket type. Round trip", role="combobox"), field(2, "Change seating class. Economy", role="combobox"),
              field(3, "Return", hint="Enter a date or use the arrow keys")]
    picked = laya.lexical_field({"what": "ticket type", "value": "one way"}, fields)
    assert picked and picked["node"] == 1
    assert laya.lexical_field({"what": "seating class", "value": "business"}, fields)["node"] == 2
    assert laya.lexical_field({"what": "number of bags", "value": "2"}, fields) is None


def test_an_open_menu_hides_the_page_so_the_wanted_option_is_chosen(fake):
    menu = [
        {"id": "e1", "kind": "click", "label": "Round trip", "role": "option", "value": "", "node": 1},
        {"id": "e2", "kind": "click", "label": "One way", "role": "option", "value": "", "node": 2},
        {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
    ]
    fake.prefer = lambda _qid, criteria: next(k for k, v in criteria.items() if "One way" in v)
    plan = {"requirements": [{"what": "ticket type", "value": "One way"}], "open": None, "finish": "Seen."}
    d = policy(fake, plan).choose(page(menu), [])
    assert (d["operation"], d["choice"]) == ("CLICK", "e2")


def test_an_unwanted_menu_is_closed_with_escape(fake):
    fake.prefer = lambda _qid, criteria: "none"
    menu = [
        {"id": "e1", "kind": "click", "label": "Red", "role": "option", "value": "", "node": 1},
        {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
    ]
    plan = {"requirements": [{"what": "ticket type", "value": "One way"}], "open": None, "finish": "Seen."}
    d = policy(fake, plan).choose(page(menu), [])
    assert (d["operation"], d["choice"]) == ("KEY", "key_escape")


def test_enter_submits_a_typed_search_when_no_button_looks_like_submit(fake):
    form = [
        {"id": "e1", "kind": "fill", "label": "Search", "role": "searchbox", "value": "", "node": 1},
        {"id": "e2", "kind": "click", "label": "Open Search", "role": "searchbox", "value": "", "node": 1},
        {"id": "e3", "kind": "click", "label": "Menu", "role": "button", "value": "", "node": 2},
        {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
    ]
    plan = {"requirements": [{"what": "Search", "value": "rust"}], "open": None, "finish": "Results are listed."}
    p, history = policy(fake, plan), []
    first = p.choose(page(form), history)
    assert first["operation"] == "TYPE_TEXT"
    executed(history, first)
    typed = [dict(a, value="rust") if a.get("node") == 1 else a for a in form]
    second = p.choose(page(typed), history)
    assert (second["operation"], second["choice"]) == ("KEY", "key_enter")


def test_a_form_subgoal_with_nothing_left_to_do_ends_instead_of_poking_at_results(fake):
    plan = {"requirements": [{"what": "Destination", "value": "Lisbon"}], "open": None, "finish": "Stays are listed."}
    p = policy(fake, plan)
    p.met.add(0)
    d = p.choose(page(FORM, text="Results\nCasa Flora"), [])
    assert d["operation"] == "DONE"


@pytest.mark.parametrize(("value", "label", "expected"), [
    ("Price", "Sorted by top flights, Change sort order.", False),
    ("Price", "Sorted by price, Change sort order", True),
    ("Nonstop only", "Stops, Not selected", False),
    ("Nonstop only", "Nonstop, Stops, Selected", True),
])
def test_a_menu_button_name_carries_its_current_choice(value, label, expected):
    button = {"role": "button", "current": label, "options": [], "haspopup": "menu", "actions": {"click": {}}}
    assert laya.settled({"what": "x", "value": value}, button) is expected


def test_new_elements_after_a_navigation_are_not_mistaken_for_an_opened_menu(fake):
    """Node ids restart on every document: a results page whose ids overlap the form's must not look like its popup."""
    plan = {"requirements": [{"what": "Destination", "value": "Lisbon"}], "open": None, "finish": "Seen."}
    p, history = policy(fake, plan), []
    d = p.choose(page(FORM, doc=1), history)
    executed(history, d)
    results = [{"id": "e1", "kind": "click", "label": "Lisbon stays", "role": "link", "value": "", "node": 1},
               {"id": "e2", "kind": "click", "label": "Lisbon guide", "role": "link", "value": "", "node": 2},
               {"id": "wait", "kind": "wait", "label": "Wait for the page to update"}]
    p.choose(page(results, url="https://example.test/results", doc=2), history)
    assert not any(qid == "option" for _s, q in fake.calls for qid in q)


def test_a_stated_search_value_is_not_duplicated_as_an_extra_search_requirement(fake):
    plan = {"requirements": [{"what": "Search", "value": "artificial intelligence"}], "open": "Artificial intelligence", "finish": "Open."}
    p = policy(fake, plan)
    p.choose(page(FORM), [])
    assert len(p.plan["requirements"]) == 1


def test_a_results_page_with_only_links_is_not_waited_on_when_every_value_is_settled(fake):
    plan = {"requirements": [{"what": "Destination", "value": "Lisbon"}], "open": "Casa Flora", "finish": "Open."}
    p = policy(fake, plan)
    p.met.add(0)
    links = [{"id": "e1", "kind": "click", "label": "Casa Flora", "role": "link", "value": "", "node": 1},
             {"id": "wait", "kind": "wait", "label": "Wait for the page to update"}]
    d = p.choose(page(links), [])
    assert (d["operation"], d["choice"]) == ("CLICK", "e1")


def test_remembered_node_mappings_do_not_leak_into_the_next_document(fake):
    plan = {"requirements": [{"what": "Destination", "value": "Lisbon"}], "open": "Casa Flora", "finish": "Open."}
    p = policy(fake, plan)
    p.choose(page(FORM, doc=1), [])
    assert p.fields  # the requirement was mapped to a node of document 1
    results = [{"id": "e1", "kind": "click", "label": "Casa Flora", "role": "link", "value": "", "node": 1},
               {"id": "wait", "kind": "wait", "label": "Wait for the page to update"}]
    p.met.add(0)
    d = p.choose(page(results, url="https://example.test/r", doc=2), [])
    assert not p.fields and d["choice"] == "e1"  # node 1 of the new page is a candidate, not a "mapped field"


def test_a_calendar_that_does_not_show_the_month_is_paged_forward(fake):
    plan = {"requirements": [{"what": "Departure", "value": "December 1, 2026"}], "open": None, "finish": "Seen."}
    p, history = policy(fake, plan), []
    form = [{"id": "e1", "kind": "fill", "label": "Departure", "role": "textbox", "value": "", "node": 1},
            {"id": "e2", "kind": "click", "label": "Open Departure", "role": "textbox", "value": "", "node": 1},
            {"id": "wait", "kind": "wait", "label": "Wait for the page to update"}]
    first = p.choose(page(form), history)
    assert first["operation"] == "TYPE_TEXT"
    executed(history, first)
    calendar = [{"id": "e1", "kind": "click", "label": "Wednesday, October 14, 2026", "role": "button", "value": "", "node": 5},
                {"id": "e2", "kind": "click", "label": "Sunday, November 1, 2026", "role": "button", "value": "", "node": 6},
                {"id": "e3", "kind": "click", "label": "Next", "role": "button", "value": "", "node": 7},
                {"id": "wait", "kind": "wait", "label": "Wait for the page to update"}]
    second = p.choose(page(calendar), history)
    assert (second["operation"], second["choice"]) == ("CLICK", "e3")  # "Next", not an unrelated day
    executed(history, second)
    with_december = calendar + [{"id": "e4", "kind": "click", "label": "Tuesday, December 1, 2026", "role": "button", "value": "", "node": 8}]
    third = p.choose(page(with_december), history)
    assert (third["operation"], third["choice"]) == ("CLICK", "e4")


def test_site_chrome_buttons_cannot_hold_a_requirement_just_because_a_model_named_them():
    button = field(9, "Change appearance", role="button")
    button.update(actions={"click": {}}, chrome=True, haspopup="menu")
    assert not laya.plausible({"what": "Change appearance", "value": "direct only"}, button)
    chip = field(10, "Stops, Not selected", role="button")
    chip.update(actions={"click": {}}, haspopup="dialog")
    assert laya.plausible({"what": "Stops, Not selected", "value": "Nonstop only"}, chip)
