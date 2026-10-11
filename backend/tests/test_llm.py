"""The OpenAI-compatible client: provider quirks, structured output fallback, streaming, discovery."""

import json

import httpx
import pytest

from jarvis.llm import LlmClient, LlmConfig, LlmError, disclosure_for, is_loopback, pick_default_model


def client_with(handler, **config) -> LlmClient:
    c = LlmClient(LlmConfig(model="m", **config))
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return c


def ok(content='{"a": 1}', status=200):
    return httpx.Response(status, json={"choices": [{"message": {"content": content}}], "usage": {"total_tokens": 5}, "model": "m"})


async def test_json_schema_is_requested_and_the_reply_is_parsed():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return ok()

    data, result = await client_with(handler).chat_json("sys", "user", schema={"type": "object"})
    assert data == {"a": 1} and result.usage["total_tokens"] == 5
    assert seen[0]["response_format"]["type"] == "json_schema" and seen[0]["reasoning_effort"] == "none" and seen[0]["messages"][0]["role"] == "system"


async def test_a_server_without_schema_support_is_downgraded_once_then_remembered():
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body.get("response_format", {}).get("type"))
        if body.get("response_format", {}).get("type") == "json_schema":
            return httpx.Response(400, json={"error": {"message": "response_format json_schema is not supported"}})
        return ok()

    c = client_with(handler)
    await c.chat_json("s", "u", schema={"type": "object"})
    await c.chat_json("s", "u", schema={"type": "object"})
    assert calls == ["json_schema", "json_object", "json_object"]


async def test_a_server_without_any_json_mode_falls_back_to_prompt_only():
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append("response_format" in body)
        return httpx.Response(400, json={"error": {"message": "unknown field response_format"}}) if "response_format" in body else ok()

    await client_with(handler).chat_json("s", "u")
    assert calls == [True, False]


async def test_unparseable_output_is_retried_with_feedback_then_reported():
    prompts = []

    def handler(request):
        prompts.append(json.loads(request.content)["messages"])
        return ok("I think the answer is blue")

    with pytest.raises(LlmError, match="valid plan"):
        await client_with(handler).chat_json("s", "u", attempts=2)
    assert len(prompts) == 2 and "not usable" in prompts[1][-1]["content"]


async def test_errors_are_translated_into_actionable_messages():
    unauthorized = client_with(lambda r: httpx.Response(401, json={"error": {"message": "bad key"}}), provider="openrouter", base_url="https://openrouter.ai/api/v1")
    with pytest.raises(LlmError, match="API key"):
        await unauthorized.chat([{"role": "user", "content": "x"}])
    missing = client_with(lambda r: httpx.Response(404, json={"error": {"message": "model 'm' not found"}}))
    with pytest.raises(LlmError, match="not found"):
        await missing.chat([{"role": "user", "content": "x"}])

    def refuse(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(LlmError, match="Ollama is not running"):
        await client_with(refuse).chat([{"role": "user", "content": "x"}])


async def test_rate_limits_are_retried():
    attempts = []

    def handler(request):
        attempts.append(1)
        return httpx.Response(429, json={}) if len(attempts) < 3 else ok("fine")

    result = await client_with(handler).chat([{"role": "user", "content": "x"}])
    assert result.text == "fine" and len(attempts) == 3


async def test_streaming_yields_deltas_and_hides_thinking():
    lines = ['data: {"choices":[{"delta":{"content":"<think>pl"}}]}', 'data: {"choices":[{"delta":{"content":"an</think>"}}]}',
             'data: {"choices":[{"delta":{"content":"Hello "}}]}', 'data: {"choices":[{"delta":{"content":"world"}}]}', "data: [DONE]"]
    c = client_with(lambda r: httpx.Response(200, content=("\n\n".join(lines) + "\n\n").encode(), headers={"content-type": "text/event-stream"}))
    assert "".join([chunk async for chunk in c.stream([{"role": "user", "content": "x"}])]) == "Hello world"


async def test_remote_providers_get_their_own_reasoning_switches_and_local_ones_none_of_that():
    bodies = []

    def handler(request):
        bodies.append((str(request.url), json.loads(request.content), request.headers.get("authorization")))
        return ok("x")

    await client_with(handler, provider="openrouter", base_url="https://openrouter.ai/api/v1", api_key="k").chat([{"role": "user", "content": "x"}])
    url, body, auth = bodies[0]
    assert url.startswith("https://openrouter.ai/api/v1/chat/completions") and body["reasoning"] == {"enabled": False} and auth == "Bearer k"
    assert "reasoning_effort" not in body


async def test_model_listing_filters_embedding_models():
    c = client_with(lambda r: httpx.Response(200, json={"data": [{"id": "qwen3:8b"}, {"id": "nomic-embed-text"}, {"id": "llama3.1:8b"}]}))
    assert await c.list_models() == ["qwen3:8b", "llama3.1:8b"]


def test_default_model_prefers_capable_families_over_tiny_ones():
    assert pick_default_model(["gemma3:270m", "llama3.1:8b", "qwen3:8b"]) == "qwen3:8b"
    assert pick_default_model(["tinyllama:1b"]) == "tinyllama:1b" and pick_default_model([]) is None


def test_disclosure_distinguishes_local_from_remote():
    assert is_loopback("http://127.0.0.1:11434/v1") and not is_loopback("https://openrouter.ai/api/v1")
    assert len(disclosure_for("http://localhost:1234/v1")) == 1 and "stays on this Mac" in disclosure_for("http://localhost:1234/v1")[0]
    remote = " ".join(disclosure_for("https://openrouter.ai/api/v1"))
    assert "openrouter.ai" in remote and "Not sent" in remote and "cookies" in remote
