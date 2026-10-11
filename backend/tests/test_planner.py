import json

import pytest

from jarvis import planner
from jarvis.llm import extract_json


def step(**kw):
    return {"tool": "goto", "url": "github.com/torvalds/linux", **kw}


def test_a_valid_plan_is_parsed_and_urls_are_normalised():
    plan = planner.parse_plan({"interpretation": "x", "steps": [step(expect={"host": "github.com"}), {"tool": "interact", "goal": "set stuff", "open": None}], "then": "done"})
    assert [s.tool for s in plan.steps] == ["goto", "interact"]
    assert plan.steps[0].args["url"] == "https://github.com/torvalds/linux" and plan.steps[0].expect == {"host": ["github.com"]}


@pytest.mark.parametrize("bad", [
    {"steps": []}, {"steps": ["goto"]}, {"steps": [{"tool": "run_js", "code": "alert(1)"}]}, {"steps": [{"tool": "goto", "url": "javascript:alert(1)"}]},
    {"steps": [{"tool": "interact"}]}, {"steps": [{"tool": "tab", "action": "explode", "index": 1}]}, "not a dict",
])
def test_plans_with_unknown_tools_or_unsafe_arguments_are_rejected(bad):
    with pytest.raises(planner.PlanError):
        planner.parse_plan(bad)


def test_the_plan_is_bounded_and_ask_user_stands_alone():
    plan = planner.parse_plan({"steps": [{"tool": "wait", "seconds": 99}] * 20, "then": "weird"})
    assert len(plan.steps) == planner.MAX_PLAN_STEPS and plan.steps[0].args["seconds"] == 5 and plan.then == "replan"
    alone = planner.parse_plan({"steps": [step(), {"tool": "ask_user", "question": "Which city?"}], "then": "answer"})
    assert [s.tool for s in alone.steps] == ["ask_user"] and alone.then == "done"


def test_image_requests_are_repaired_into_an_image_search():
    plan = planner.parse_plan({"steps": [{"tool": "search", "query": "palm trees"}], "then": "done"})
    fixed = planner.repair_plan(plan, "Show me photos of palm trees")
    assert fixed.steps[0].args["kind"] == "images" and fixed.steps[1].tool == "images" and fixed.then == "answer"
    untouched = planner.repair_plan(planner.parse_plan({"steps": [{"tool": "search", "query": "python"}], "then": "done"}), "open the python docs")
    assert untouched.steps[0].args["kind"] == "web"


def test_extracted_values_must_appear_on_the_page():
    text = "Ryanair 3:10 PM – 6:40 PM 2 hr 30 min £23\neasyJet 4:20 PM – 7:50 PM £29"
    rows = [{"airline": "Ryanair", "price": "£23", "time": "3:10 PM"}, {"airline": "easyJet", "price": "£31", "time": "4:20 PM"},
            {"airline": "Invented Air", "price": "£5", "time": "1:00 AM"}]
    kept, dropped = planner.ground_records(rows, text)
    assert [r["airline"] for r in kept] == ["Ryanair", "easyJet"] and dropped == 1
    assert kept[1]["price"] is None  # a price that is not on the page is blanked, never shown


@pytest.mark.parametrize("raw", [
    '{"a": 1}', 'Sure! ```json\n{"a": 1}\n```', 'Here: {"a": 1} hope that helps', '<think>hmm {"x":2}</think>{"a": 1}', '{"a": 1,}',
])
def test_json_is_extracted_from_chatty_model_output(raw):
    assert extract_json(raw) == {"a": 1}


def test_schemas_enumerate_exactly_the_tools_the_parser_knows():
    tools = set(planner.PLAN_SCHEMA["properties"]["steps"]["items"]["properties"]["tool"]["enum"])
    for t in tools:
        raw = {"tool": t, "url": "https://x.test", "query": "q", "goal": "g", "target": "L1", "what": "w", "targets": ["L1"], "action": "switch",
               "index": 1, "question": "?", "direction": "down", "seconds": 1}
        planner.validate_step(json.loads(json.dumps(raw)))
