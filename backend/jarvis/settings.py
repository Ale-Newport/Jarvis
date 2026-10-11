"""User settings (SQLite) and secrets (macOS Keychain). Secrets are never stored in the database or returned."""

from __future__ import annotations

import copy
import logging
from typing import Any

from .laya_engine import DEFAULT_MODEL
from .llm import PRESETS

log = logging.getLogger("jarvis.settings")

SERVICE = "com.jarvis.browseragent"
SECRET_NAMES = {"llm_api_key"}

DEFAULTS: dict[str, Any] = {
    "appearance": "system",
    "chrome": {"mode": "managed", "path": None, "keep_open_on_quit": False, "existing_debug_port": None},
    "llm": {"provider": "ollama", "base_url": PRESETS["ollama"], "model": "", "json_mode": "auto", "reasoning": "off"},
    "laya": {"model": DEFAULT_MODEL},
    "agent": {"max_steps": 60, "max_minutes": 10, "confirm_sensitive": True, "allow_local_urls": False, "screenshots": "on_demand"},
}

ENUMS = {
    "appearance": {"system", "light", "dark"},
    "chrome.mode": {"managed", "existing"},
    "llm.provider": {"ollama", "lmstudio", "openrouter", "openai", "custom"},
    "llm.json_mode": {"auto", "on", "off"},
    "llm.reasoning": {"default", "off"},
    "agent.screenshots": {"off", "on_demand", "per_step"},
}
TYPES = {
    "chrome.path": (str, type(None)), "chrome.keep_open_on_quit": (bool,), "chrome.existing_debug_port": (int, type(None)),
    "llm.base_url": (str,), "llm.model": (str,), "laya.model": (str,),
    "agent.max_steps": (int,), "agent.max_minutes": (int, float), "agent.confirm_sensitive": (bool,), "agent.allow_local_urls": (bool,),
}
RANGES = {"agent.max_steps": (1, 300), "agent.max_minutes": (0.5, 120)}


class SettingsError(ValueError):
    pass


class Secrets:
    """Keychain-backed secrets. If no Keychain is available (tests, odd environments) values stay in memory only."""

    def __init__(self) -> None:
        self._memory: dict[str, str] = {}
        self.backend = "keychain"
        try:
            import keyring

            self._keyring = keyring
            name = type(keyring.get_keyring()).__name__
            if "fail" in name.lower() or "null" in name.lower():
                raise RuntimeError(name)
        except Exception as error:
            log.warning("No usable Keychain (%s); secrets will be kept in memory only", error)
            self._keyring = None
            self.backend = "memory"

    def get(self, name: str) -> str | None:
        if self._keyring:
            try:
                return self._keyring.get_password(SERVICE, name) or self._memory.get(name)
            except Exception as error:
                log.warning("Keychain read failed: %s", error)
        return self._memory.get(name)

    def set(self, name: str, value: str) -> None:
        if self._keyring:
            try:
                self._keyring.set_password(SERVICE, name, value)
                self._memory.pop(name, None)
                return
            except Exception as error:
                log.warning("Keychain write failed (%s); keeping the secret in memory for this session", error)
                self.backend = "memory"
        self._memory[name] = value

    def delete(self, name: str) -> None:
        self._memory.pop(name, None)
        if self._keyring:
            try:
                self._keyring.delete_password(SERVICE, name)
            except Exception:
                pass


def merge(base: dict[str, Any], patch: dict[str, Any], path: str = "") -> dict[str, Any]:
    for key, value in patch.items():
        dotted = f"{path}.{key}" if path else key
        if key not in base:
            raise SettingsError(f"Unknown setting {dotted!r}")
        if isinstance(base[key], dict) and isinstance(value, dict):
            merge(base[key], value, dotted)
            continue
        if dotted in ENUMS and value not in ENUMS[dotted]:
            raise SettingsError(f"{dotted} must be one of {sorted(ENUMS[dotted])}")
        if dotted in TYPES:
            allowed = TYPES[dotted]
            if not isinstance(value, allowed) or (isinstance(value, bool) and bool not in allowed):
                raise SettingsError(f"{dotted} has the wrong type")
        if dotted in RANGES and not RANGES[dotted][0] <= value <= RANGES[dotted][1]:
            raise SettingsError(f"{dotted} must be between {RANGES[dotted][0]} and {RANGES[dotted][1]}")
        base[key] = value
    return base


class Settings:
    def __init__(self, store: Any, secrets: Secrets | None = None):
        self.store = store
        self.secrets = secrets or Secrets()
        self.data = copy.deepcopy(DEFAULTS)
        saved = store.load_settings()
        for key, value in saved.items():
            if key in self.data:
                try:
                    merge(self.data, {key: value})
                except SettingsError as error:
                    log.warning("ignoring invalid saved setting %s: %s", key, error)

    def get(self, path: str) -> Any:
        node: Any = self.data
        for part in path.split("."):
            node = node[part]
        return node

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        candidate = copy.deepcopy(self.data)
        merge(candidate, {k: v for k, v in patch.items() if k != "api_key_set"} if "llm" not in patch else
              {**{k: v for k, v in patch.items() if k != "llm"}, "llm": {k: v for k, v in patch["llm"].items() if k != "api_key_set"}})
        self.data = candidate
        for key, value in self.data.items():
            self.store.save_setting(key, value)
        return self.public()

    def public(self) -> dict[str, Any]:
        out = copy.deepcopy(self.data)
        out["llm"]["api_key_set"] = bool(self.secrets.get("llm_api_key"))
        return out
