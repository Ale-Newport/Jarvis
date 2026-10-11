"""OpenAI-compatible text model client: Ollama (default), LM Studio, OpenRouter, OpenAI or any compatible API.

This is the planning/reasoning model, not the browser-action model (that is Laya). It is used for: interpreting
the request, planning sub-goals, structured extraction and the final summary.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

log = logging.getLogger("jarvis.llm")

PRESETS = {
    "ollama": "http://127.0.0.1:11434/v1",
    "lmstudio": "http://127.0.0.1:1234/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
}
# Models that are not chat models, or too small to follow a planning schema.
NOT_CHAT = re.compile(r"(embed|nomic|bge-|minilm|rerank|whisper|tts|moderation|clip)", re.I)
PREFERRED = ("qwen3", "qwen2.5", "gpt-oss", "gemma4", "gemma3", "llama3.3", "llama3.2", "llama3.1", "mistral", "phi4", "deepseek-r1", "granite")


class LlmError(RuntimeError):
    """The text model is unreachable, misconfigured, or returned something unusable."""


def is_loopback(base_url: str) -> bool:
    return (urlparse(base_url).hostname or "") in {"localhost", "127.0.0.1", "::1"}


def disclosure_for(base_url: str) -> list[str]:
    if is_loopback(base_url):
        return ["Everything stays on this Mac: prompts and page text go only to the local model server."]
    host = urlparse(base_url).hostname or base_url
    return [
        f"Sent to {host}: your task text and follow-up messages.",
        f"Sent to {host}: text from the web pages the agent reads (titles, visible text, link text and URLs) when planning, extracting and summarising.",
        f"Sent to {host}: the page's visible form-field labels when planning a form interaction.",
        "Not sent: your Keychain, cookies, saved passwords, password and payment fields, screenshots, or files on disk.",
        "Browser actions and Laya decisions still run locally on this Mac.",
    ]


@dataclass
class LlmConfig:
    provider: str = "ollama"
    base_url: str = PRESETS["ollama"]
    model: str = ""
    api_key: str | None = None
    json_mode: str = "auto"  # auto | on | off
    reasoning: str = "off"  # default | off

    @property
    def remote(self) -> bool:
        return not is_loopback(self.base_url)


@dataclass
class LlmResult:
    text: str
    latency_ms: int
    usage: dict[str, Any] = field(default_factory=dict)
    model: str = ""


def strip_thinking(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S | re.I).strip()


def extract_json(text: str) -> Any:
    """Parse a JSON object from model output, tolerating fences, prose and trailing commas."""
    text = strip_thinking(text)
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S | re.I)
    candidates = [fenced.group(1)] if fenced else []
    candidates.append(text)
    for candidate in candidates:
        start = candidate.find("{")
        if start < 0:
            continue
        depth, in_string, escaped = 0, False, False
        for i in range(start, len(candidate)):
            ch = candidate[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
            elif ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    blob = candidate[start : i + 1]
                    for attempt in (blob, re.sub(r",\s*([}\]])", r"\1", blob)):
                        try:
                            return json.loads(attempt)
                        except json.JSONDecodeError:
                            continue
                    break
    raise LlmError("The model did not return valid JSON.")


class LlmClient:
    def __init__(self, config: LlmConfig):
        self.config = config
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(180, connect=5), limits=httpx.Limits(max_keepalive_connections=4))
        self.calls = 0
        self.total_ms = 0
        self._json_unsupported = False
        self._schema_unsupported = False

    async def aclose(self) -> None:
        await self._client.aclose()

    def configure(self, config: LlmConfig) -> None:
        self.config = config
        self._json_unsupported = False
        self._schema_unsupported = False

    # Plumbing ----------------------------------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        if "openrouter.ai" in self.config.base_url:
            headers["X-Title"] = "Jarvis"
        return headers

    def _body(self, messages: list[dict[str, str]], *, max_tokens: int, temperature: float, json_object: bool, stream: bool,
              schema: dict[str, Any] | None = None) -> dict[str, Any]:
        cfg = self.config
        body: dict[str, Any] = {"model": cfg.model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
        if stream:
            body["stream"] = True
        if json_object and cfg.json_mode != "off" and not self._json_unsupported:
            if schema and not self._schema_unsupported:
                # Constrained decoding: the server can only emit text that matches the schema.
                body["response_format"] = {"type": "json_schema", "json_schema": {"name": "reply", "schema": schema}}
            else:
                body["response_format"] = {"type": "json_object"}
        if cfg.reasoning == "off":
            if cfg.remote and "openrouter.ai" in cfg.base_url:
                body["reasoning"] = {"enabled": False}
            elif cfg.remote and "api.openai.com" in cfg.base_url:
                pass  # non-reasoning models reject the parameter
            elif not cfg.remote:
                body["reasoning_effort"] = "none"  # Ollama / LM Studio turn thinking off with this
        return body

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        url = self.config.base_url.rstrip("/") + "/chat/completions"
        for attempt in range(3):
            try:
                response = await self._client.post(url, json=body, headers=self._headers())
            except httpx.ConnectError as error:
                raise LlmError(self._unreachable()) from error
            except httpx.HTTPError as error:
                raise LlmError(f"The text model request failed: {error}") from error
            if response.status_code in {429, 503, 529} and attempt < 2:
                await asyncio.sleep(0.6 * 2**attempt)
                continue
            if response.status_code == 400 and "response_format" in body and any(w in response.text.lower() for w in ("response_format", "json_schema", "schema")):
                if body["response_format"].get("type") == "json_schema":
                    self._schema_unsupported = True  # no schema support: ask for a plain JSON object instead
                    body = {**body, "response_format": {"type": "json_object"}}
                else:
                    self._json_unsupported = True  # the server has no JSON mode; fall back to prompt-only JSON
                    body = {k: v for k, v in body.items() if k != "response_format"}
                continue
            if response.status_code == 400 and "reasoning" in response.text.lower() and ("reasoning_effort" in body or "reasoning" in body):
                body = {k: v for k, v in body.items() if k not in {"reasoning_effort", "reasoning"}}
                continue
            if response.status_code == 404 and not self.config.model:
                raise LlmError("No text model is selected. Choose one in Settings.")
            if response.is_error:
                raise LlmError(self._http_error(response))
            return response.json()
        raise LlmError("The text model is unavailable.")

    def _unreachable(self) -> str:
        if self.config.provider == "ollama" or "11434" in self.config.base_url:
            return "Ollama is not running. Start it (Settings → AI model → Start Ollama) or choose another provider."
        return f"Could not reach the text model at {self.config.base_url}."

    @staticmethod
    def _http_error(response: httpx.Response) -> str:
        detail = ""
        try:
            data = response.json()
            err = data.get("error", data)
            detail = err.get("message") if isinstance(err, dict) else str(err)
        except ValueError:
            detail = response.text[:200]
        if response.status_code in {401, 403}:
            return "The text model provider rejected the API key. Check it in Settings."
        if response.status_code == 404:
            return f"The text model was not found ({detail or 'HTTP 404'}). Pull or select a model in Settings."
        return f"The text model returned HTTP {response.status_code}: {detail}"

    # Calls --------------------------------------------------------------------------------------------------

    async def chat(
        self, messages: list[dict[str, str]], *, max_tokens: int = 1500, temperature: float = 0.1, json_object: bool = False,
        schema: dict[str, Any] | None = None,
    ) -> LlmResult:
        started = time.perf_counter()
        data = await self._post(self._body(messages, max_tokens=max_tokens, temperature=temperature, json_object=json_object, stream=False, schema=schema))
        try:
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as error:
            raise LlmError("The text model returned an unexpected response.") from error
        ms = round((time.perf_counter() - started) * 1000)
        self.calls += 1
        self.total_ms += ms
        return LlmResult(strip_thinking(text), ms, data.get("usage", {}), data.get("model", self.config.model))

    async def chat_json(
        self, system: str, user: str, *, max_tokens: int = 1500, attempts: int = 2, validate: Callable[[Any], Any] | None = None,
        schema: dict[str, Any] | None = None,
    ) -> tuple[Any, LlmResult]:
        """One JSON object back. Retries with the parse error fed back, up to `attempts` times."""
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        last_error: Exception | None = None
        for _ in range(attempts):
            result = await self.chat(messages, max_tokens=max_tokens, json_object=True, schema=schema)
            try:
                data = extract_json(result.text)
                return (validate(data) if validate else data), result
            except (LlmError, ValueError, KeyError, TypeError) as error:
                last_error = error
                messages = [*messages, {"role": "assistant", "content": result.text[:1500]},
                            {"role": "user", "content": f"That was not usable ({error}). Reply again with ONLY the corrected JSON object."}]
        raise LlmError(f"The text model could not produce a valid plan: {last_error}")

    async def stream(self, messages: list[dict[str, str]], *, max_tokens: int = 2000, temperature: float = 0.2) -> AsyncIterator[str]:
        body = self._body(messages, max_tokens=max_tokens, temperature=temperature, json_object=False, stream=True)
        url = self.config.base_url.rstrip("/") + "/chat/completions"
        started = time.perf_counter()
        in_think = False
        try:
            async with self._client.stream("POST", url, json=body, headers=self._headers()) as response:
                if response.is_error:
                    await response.aread()
                    raise LlmError(self._http_error(response))
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        delta = json.loads(payload)["choices"][0].get("delta", {}).get("content") or ""
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    if "<think>" in delta:
                        in_think = True
                    if not in_think and delta:
                        yield delta
                    if "</think>" in delta:
                        in_think = False
        except httpx.ConnectError as error:
            raise LlmError(self._unreachable()) from error
        except httpx.HTTPError as error:
            raise LlmError(f"The text model request failed: {error}") from error
        finally:
            self.calls += 1
            self.total_ms += round((time.perf_counter() - started) * 1000)

    # Discovery ------------------------------------------------------------------------------------------------

    async def list_models(self) -> list[str]:
        base = self.config.base_url.rstrip("/")
        try:
            response = await self._client.get(base + "/models", headers=self._headers(), timeout=6)
            if response.is_success:
                names = [m["id"] for m in response.json().get("data", []) if "id" in m]
                return [n for n in names if not NOT_CHAT.search(n)]
        except (httpx.HTTPError, ValueError):
            pass
        if self.config.provider == "ollama" or "11434" in base:
            root = base[:-3] if base.endswith("/v1") else base
            try:
                response = await self._client.get(root + "/api/tags", timeout=4)
                return [m["name"] for m in response.json().get("models", []) if not NOT_CHAT.search(m["name"])]
            except (httpx.HTTPError, ValueError, KeyError):
                return []
        return []

    async def ping(self) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            await self.chat([{"role": "user", "content": "Reply with the single word: ok"}], max_tokens=8, temperature=0)
        except LlmError as error:
            return {"ok": False, "latency_ms": round((time.perf_counter() - started) * 1000), "error": str(error)}
        return {"ok": True, "latency_ms": round((time.perf_counter() - started) * 1000)}


def pick_default_model(models: list[str]) -> str | None:
    """Best available chat model by family preference, favouring mid-size tags."""
    if not models:
        return None

    def rank(name: str) -> tuple[int, int]:
        lowered = name.lower()
        family = next((i for i, key in enumerate(PREFERRED) if key in lowered), len(PREFERRED))
        tiny = bool(re.search(r"(:|-)(0\.?\d*b|1b|1\.5b|2b|270m|135m)\b", lowered))
        return (family + (20 if tiny else 0), len(name))

    return sorted(models, key=rank)[0]


async def detect_local_servers() -> list[dict[str, Any]]:
    found = []
    async with httpx.AsyncClient(timeout=1.5) as client:
        for provider, base in (("ollama", PRESETS["ollama"]), ("lmstudio", PRESETS["lmstudio"])):
            try:
                r = await client.get(base + "/models")
                if r.is_success:
                    models = [m["id"] for m in r.json().get("data", []) if not NOT_CHAT.search(m["id"])]
                    found.append({"provider": provider, "base_url": base, "models": models, "reachable": True})
            except (httpx.HTTPError, ValueError):
                continue
    return found


async def ollama_pull(model: str, on_progress: Callable[[dict[str, Any]], Any], base: str = "http://127.0.0.1:11434") -> None:
    async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=5)) as client:
        try:
            async with client.stream("POST", f"{base}/api/pull", json={"model": model, "stream": True}) as response:
                if response.is_error:
                    await response.aread()
                    raise LlmError(f"Ollama could not pull {model}: HTTP {response.status_code} {response.text[:160]}")
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    if "error" in data:
                        raise LlmError(f"Ollama could not pull {model}: {data['error']}")
                    result = on_progress({"status": data.get("status", ""), "completed": data.get("completed", 0),
                                          "total": data.get("total", 0), "done": data.get("status") == "success"})
                    if asyncio.iscoroutine(result):
                        await result
        except httpx.ConnectError as error:
            raise LlmError("Ollama is not running.") from error
