"""Live scenarios on real websites with a real text model (opt in with `pytest --live`).

They exercise the same paths as the fixture tests against Google, Wikipedia and friends. External sites change and sometimes show bot
checks; when one does, the test is *skipped with the reason* (never counted as a pass). Solve the check once in the Chrome window the
test opens (the profile persists in JARVIS_LIVE_DATA) and run again.

    JARVIS_TEST_MODEL=qwen3:8b uv run pytest tests/live --live -v
"""

import asyncio
import base64
import datetime
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from jarvis.app import App
from jarvis.laya_engine import cached_path
from jarvis.settings import Secrets

pytestmark = [pytest.mark.live, pytest.mark.asyncio(loop_scope="session")]
MODEL = os.environ.get("JARVIS_TEST_MODEL", "qwen3:8b")
ENGINE_HINT = os.environ.get("JARVIS_LIVE_ENGINE", "")  # e.g. "duckduckgo" when Google keeps showing CAPTCHAs


@pytest.fixture(scope="session")
async def live_app():
    if cached_path("aac6fef/laya-typed-decisions-mlx") is None:
        pytest.skip("the Laya checkpoint is not downloaded")
    data = Path(os.environ.get("JARVIS_LIVE_DATA", Path.home() / ".jarvis-live-tests"))
    app = App(data, downloads_dir=data / "downloads", secrets=Secrets())
    await app.update_settings({"llm": {"model": MODEL}, "agent": {"max_minutes": 4}, "chrome": {"keep_open_on_quit": False}})
    if not (await app.llm_status())["reachable"]:
        pytest.skip("no text model server is reachable (start Ollama)")
    await app.start()
    yield app
    await app.shutdown()


async def ask(app: App, conversation: dict, text: str):
    """Send one message; return the finished TaskRun, or skip when the site raised a bot check / sign-in wall."""
    queue = app.bus.subscribe()
    _msg, task = await app.send_message(conversation["id"], text)
    run = app.task(task["id"])
    blocked = None
    while not run._asyncio_task.done():
        try:
            event = await asyncio.wait_for(queue.get(), 1)
        except TimeoutError:
            continue
        if event["type"] == "needs_user" and event.get("task_id") == run.id:
            blocked = event["data"]["message"]
            run.cancel()
            break
        if event["type"] == "confirm.request":
            run.answer_confirmation(event["data"]["confirmation_id"], False)  # live tests never buy anything
    await asyncio.wait_for(asyncio.shield(run._asyncio_task), 60)
    app.bus.unsubscribe(queue)
    if blocked:
        pytest.skip(f"the site asked for a human: {blocked}")
    return run


@pytest.fixture
def conversation(live_app):
    return live_app.store.create_conversation()


def seconds(run) -> str:
    t = run.timings
    return f"total {t['total_ms']} ms · planning {t['planning_ms']} · Laya {t['laya_ms']} ({t['laya_calls']} calls) · browser {t['browser_ms']} · page load {t['page_load_ms']}"


async def test_live_1_google_search_opens_the_official_python_docs(live_app, conversation):
    run = await ask(live_app, conversation, f"Search Google for the official Python documentation and open the official website. {ENGINE_HINT}")
    assert run.status == "done", run.error
    assert urlparse(run.page["url"]).hostname.endswith("python.org"), run.page["url"]
    print("TIMINGS", seconds(run))


async def test_live_2_wikipedia_article_by_url_and_title(live_app, conversation):
    run = await ask(live_app, conversation, "Open Wikipedia and find the article about artificial intelligence.")
    assert run.status == "done", run.error
    assert urlparse(run.page["url"]).path == "/wiki/Artificial_intelligence" and run.page["title"].startswith("Artificial intelligence")
    print("TIMINGS", seconds(run))


async def test_live_3_and_6_flights_then_follow_up(live_app, conversation):
    day = datetime.date.today() + datetime.timedelta(days=45)
    run = await ask(live_app, conversation, f"Find one-way direct flights from London to Madrid for one adult on {day:%B} {day.day}, {day.year}.")
    assert run.status in {"done", "partial"}, run.error
    assert "London to Madrid" in run.page["title"], run.page["title"]
    tfs = parse_qs(urlparse(run.page["url"]).query).get("tfs", [""])[0]
    decoded = base64.urlsafe_b64decode(tfs + "=" * (-len(tfs) % 4))
    assert day.isoformat().encode() in decoded, "the departure date in the results URL is not the requested one"
    tables = [c for c in run.result["cards"] if c["type"] == "table"]
    assert tables and tables[0]["rows"], "no flight rows were extracted (blocked or unavailable results are not a success)"
    assert all(row["cells"][-1] in run.page["text"] or re.search(r"\d", " ".join(row["cells"])) for row in tables[0]["rows"])
    print("TIMINGS flights", seconds(run))
    before = run.page["url"]
    follow = await ask(live_app, conversation, "Only show direct flights and sort by price.")
    assert follow.tab.id == run.tab.id and follow.parent_task_id == run.id  # the context was kept
    assert follow.page["url"] != before, "the results page did not change"
    print("TIMINGS follow-up", seconds(follow), follow.status)


async def test_live_4_google_images_cards(live_app, conversation):
    run = await ask(live_app, conversation, "Search Google Images for realistic tropical palm trees.")
    assert run.status == "done", run.error
    grid = next(c for c in run.result["cards"] if c["type"] == "images")
    assert len(grid["items"]) >= 8 and all(i["thumbnail_url"] for i in grid["items"])
    assert sum(1 for i in grid["items"] if i["source_url"]) >= 5
    print("TIMINGS", seconds(run))


async def test_live_5_research_three_sources(live_app, conversation):
    run = await ask(live_app, conversation, f"Find three websites offering free 3D models and compare them. {ENGINE_HINT}")
    assert run.status in {"done", "partial"}, run.error
    pages = {urlparse(n.url).hostname for n in run.notes if n.kind == "page"}
    assert len(pages) >= 3, pages
    assert "](http" in run.result["markdown"] or any(c["type"] == "sources" for c in run.result["cards"])
    print("TIMINGS", seconds(run))
