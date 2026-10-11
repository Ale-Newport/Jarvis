"""Tab-level behaviour against real Chrome and the fixture web: observation, validated actions, frames, shadow DOM, popups,
dialogs, freshness and cover checks."""

import asyncio

import pytest

from jarvis.browser import ActionFailed, StalePage

pytestmark = pytest.mark.asyncio(loop_scope="session")


async def open_tab(chrome, url):
    tab = await chrome.new_tab(url)
    page = await tab.observe()
    return tab, page


def find(page, label, kind="click"):
    matches = [a for a in page["actions"] if a["kind"] == kind and label.lower() in a["label"].lower()]
    return next((a for a in matches if a["label"].lower() == label.lower()), matches[0])


async def test_observation_is_indexed_and_typed(chrome, site):
    tab, page = await open_tab(chrome, f"{site.url}/search?q=python")
    assert page["title"].endswith("Fixture Search")
    assert {a["kind"] for a in page["actions"]} >= {"click", "fill", "wait"}
    assert all(a["id"].startswith("e") or a["id"] in {"wait", "scroll_down", "scroll_up"} for a in page["actions"])
    links = [a for a in page["actions"] if a.get("role") == "link"]
    assert any("docs.python.org" in a["label"] for a in links)
    assert page["fingerprint"] and page["page_key"] is not None
    await chrome.close_tab(tab)


async def test_fill_and_click_change_the_page_and_navigation_is_awaited(chrome, site):
    tab, page = await open_tab(chrome, f"{site.url}/wiki")
    box = find(page, "Search Fixturepedia", "fill")
    await tab.act(box, page, text="artificial intelligence")
    page = await tab.observe()
    assert any(a["kind"] == "fill" and a["value"] == "artificial intelligence" for a in page["actions"])
    await tab.act(find(page, "Search"), page)
    page = await tab.observe()  # settles through the navigation
    assert "Search results" in page["title"] and "/wiki/search" in page["url"]
    await chrome.close_tab(tab)


async def test_shadow_dom_controls_are_observed_and_clickable(chrome, site):
    tab, page = await open_tab(chrome, f"{site.url}/shadow")
    await tab.act(find(page, "Shadow action"), page)
    page = await tab.observe()
    assert "shadow clicked" in page["text"]
    await chrome.close_tab(tab)


async def test_same_origin_iframe_controls_are_observed_and_clickable(chrome, site):
    tab, page = await open_tab(chrome, f"{site.url}/frame")
    assert page["frames"] == 1
    await tab.act(find(page, "Frame action"), page)
    page = await tab.observe()
    assert "frame clicked" in page["text"]
    await chrome.close_tab(tab)


async def test_a_popup_tab_is_adopted(chrome, site):
    tab, page = await open_tab(chrome, f"{site.url}/popup")
    await tab.act(find(page, "Open details"), page)
    await tab.observe()
    for _ in range(40):
        popups = chrome.take_popups()
        if popups:
            break
        await asyncio.sleep(0.1)
    assert popups, "the new tab opened by the page was not adopted"
    await popups[0].wait_loaded()
    assert (await popups[0].observe())["title"] == "Popup target"
    for t in [tab, *popups]:
        await chrome.close_tab(t)


async def test_javascript_alerts_are_acknowledged_so_the_page_continues(chrome, site):
    tab, page = await open_tab(chrome, f"{site.url}/dialog")
    await tab.act(find(page, "Show notice"), page)
    page = await tab.observe()
    assert "after alert" in page["text"]
    assert tab.dialogs and tab.dialogs[-1]["type"] == "alert"
    await chrome.close_tab(tab)


async def test_a_covered_target_is_refused_not_clicked(chrome, site):
    tab, page = await open_tab(chrome, f"{site.url}/covered")
    with pytest.raises((StalePage, ActionFailed)):
        await tab.act(find(page, "Reveal"), page)
    page = await tab.observe()
    assert "waiting" in page["text"]  # nothing was clicked through the overlay
    await asyncio.sleep(1.0)
    page = await tab.observe()
    await tab.act(find(page, "Reveal"), page)
    assert "clicked" in (await tab.observe())["text"]
    await chrome.close_tab(tab)


async def test_a_stale_decision_is_never_executed(chrome, site):
    """The page re-renders its button after it was observed: the old decision must be refused, then a fresh one works."""
    tab, page = await open_tab(chrome, f"{site.url}/stale")
    stale_action = find(page, "Confirm order details")
    await asyncio.sleep(0.4)  # the page re-renders the node every 150 ms for a second
    with pytest.raises(StalePage):
        await tab.act(stale_action, page)
    await asyncio.sleep(1.2)
    page = await tab.observe()
    await tab.act(find(page, "Confirm order details"), page)
    assert "clicked" in (await tab.observe())["text"]
    await chrome.close_tab(tab)


async def test_navigation_history_and_reading(chrome, site):
    tab, _ = await open_tab(chrome, f"{site.url}/search?q=python")
    await tab.goto(f"{site.url}/s/python-docs")
    data = await tab.read(links=True)
    assert "official Python 3 documentation" in data["text"]
    assert any(link["href"].endswith("/") for link in data["links"])
    assert await tab.history(-1)
    assert "Fixture Search" in (await tab.observe())["title"]
    await chrome.close_tab(tab)
