"""The local HTTP/WebSocket API contract (docs/API.md): authentication, origin checks, settings, conversations, events."""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from jarvis.app import App
from jarvis.server import create_app
from jarvis.settings import Secrets

TOKEN = "t" * 64
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
HOST = {"host": f"127.0.0.1:{PORT}"}


@pytest.fixture
def core(tmp_path):
    secrets = Secrets()
    secrets._keyring = None
    secrets.backend = "memory"
    return App(tmp_path / "data", downloads_dir=tmp_path / "downloads", secrets=secrets)


@pytest.fixture
def api(core):
    stopped = []
    app = create_app(core, TOKEN, lambda: PORT, lambda: stopped.append(True))
    client = TestClient(app, base_url=BASE)
    client.stopped = stopped
    return client


def test_health_is_open_everything_else_needs_the_token(api):
    assert api.get("/health").json()["status"] == "ready"
    assert api.get("/api/status").status_code == 401
    assert api.get("/api/status", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert api.get("/api/status", headers=AUTH).status_code == 200


def test_requests_for_other_hosts_or_origins_are_refused(api):
    assert api.get("/api/status", headers={**AUTH, "Host": "evil.example"}).status_code == 403  # DNS rebinding
    assert api.get("/api/status", headers={**AUTH, "Origin": "https://evil.example"}).status_code == 403
    ok = api.get("/api/status", headers={**AUTH, "Origin": "tauri://localhost"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "tauri://localhost"


def test_the_webview_can_read_health_cross_origin(api):
    r = api.get("/health", headers={"Origin": "tauri://localhost"})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "tauri://localhost"


def test_cors_preflight_works_without_credentials_for_the_webview_only(api):
    ok = api.options("/api/settings", headers={"Origin": "tauri://localhost", "Access-Control-Request-Method": "PUT"})
    assert ok.status_code == 204 and "PUT" in ok.headers["access-control-allow-methods"] and "authorization" in ok.headers["access-control-allow-headers"]
    assert api.options("/api/settings", headers={"Origin": "https://evil.example"}).status_code == 403


def test_status_and_onboarding_describe_the_machine(api):
    status = api.get("/api/status", headers=AUTH).json()
    assert status["arch"] in {"arm64", "x86_64"} and {"chrome", "laya", "llm", "version", "mlx_supported"} <= set(status)
    checks = api.post("/api/onboarding/check", headers=AUTH).json()
    ids = [c["id"] for c in checks["checks"]]
    assert ids == ["apple_silicon", "macos", "chrome", "python", "laya_model", "text_model", "chrome_connection"]
    assert all(c["status"] in {"ok", "warn", "error", "pending"} for c in checks["checks"]) and isinstance(checks["ready"], bool)


def test_settings_validate_and_persist_and_secrets_stay_out(api, core):
    settings = api.get("/api/settings", headers=AUTH).json()
    assert settings["chrome"]["mode"] == "managed" and settings["llm"]["api_key_set"] is False
    updated = api.put("/api/settings", headers=AUTH, json={"agent": {"max_steps": 25}, "llm": {"model": "qwen3:8b"}}).json()
    assert updated["agent"]["max_steps"] == 25 and core.llm.config.model == "qwen3:8b"
    bad = api.put("/api/settings", headers=AUTH, json={"agent": {"max_steps": -1}})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_setting"
    assert api.put("/api/secrets/llm_api_key", headers=AUTH, json={"value": "sk-secret"}).json() == {"name": "llm_api_key", "set": True}
    assert api.get("/api/settings", headers=AUTH).json()["llm"]["api_key_set"] is True and "sk-secret" not in api.get("/api/settings", headers=AUTH).text
    assert core.llm.config.api_key == "sk-secret"
    assert api.put("/api/secrets/other", headers=AUTH, json={"value": "x"}).status_code == 404
    api.delete("/api/secrets/llm_api_key", headers=AUTH)
    assert api.get("/api/settings", headers=AUTH).json()["llm"]["api_key_set"] is False


def test_conversation_lifecycle(api):
    conv = api.post("/api/conversations", headers=AUTH, json={}).json()
    assert api.patch(f"/api/conversations/{conv['id']}", headers=AUTH, json={"title": "Flights"}).json()["title"] == "Flights"
    detail = api.get(f"/api/conversations/{conv['id']}", headers=AUTH).json()
    assert detail["messages"] == [] and detail["tasks"] == []
    assert api.post(f"/api/conversations/{conv['id']}/clear", headers=AUTH).json() == {"ok": True}
    assert api.delete(f"/api/conversations/{conv['id']}", headers=AUTH).json() == {"ok": True}
    assert api.get(f"/api/conversations/{conv['id']}", headers=AUTH).status_code == 404


def test_messages_are_validated_and_only_one_task_runs_at_a_time(api, core):
    conv = api.post("/api/conversations", headers=AUTH, json={}).json()
    assert api.post(f"/api/conversations/{conv['id']}/messages", headers=AUTH, json={"text": "  "}).status_code == 400
    assert api.post(f"/api/conversations/{conv['id']}/messages", headers=AUTH, json={"text": "x" * 9000}).json()["error"]["code"] == "too_long"
    assert api.post("/api/conversations/nope/messages", headers=AUTH, json={"text": "hi"}).status_code == 404

    class Busy:
        finished = False

    core.running = Busy()
    busy = api.post(f"/api/conversations/{conv['id']}/messages", headers=AUTH, json={"text": "open example.com"})
    assert busy.status_code == 409 and busy.json()["error"]["code"] == "task_running"


def test_chrome_endpoints_validate_input(api):
    assert api.get("/api/chrome/status", headers=AUTH).json()["mode"] == "managed"
    assert api.post("/api/chrome/connect", headers=AUTH, json={"mode": "other"}).status_code == 400
    assert api.post("/api/chrome/reset-profile", headers=AUTH, json={}).status_code == 400
    assert api.put("/api/chrome/path", headers=AUTH, json={"path": "/Applications/Safari.app"}).status_code == 400
    assert api.post("/api/tasks/unknown/cancel", headers=AUTH).status_code == 409


def test_only_files_in_the_downloads_folder_can_be_revealed(api, core, tmp_path):
    outside = tmp_path / "secret.txt"
    outside.write_text("x")
    assert api.post("/api/open-path", headers=AUTH, json={"path": str(outside)}).status_code == 403
    assert api.post("/api/open-path", headers=AUTH, json={"path": str(core.downloads_dir / "missing.png")}).status_code == 404


def test_shutdown_is_acknowledged_then_performed(api):
    assert api.post("/api/shutdown", headers=AUTH).json() == {"ok": True}


def test_websocket_requires_the_token_subprotocol_and_streams_events(api, core):
    with pytest.raises(WebSocketDisconnect):
        with api.websocket_connect("/api/events", subprotocols=["jarvis.v1", "bearer.wrong"], headers=dict(HOST)):
            pass
    with api.websocket_connect("/api/events", subprotocols=["jarvis.v1", f"bearer.{TOKEN}"], headers=dict(HOST)) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        core.bus.publish("notice", {"level": "info", "message": "hi"})
        event = ws.receive_json()
        assert event["type"] == "notice" and event["seq"] > hello["seq"] - 1 and event["data"]["message"] == "hi"


def test_a_websocket_for_another_host_is_refused_even_with_the_right_token(api):
    with pytest.raises(WebSocketDisconnect):
        with api.websocket_connect("/api/events", subprotocols=["jarvis.v1", f"bearer.{TOKEN}"], headers={"host": "evil.example"}):
            pass
