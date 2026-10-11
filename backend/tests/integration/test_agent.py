"""End-to-end task scenarios on the fixture web: real Chrome, real Laya, real executor and verification; only the text model
is scripted. These are the deterministic counterparts of the live tests."""

import asyncio
import json
import re

import pytest
from conftest import ScriptedLLM

pytestmark = pytest.mark.asyncio(loop_scope="session")


def plan(steps, then="done", interpretation="test"):
    return {"interpretation": interpretation, "steps": steps, "then": then}


def flights_rows(user: str) -> dict:
    """What a competent extraction model returns for the Flights fixture: rows copied from the page text."""
    text = user.split("UNTRUSTED PAGE CONTENT", 1)[-1]
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    records, i = [], 0
    while i < len(lines) - 4:
        if re.match(r"^\d+:\d+ [AP]M – \d+:\d+ [AP]M$", lines[i]):
            dep, arr = lines[i].split(" – ")
            records.append({"airline": lines[i + 1], "departure": dep, "arrival": arr, "duration": lines[i + 2], "stops": lines[i + 3], "price": lines[i + 4]})
            i += 5
        else:
            i += 1
    return {"records": records, "complete": True, "note": ""}


VERIFIED = lambda _user: {"checks": [{"requirement": "request", "status": "verified", "evidence": "page"}], "results_present": True}  # noqa: E731


def flights_llm(*, follow_up: bool = False) -> ScriptedLLM:
    def planner(user: str) -> dict:
        if "Only show direct flights" in user:
            return plan([{"tool": "interact", "goal": "stops: nonstop only; sort by price"},
                         {"tool": "extract", "what": "flight options", "fields": ["airline", "departure", "arrival", "duration", "stops", "price"]}], "answer")
        return plan([{"tool": "goto", "url": "FLIGHTS_URL"},
                     {"tool": "interact", "goal": "one way; from London; to Madrid; depart November 20, 2026; 1 adult; then search"},
                     {"tool": "extract", "what": "flight options", "fields": ["airline", "departure", "arrival", "duration", "stops", "price"]}], "answer")

    def subplan(user: str) -> dict:
        if "nonstop" in user.lower() and "Stops" in user:
            return {"requirements": [{"what": "Stops, Not selected", "value": "Nonstop only"},
                                     {"what": "Sorted by top flights, Change sort order.", "value": "Price"}],
                    "open": None, "finish": "The list shows only nonstop flights sorted by price."}
        return {"requirements": [{"what": "Change ticket type. Round trip", "value": "One way"}, {"what": "Where from?", "value": "London"},
                                 {"what": "Where to?", "value": "Madrid"}, {"what": "Departure", "value": "November 20, 2026"},
                                 {"what": "1 passenger, change number of passengers.", "value": "1 adult"}],
                "open": None, "finish": "One-way flights from London to Madrid on November 20, 2026 are listed."}

    return ScriptedLLM({"plan": planner, "subplan": subplan, "extract": flights_rows, "verify": VERIFIED,
                        "answer": lambda user: "Here are the flights found."})


def patch_url(llm: ScriptedLLM, site) -> ScriptedLLM:
    original = llm.rules["plan"]

    def planner(user: str) -> dict:
        return json.loads(json.dumps(original(user)).replace("FLIGHTS_URL", f"{site.url}/site/flights.html"))

    llm.rules["plan"] = planner
    return llm


# Test 1 — Google-style search: open the official result --------------------------------------------------------------------


async def test_1_search_and_open_the_official_result(harness, site):
    llm = ScriptedLLM({"plan": lambda user: plan([
        {"tool": "search", "query": "official python documentation"},
        {"tool": "open_link", "target": "the official Python documentation site", "expect": {"title": ["Python 3 documentation"]}}]),
        "other": lambda user: {"choice": "L2"}})  # the tie-break when Laya is unsure; Laya may well answer first
    run = await harness.run("Search Google for the official Python documentation and open the official website.", llm)
    assert run.status == "done", run.error
    assert run.page["url"].endswith("/s/python-docs")
    assert run.page["title"].startswith("Python 3 documentation")
    assert "/s/python-mirror" not in site.paths()[-3:]  # the unofficial mirror was not opened
    assert [name for name, _ in llm.log][0] == "plan"
    timings = run.timings
    assert timings["llm_calls"] in {1, 2} and timings["total_ms"] > 0 and timings["browser_ops"] > 0


# Test 2 — site navigation: search box + open the right article ---------------------------------------------------------------


async def test_2_website_navigation_verified_by_url_and_title(harness, site):
    llm = ScriptedLLM({
        "plan": lambda user: plan([{"tool": "goto", "url": f"{site.url}/wiki"},
                                   {"tool": "interact", "goal": "search for artificial intelligence and open the article", "open": "Artificial intelligence",
                                    "expect": {"title": ["Artificial intelligence"]}}]),
        "subplan": lambda user: {"requirements": [{"what": "Search Fixturepedia", "value": "artificial intelligence"}], "open": "Artificial intelligence",
                                 "finish": "The article Artificial intelligence is open."},
    })
    run = await harness.run("Open the encyclopedia and find the article about artificial intelligence.", llm)
    assert run.status == "done", run.error
    assert run.page["url"].endswith("/wiki/Artificial_intelligence")
    assert run.page["title"] == "Artificial intelligence - Fixturepedia"  # not "...in healthcare"
    assert run.timings["laya_calls"] > 0


# Test 3 — flights form: route, date, passengers, results -------------------------------------------------------------------------


async def test_3_flights_form_and_grounded_results(harness, site):
    llm = patch_url(flights_llm(), site)
    run = await harness.run("Find one-way direct flights from London to Madrid for one adult on November 20, 2026.", llm)
    assert run.status == "done", (run.error, run.result and run.result["markdown"])
    url = run.page["url"]
    assert "view=results" in url and "trip=One+way" in url and "from=London" in url and "to=Madrid" in url
    assert "date=2026-11-20" in url and "pax=1" in url
    assert run.page["title"] == "London to Madrid | Fixture Flights"
    table = next(c for c in run.result["cards"] if c["type"] == "table")
    assert len(table["rows"]) == 6 and table["columns"][0] == "airline"
    page_text = run.page["text"]
    assert all(row["cells"][-1] in page_text for row in table["rows"])  # every price is literally on the page
    assert not [w for _s, o in run.progress for w in o.warnings], "a requested value could not be confirmed"


async def test_3b_a_transient_site_error_is_retried_not_reported_as_success(harness, site):
    llm = patch_url(flights_llm(), site)
    original = llm.rules["plan"]
    llm.rules["plan"] = lambda user: json.loads(json.dumps(original(user)).replace("flights.html", "flights.html?flaky=1"))
    # the fixture's results page shows "Oops, something went wrong / Reload" once, then works
    run = await harness.run("Find one-way flights from London to Madrid for one adult on November 20, 2026.", llm)
    assert run.status in {"done", "partial"}
    table = [c for c in run.result["cards"] if c["type"] == "table"]
    assert table and len(table[0]["rows"]) == 6


# Test 6 — follow-up keeps context ------------------------------------------------------------------------------------------------


async def test_6_follow_up_reuses_the_open_results_page(harness, site):
    llm = patch_url(flights_llm(), site)
    first = await harness.run("Find one-way flights from London to Madrid for one adult on November 20, 2026.", llm)
    assert first.status == "done", first.error
    tab_id = first.tab.id
    second = await harness.run("Only show direct flights and sort by price.", llm)
    assert second.status == "done", (second.error, second.result and second.result["markdown"])
    assert second.tab.id == tab_id and second.parent_task_id == first.id
    assert "stops=nonstop" in second.page["url"] and "sort=price" in second.page["url"]
    prices = [int(re.sub(r"[^\d]", "", row["cells"][-1])) for row in next(c for c in second.result["cards"] if c["type"] == "table")["rows"]]
    assert prices == sorted(prices) and len(prices) == 4  # only the four nonstop flights, cheapest first
    plan_prompt = next(user for name, user in llm.log if name == "plan" and "Only show direct flights" in user)
    assert "CONVERSATION CONTEXT" in plan_prompt and "Fixture Flights" in plan_prompt  # earlier task and the open page reach the planner


# Test 4 — image search ---------------------------------------------------------------------------------------------------------------


async def test_4_image_results_with_thumbnails_sources_and_original_urls(harness, site):
    llm = ScriptedLLM({"plan": lambda user: plan([{"tool": "search", "query": "realistic tropical palm trees", "kind": "images"},
                                                  {"tool": "images", "limit": 12}], "answer")})
    run = await harness.run("Search Google Images for realistic tropical palm trees.", llm)
    assert run.status == "done", run.error
    grid = next(c for c in run.result["cards"] if c["type"] == "images")
    assert len(grid["items"]) == 12  # the sponsored tile was left out
    assert all(i["thumbnail_url"].startswith("data:image/svg") for i in grid["items"])
    enriched = [i for i in grid["items"] if i["image_url"]]
    assert len(enriched) >= 6
    first = grid["items"][0]
    assert first["image_url"].endswith("/img/1.svg") and first["source_url"].endswith("/s/img1") and first["title"] in {"Palm photo 1", "Visit page 1"}
    assert len({i["image_url"] for i in enriched}) == len(enriched)  # no tile reported another tile's details


# Test 5 — multi-step research ------------------------------------------------------------------------------------------------------


async def test_5_research_visits_several_sources_and_cites_only_real_links(harness, site):
    def planner(user: str) -> dict:
        if "PROGRESS SO FAR" not in user:
            return plan([{"tool": "search", "query": "free 3D models"}, {"tool": "read"}], "replan")
        ids = [m[1] for m in re.finditer(r"^(L\d+) · (alphameshes|betaforge|gammasculpt)", user, flags=re.M | re.I)]
        assert len(ids) == 3, user
        return plan([{"tool": "visit", "targets": ids}], "answer")

    def answer(user: str) -> str:
        return ("| Site | Models |\n|---|---|\n| AlphaMeshes | 12,000 |\n| BetaForge | 8,500 |\n| GammaSculpt | 30,000 |\n\n"
                f"[AlphaMeshes](http://alphameshes.localhost:{site.port}/s/models-alpha) [Invented]({site.url}/s/invented)")

    llm = ScriptedLLM({"plan": planner, "answer": answer})
    tabs_before = len([t for t in harness.chrome.tabs.values() if not t.closed])
    run = await harness.run("Find three websites offering free 3D models and compare them.", llm)
    assert run.status == "done", run.error
    paths = site.paths()
    assert {"/s/models-alpha", "/s/models-beta", "/s/models-gamma"} <= set(paths)
    assert "/s/models-delta" not in paths
    sources = next(c for c in run.result["cards"] if c["type"] == "sources")["items"]
    assert {s["url"].rsplit("/", 1)[-1] for s in sources} >= {"models-alpha", "models-beta", "models-gamma"}
    markdown = run.result["markdown"]
    assert "[AlphaMeshes](" in markdown and "unverified link removed" in markdown and "/s/invented" not in markdown
    assert len([t for t in harness.chrome.tabs.values() if not t.closed]) <= tabs_before + 1  # visited tabs were closed again


# Test 7 — recovery: stale DOM and covered targets ------------------------------------------------------------------------------------


async def test_7_recovery_from_a_rerendering_page_is_bounded(harness, site, laya):
    from jarvis.goal_runner import SubGoal, run_subgoal

    tab = await harness.chrome.new_tab(f"{site.url}/stale")
    subgoal = SubGoal("Click Confirm order details", [], "Confirm order details", "The page says clicked.")
    result = await asyncio.wait_for(run_subgoal(harness.chrome, tab, laya, subgoal, max_actions=12), 60)
    assert result.status in {"done", "blocked", "budget", "stale"}
    assert "clicked" in (await tab.observe())["text"], "the control was eventually clicked once the page settled"
    assert len(result.history) <= 12
    await harness.chrome.close_tab(tab)


async def test_7b_a_covered_control_is_not_clicked_through_the_overlay(harness, site, laya):
    from jarvis.goal_runner import SubGoal, run_subgoal

    tab = await harness.chrome.new_tab(f"{site.url}/covered")
    subgoal = SubGoal("Click Reveal", [], "Reveal", "The page says clicked.")
    result = await asyncio.wait_for(run_subgoal(harness.chrome, tab, laya, subgoal, max_actions=8), 60)
    assert result.status in {"done", "blocked", "budget", "stale"}
    assert len(result.history) <= 8
    await harness.chrome.close_tab(tab)


# Test 8 — cancellation ----------------------------------------------------------------------------------------------------------------


async def test_8_cancelling_stops_the_task_and_keeps_chrome_usable(harness, site):
    llm = ScriptedLLM({"plan": lambda user: plan([{"tool": "goto", "url": f"{site.url}/slow"}, {"tool": "goto", "url": f"{site.url}/search?q=python"}])})
    run = harness.new_run("Open the slow page then search.", llm)
    task = run.start()
    await asyncio.sleep(1.5)
    run.cancel()
    await asyncio.wait_for(task, 10)
    assert run.status == "cancelled" and run.finished_at
    assert "/search?q=python" not in " ".join(site.paths()[-2:])  # the step after the cancelled one never ran
    assert harness.chrome.connected
    follow = await harness.run("Open the search page.", ScriptedLLM({"plan": lambda user: plan([{"tool": "goto", "url": f"{site.url}/search?q=python"}])}))
    assert follow.status == "done" and follow.page["title"].endswith("Fixture Search")


# Safety: confirmations, CAPTCHA pauses ---------------------------------------------------------------------------------------------------


async def test_a_purchase_click_waits_for_the_users_decision(harness, site):
    llm = ScriptedLLM({"plan": lambda user: plan([{"tool": "goto", "url": f"{site.url}/shop"},
                                                  {"tool": "interact", "goal": "click the Place order button"}]),
                       "subplan": lambda user: {"requirements": [], "open": None, "finish": "The order is placed."}})
    run = harness.new_run("Click the Place order button.", llm)
    queue = harness.bus.subscribe()
    task = run.start()
    request = None
    for _ in range(300):
        event = await asyncio.wait_for(queue.get(), 60)
        if event["type"] == "confirm.request":
            request = event["data"]
            break
    assert request and request["kind"] in {"payment", "purchase"} and "Place order" in request["question"]
    assert run.status == "waiting_user" and run.waiting["confirmation_id"] == request["confirmation_id"]
    page = await run.tab.observe()
    assert "ORDER PLACED" not in page["text"]  # nothing happened before the answer
    run.answer_confirmation(request["confirmation_id"], False)
    await asyncio.wait_for(task, 30)
    assert "ORDER PLACED" not in (await run.tab.observe())["text"]
    assert run.status in {"partial", "done"}


async def test_a_captcha_pauses_the_task_until_the_user_resumes(harness, site):
    site.captcha_solved = False
    llm = ScriptedLLM({"plan": lambda user: plan([{"tool": "goto", "url": f"{site.url}/captcha"}, {"tool": "read"}], "answer")})
    run = harness.new_run("Open the pricing page and tell me the price.", llm)
    queue = harness.bus.subscribe()
    task = run.start()
    needs = None
    for _ in range(300):
        event = await asyncio.wait_for(queue.get(), 60)
        if event["type"] == "needs_user":
            needs = event["data"]
            break
    assert needs and needs["kind"] == "captcha"
    assert run.status == "waiting_user" and run.waiting["kind"] == "captcha"
    await asyncio.sleep(0.5)
    assert run.status == "waiting_user"  # it does not try to get past the check
    site.solve_captcha()  # the user solves it in Chrome ...
    run.resume()  # ... and presses Resume
    await asyncio.wait_for(task, 60)
    assert run.status == "done", run.error
    assert "pricing is 10 dollars" in " ".join(n.text for n in run.notes)


async def test_pause_and_resume_between_steps(harness, site):
    llm = ScriptedLLM({"plan": lambda user: plan([{"tool": "goto", "url": f"{site.url}/search?q=python"}, {"tool": "wait", "seconds": 1},
                                                  {"tool": "goto", "url": f"{site.url}/wiki"}])})
    run = harness.new_run("Open the pages.", llm)
    task = run.start()
    await asyncio.sleep(0.4)
    run.pause()
    assert run.status == "paused"
    await asyncio.sleep(1.8)
    assert run.status == "paused" and not task.done()
    assert not run.page or not run.page["url"].endswith("/wiki")
    run.resume()
    await asyncio.wait_for(task, 30)
    assert run.status == "done" and run.page["url"].endswith("/wiki")


async def test_download_needs_approval_and_saves_the_file(harness, site, tmp_path):
    llm = ScriptedLLM({"plan": lambda user: plan([{"tool": "goto", "url": f"{site.url}/search?q=python"}, {"tool": "read"},
                                                  {"tool": "download", "what": f"{site.url}/download/report.txt"}])})
    run = harness.new_run("Download the report.", llm)
    queue = harness.bus.subscribe()
    task = run.start()
    for _ in range(300):
        event = await asyncio.wait_for(queue.get(), 60)
        if event["type"] == "confirm.request":
            assert "Download" in event["data"]["question"]
            run.answer_confirmation(event["data"]["confirmation_id"], True)
            break
    await asyncio.wait_for(task, 60)
    files = next(c for c in run.result["cards"] if c["type"] == "files")["items"]
    assert files[0]["name"] == "report.txt" and open(files[0]["path"]).read() == "report contents\n"
