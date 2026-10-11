# Jarvis local API contract (v1)

The Python backend (`backend/jarvis`) is a sidecar process owned by the Tauri shell. The React UI talks to it
directly over HTTP + one WebSocket. This document is the contract between the two. If code and this file disagree,
fix the code or fix this file in the same change.

## Process lifecycle and authentication

* Tauri generates a random 256-bit token (hex) per app launch and starts the sidecar with
  `JARVIS_TOKEN=<token>` and `JARVIS_DATA_DIR=<~/Library/Application Support/Jarvis>` in its environment.
  Optional: `JARVIS_PORT` (default `0` = pick a free port).
* The sidecar binds **127.0.0.1 only**. When it is listening it prints exactly one JSON line to **stdout**:
  `{"event":"ready","port":53211,"version":"0.1.0","pid":1234}`; all logs go to stderr / the log file.
* Tauri exposes `invoke("backend_info") -> {base_url: "http://127.0.0.1:53211", token: "<hex>"}` to the webview
  (it resolves once the ready line has been seen; it rejects with a message if the sidecar exits early).
* Every HTTP request except `GET /health` carries `Authorization: Bearer <token>`.
* The WebSocket (`/api/events`) is authenticated with a subprotocol: the client opens
  `new WebSocket(url, ["jarvis.v1", "bearer." + token])`; the server accepts `jarvis.v1`.
* Requests whose `Host` is not `127.0.0.1:<port>` / `localhost:<port>` are rejected (DNS rebinding), and the
  `Origin` header (when present) must be `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`
  or, in dev, `http://localhost:1420` / `http://127.0.0.1:1420`.
* On quit, Tauri sends `POST /api/shutdown` (graceful: cancels tasks, closes managed Chrome per setting, flushes DB),
  waits ≤ 5 s, then sends SIGTERM, then SIGKILL. The sidecar also exits by itself if its parent dies
  (it watches the parent pid).

Errors are JSON `{"error": {"code": "string", "message": "human readable"}}` with an HTTP status ≥ 400.

## System, onboarding, settings

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/health` | → `{"status":"ready","version":"0.1.0"}` (no auth) |
| GET | `/api/status` | → `SystemStatus` |
| POST | `/api/onboarding/check` | → `{"checks": Check[], "ready": bool}` (re-runs all checks) |
| GET | `/api/settings` | → `Settings` |
| PUT | `/api/settings` | partial `Settings` (deep-merged) → `Settings` |
| PUT | `/api/secrets/{name}` | `{"value": "..."}` → `{"name","set":true}`; names: `llm_api_key` (stored in macOS Keychain, never returned) |
| DELETE | `/api/secrets/{name}` | → `{"name","set":false}` |
| POST | `/api/shutdown` | → `{"ok":true}` |

```ts
type Check = {
  id: "apple_silicon" | "macos" | "chrome" | "python" | "laya_model" | "text_model" | "chrome_connection";
  title: string;
  status: "ok" | "warn" | "error" | "pending";
  detail: string;           // short, human readable
  action?: { id: string; label: string };  // e.g. {"id":"download_laya","label":"Download model (850 MB)"}
};
type SystemStatus = {
  version: string;
  arch: "arm64" | "x86_64";
  macos: string;
  mlx_supported: boolean;
  chrome: ChromeStatus;
  laya: LayaStatus;
  llm: LlmStatus;
  busy_task_id: string | null;
};
type Settings = {
  appearance: "system" | "light" | "dark";
  chrome: {
    mode: "managed" | "existing";
    path: string | null;                 // null = auto-detect
    keep_open_on_quit: boolean;          // managed mode only (default false)
    existing_debug_port: number | null;  // optional hint, e.g. 9222
  };
  llm: {
    provider: "ollama" | "lmstudio" | "openrouter" | "openai" | "custom";
    base_url: string;                    // OpenAI-compatible, e.g. http://127.0.0.1:11434/v1
    model: string;
    api_key_set: boolean;                // secret itself lives in the Keychain
    json_mode: "auto" | "on" | "off";
    reasoning: "default" | "off";
  };
  laya: { model: string };               // default "aac6fef/laya-typed-decisions-mlx"
  agent: {
    max_steps: number;                   // browser actions per task, default 60
    max_minutes: number;                 // wall clock per task, default 10
    confirm_sensitive: boolean;          // default true; always true for payments
    allow_local_urls: boolean;           // default false
    screenshots: "off" | "on_demand" | "per_step";  // default "on_demand"
  };
};
```

## Chrome

```ts
type ChromeStatus = {
  installed: boolean;
  path: string | null;
  version: string | null;
  mode: "managed" | "existing";
  state: "disconnected" | "connecting" | "awaiting_permission" | "connected" | "error";
  // "existing" mode specifics:
  debugging: "unknown" | "off" | "on";    // is remote debugging reachable?
  how_to_enable?: string | null;          // markdown steps when debugging is off
  profile_dir?: string | null;            // managed mode automation profile
  tabs: { id: string; title: string; url: string; active: boolean }[];  // tabs opened by Jarvis
  error?: string | null;
};
```

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/api/chrome/status` | → `ChromeStatus` |
| POST | `/api/chrome/connect` | `{"mode"?: "managed"|"existing"}` → `ChromeStatus` (long poll ≤ 60 s; in existing mode may sit in `awaiting_permission` while Chrome shows its "Allow remote debugging?" sheet — the call keeps waiting, status events keep flowing) |
| POST | `/api/chrome/disconnect` | → `ChromeStatus` |
| POST | `/api/chrome/reset-profile` | `{"confirm": true}` → `ChromeStatus` (deletes the managed automation profile; refused while a task runs) |
| POST | `/api/chrome/focus` | → `ChromeStatus` (brings the agent's current tab to the front: "Open current browser tab") |
| PUT | `/api/chrome/path` | `{"path": "/Applications/Google Chrome.app"}` → `ChromeStatus` (validates it is Chrome) |

## Laya (local decision model) and the text model

```ts
type LayaStatus = {
  model: string;
  downloaded: boolean;
  size_bytes: number | null;
  state: "missing" | "idle" | "downloading" | "loading" | "ready" | "unsupported" | "error";  // idle = downloaded, not loaded yet
  load_ms?: number | null;
  warm_ms?: number | null;
  error?: string | null;
};
type LlmStatus = {
  provider: string; base_url: string; model: string;
  remote: boolean;                  // true when base_url is not loopback → data leaves this Mac
  reachable: boolean;
  model_available: boolean;
  models: string[];                 // models the endpoint lists
  error?: string | null;
  disclosure: string[];             // plain-language list of what is sent to this provider
};
```

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/api/laya/status` | → `LayaStatus` |
| POST | `/api/laya/download` | → `LayaStatus` immediately; progress arrives as `laya.download` events |
| POST | `/api/laya/load` | → `LayaStatus` (loads + warms the model; also done lazily on the first task) |
| GET | `/api/llm/status` | → `LlmStatus` |
| GET | `/api/llm/detect` | → `{"candidates":[{"provider","base_url","models":[...],"reachable":true}]}` (probes Ollama :11434, LM Studio :1234) |
| POST | `/api/llm/test` | `{}` → `{"ok":bool,"latency_ms":n,"error"?:str}` (tiny completion with current settings) |
| POST | `/api/llm/pull` | `{"model":"qwen3:8b"}` → `{"ok":true}`; Ollama only; progress as `llm.pull` events |
| POST | `/api/ollama/start` | → `{"ok":bool}` (launches the installed Ollama app/CLI if not running) |

## Conversations, messages, tasks

```ts
type Card =
  | { type: "links"; title?: string; items: { title: string; url: string; snippet?: string }[] }
  | { type: "images"; title?: string; items: { title: string; thumbnail_url: string | null; source_url: string | null; image_url: string | null; width?: number; height?: number; local_path?: string }[] }
  | { type: "table"; title?: string; columns: string[]; rows: { cells: string[]; url?: string }[]; note?: string }
  | { type: "files"; items: { name: string; path: string; size?: number; url?: string }[] }
  | { type: "sources"; items: { title: string; url: string }[] };

type Message = {
  id: string; conversation_id: string; role: "user" | "assistant" | "system";
  text: string;            // markdown for assistant
  cards: Card[];
  task_id: string | null;
  created_at: string;      // ISO 8601
};
type Timings = {
  total_ms: number; planning_ms: number; laya_ms: number; browser_ms: number; page_load_ms: number;
  llm_calls: number; laya_calls: number; browser_ops: number;
};
type Step = {
  id: string; index: number;
  kind: "navigate" | "search" | "click" | "type" | "select" | "scroll" | "read" | "extract" | "plan" | "wait"
      | "tab" | "download" | "verify" | "confirm" | "key" | "back" | "forward";
  title: string;           // "Searching Google…"
  detail?: string;         // e.g. the typed text or the clicked element label
  url?: string;
  status: "running" | "ok" | "error" | "skipped";
  started_at: string; elapsed_ms: number | null;
  error?: string | null;
};
type Task = {
  id: string; conversation_id: string; message_id: string; goal: string;
  status: "queued" | "running" | "paused" | "waiting_user" | "done" | "partial" | "failed" | "cancelled";
  started_at: string | null; finished_at: string | null; elapsed_ms: number;
  steps: Step[];
  current: { title: string; url: string | null; page_title: string | null } | null;
  waiting: { kind: "confirm" | "captcha" | "login" | "manual"; message: string; confirmation_id?: string; detail?: string } | null;
  error: string | null;
  timings: Timings | null;
  parent_task_id: string | null;     // follow-ups reference the previous task whose context they continue
};
type Conversation = { id: string; title: string; created_at: string; updated_at: string; last_task_status?: string };
```

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/api/conversations` | → `Conversation[]` (newest first) |
| POST | `/api/conversations` | `{"title"?}` → `Conversation` |
| GET | `/api/conversations/{id}` | → `{"conversation": Conversation, "messages": Message[], "tasks": Task[]}` |
| PATCH | `/api/conversations/{id}` | `{"title"}` → `Conversation` |
| DELETE | `/api/conversations/{id}` | → `{"ok":true}` |
| POST | `/api/conversations/{id}/clear` | → `{"ok":true}` (removes messages/tasks, keeps the conversation) |
| POST | `/api/conversations/{id}/messages` | `{"text": "..."}` → `{"message": Message, "task": Task}` — **starts a task**. Follow-ups in the same conversation automatically reuse context of the previous task (open tabs, extracted data). `409 task_running` when another task is running (one task at a time because there is one browser). |
| GET | `/api/tasks?limit=30` | → `Task[]` (recent across conversations) |
| GET | `/api/tasks/{id}` | → `Task` |
| POST | `/api/tasks/{id}/pause` | → `Task` |
| POST | `/api/tasks/{id}/resume` | → `Task` (also resumes from `waiting_user` captcha/login after the user finished manually) |
| POST | `/api/tasks/{id}/cancel` | → `Task` |
| POST | `/api/tasks/{id}/retry` | → `{"message": Message, "task": Task}` (new task with the same goal) |
| POST | `/api/tasks/{id}/confirm` | `{"confirmation_id","approved":bool}` → `Task` |
| GET | `/api/tasks/{id}/screenshot` | → `image/jpeg` of the agent's tab right now (only when `screenshots != "off"`; one capture per request) |
| POST | `/api/open-path` | `{"path"}` → `{"ok":true}`; reveals a downloaded file in Finder (path must be inside the downloads dir) |

## WebSocket events: `GET /api/events` (upgrade)

Server → client JSON envelopes, in order, never batched:

```ts
type Event = { seq: number; ts: string; type: string; conversation_id?: string; task_id?: string; data: any };
```

On connect the server sends `{"type":"hello","data":{"seq":N}}`. Clients should re-fetch REST state on reconnect.

| `type` | `data` |
| --- | --- |
| `task.created` | `Task` |
| `task.status` | `{status, waiting?, error?, current?}` |
| `step.started` | `Step` |
| `step.finished` | `Step` (same id, final status / elapsed_ms / error) |
| `page.updated` | `{url, title}` — the agent tab navigated |
| `assistant.delta` | `{message_id, text}` — streamed chunk of the final answer (append) |
| `assistant.message` | `Message` — final assistant message with cards (replaces streamed text) |
| `confirm.request` | `{confirmation_id, kind: "purchase"|"payment"|"destructive"|"account"|"send"|"sensitive", question, detail}` |
| `needs_user` | `{kind: "captcha"|"login"|"manual", message, url}` |
| `task.timings` | `Timings` (final, once) |
| `chrome.status` | `ChromeStatus` |
| `laya.status` | `LayaStatus` |
| `laya.download` | `{bytes, total, file, done}` |
| `llm.pull` | `{status, completed, total, done, error?}` |
| `notice` | `{level:"info"|"warn"|"error", message}` |

The task event stream is also persisted: `GET /api/tasks/{id}` always returns the current `steps`.

## Clarifications from the desktop shell / UI (app/)

These are the readings of the contract the UI implements. Backend behaviour that differs should be fixed here first.

* **CORS.** The webview calls the sidecar cross-origin (`tauri://localhost` in release, `http://localhost:1420` in dev), and
  sends `Authorization` + `Content-Type: application/json`, so every request is preceded by a preflight. The sidecar must
  answer `OPTIONS` (no auth required; Host/Origin checks still apply) with `204`, echo an *allowed* `Origin` in
  `Access-Control-Allow-Origin` (also on normal responses and on errors), and allow methods
  `GET, POST, PUT, PATCH, DELETE, OPTIONS` and headers `Authorization, Content-Type`.
* **Sidecar launch.** Release: `<App>.app/Contents/Resources/backend/jarvis-backend` (an executable file inside the PyInstaller
  *onedir* folder; cwd = that folder). Dev: `uv run --project <repo>/backend jarvis-backend`. Tauri additionally sets
  `JARVIS_PARENT_PID=<pid of the app>` (optional hint for the parent watchdog). The sidecar runs in its own process group;
  if Chrome must outlive the app (`keep_open_on_quit`) it must be started in its own session (`start_new_session=True`),
  otherwise the SIGKILL fallback of the process group would take it down.
* **Ready line.** Exactly one JSON line `{"event":"ready","port":N,...}` with `N != 0`, flushed, before anything else on stdout.
* **Conversation titles.** The UI creates a conversation lazily on the first message and passes `title` (first prompt, ≤ 56
  chars). A backend that auto-titles may still rename it; the UI refreshes `GET /api/conversations` after each answer.
* **Streaming.** `assistant.delta.message_id` should equal the `id` of the later `assistant.message`. If they differ, the UI
  replaces the streamed provisional message of the same `task_id` with the final one. Deltas after the final message are ignored.
* **Waiting states.** `confirm.request` and `needs_user` may arrive before or after the matching `task.status` (`waiting_user`).
  The UI builds `Task.waiting` from whichever comes first; `confirmation_id` must be present for the Approve/Deny buttons.
  A `task.status` with any other status clears `waiting`.
* **Task end.** On a terminal `task.status` the UI re-fetches `GET /api/tasks/{id}` once (final `elapsed_ms`, steps) and keeps
  `timings` received through `task.timings` if the snapshot has `timings: null`. Either event order is fine.
* **Onboarding actions.** The UI renders its own controls per check `id`: `laya_model` (`download_laya` → `POST /api/laya/download`,
  progress from `laya.download`), `text_model` (detect / start Ollama / pull a model; works whatever `action.id` is),
  `chrome` (mode choice, "Choose Chrome…"), `chrome_connection` (`POST /api/chrome/connect`). Any other check that carries an
  `action` gets a button that opens Settings. `ready` is true when every check *except* `chrome_connection` is `ok`
  (that one is tested lazily, when the first task starts, or from the Chrome popover). `warn` is allowed: the UI offers
  "Continue anyway".
* **Unsupported hardware.** `SystemStatus.arch != "arm64"` or `mlx_supported == false` (or an `apple_silicon` check with
  status `error`) shows a dedicated explanation screen; no feature is silently degraded.
* **Screenshots.** The UI requests `GET /api/tasks/{id}/screenshot` only while its "Preview" toggle is on, at most once every
  2 s, and never when `settings.agent.screenshots == "off"`. A refused capture should be a normal JSON error (e.g. `403`).
* **`POST /api/chrome/connect`** may take up to 60 s; the UI waits up to 75 s and keeps listening to `chrome.status`.
* **Settings writes.** The UI sends partial bodies (e.g. `{"llm":{"model":"qwen3:8b"}}`) and replaces its copy with the
  returned full `Settings`. `llm.api_key_set` is read-only for `PUT /api/settings` (set via `/api/secrets/llm_api_key`).

## Backend notes (implemented behaviour)

* `task.status` events also carry `started_at` and `elapsed_ms` (the UI clock needs them before the first step). Tasks start the
  moment they are created, so `started_at` is already set in `task.created`.
* `LayaStatus.state` has an extra resting value `idle` (checkpoint downloaded, model not loaded yet). The sidecar loads and warms
  Laya in the background as soon as it starts when the checkpoint is present, so `ready` is normally reached before the first task.
* `POST /api/chrome/connect` runs the connection as its own background attempt and returns after at most 60 s with the current
  `ChromeStatus`; in `existing` mode Chrome's "Allow remote debugging?" sheet may still be open at that point
  (`state: "awaiting_permission"`) and the attempt keeps going until the user answers or calls `/api/chrome/disconnect`.
* The first user message titles a conversation `New chat` → its first 60 characters.
* A declined confirmation ends the task as `partial` (the agent never re-plans around an action the user refused).
* `GET /api/tasks/{id}/screenshot` returns `403 screenshots_off` when `settings.agent.screenshots == "off"` and `409 no_tab` when
  the task has no open tab; it captures exactly one frame per request.
* Extra cards produced by the agent: `table` for extracted records (always grounded: every value was found on the page), `images`
  with `source_url` / `image_url` when Chrome's viewer exposed them, `files` for downloads, `sources` for the pages that were read.
