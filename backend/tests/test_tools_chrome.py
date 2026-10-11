import base64

import pytest

from jarvis import chrome
from jarvis.goal_runner import SubGoal
from jarvis.tools import humanize_dates, safe_name, save_file, search_url, unique_path, verify_requirements


def test_search_urls_for_each_engine_and_kind():
    assert search_url("palm trees", "images") == "https://www.google.com/search?q=palm+trees&hl=en&tbm=isch"
    assert search_url("a b", "web", "duckduckgo") == "https://duckduckgo.com/?q=a+b"
    assert search_url("tour eiffel", "maps").startswith("https://www.google.com/maps/search/tour%20eiffel")
    assert "bing.com/images/search" in search_url("x", "images", "bing")


def test_iso_dates_become_the_form_a_calendar_shows():
    assert humanize_dates("depart 2026-11-20, return 2026-12-04") == "depart November 20, 2026, return December 4, 2026"
    assert humanize_dates("1 adult") == "1 adult"


def test_requirements_are_verified_against_the_final_page_not_the_models_word():
    page = {"title": "London to Madrid", "url": "https://x.test/?d=2026-11-20", "text": "Fri, Nov 20\nNonstop\n1 passenger",
            "actions": [{"label": "Where from?", "value": "London"}, {"label": "Where to?", "value": "Madrid"}]}
    goal = SubGoal("g", [{"what": "from", "value": "London"}, {"what": "to", "value": "Madrid"}, {"what": "date", "value": "November 20, 2026"},
                         {"what": "pax", "value": "1 adult"}, {"what": "stops", "value": "Nonstop only"}, {"what": "cabin", "value": "Business"}])
    assert verify_requirements(goal, page) == ["cabin = Business"]


async def test_downloads_decode_data_urls_and_never_overwrite(tmp_path):
    url = "data:image/png;base64," + base64.b64encode(b"\x89PNG-bytes").decode()
    first, size = await save_file(url, tmp_path, "Palm photo #1", None)
    second, _ = await save_file(url, tmp_path, "Palm photo #1", None)
    assert first.name == "Palm_photo_1.png" and size == 10 and first.read_bytes() == b"\x89PNG-bytes" and second != first
    assert safe_name("../../etc/passwd") == "etcpasswd" and unique_path(tmp_path, "Palm_photo_1.png").name != "Palm_photo_1.png"


def test_chrome_bundle_validation(tmp_path):
    found = chrome.find_chrome()
    if found:
        assert found.binary.exists() and found.bundle_id.startswith("com.google.Chrome")
    with pytest.raises(chrome.ChromeError):
        chrome.inspect_app(tmp_path / "Nothing.app")
    fake = tmp_path / "Other.app" / "Contents"
    fake.mkdir(parents=True)
    import plistlib

    (fake / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.apple.Safari"}))
    with pytest.raises(chrome.ChromeError, match="not Google Chrome"):
        chrome.inspect_app(tmp_path / "Other.app")


def test_existing_session_probe_explains_how_to_enable_debugging(monkeypatch, tmp_path):
    monkeypatch.setattr(chrome, "chrome_processes", lambda exclude_profile=None: [123])
    monkeypatch.setattr(chrome, "read_active_port", lambda root: None)
    monkeypatch.setattr(chrome, "port_is_live", lambda port, *a, **k: False)
    monkeypatch.setattr(chrome, "remote_debugging_toggle", lambda root=chrome.DEFAULT_CHROME_ROOT: False)
    probe = chrome.probe_existing(tmp_path)
    assert probe.running and probe.debugging == "off" and probe.ws_url is None
    assert "chrome://inspect/#remote-debugging" in chrome.HOW_TO_ENABLE and "Allow" in chrome.HOW_TO_ENABLE
    monkeypatch.setattr(chrome, "chrome_processes", lambda exclude_profile=None: [])
    assert not chrome.probe_existing(tmp_path).running
