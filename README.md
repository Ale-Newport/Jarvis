# Jarvis — a local AI browser agent for macOS

Type what you want done in the browser — *"find the cheapest direct flights from London to Madrid on 20 November"*,
*"compare three sites that offer free 3D models"*, *"show me photos of palm trees"* — and watch Jarvis do it in your real
**Google Chrome**, step by step, with every action observable, validated and bounded.

* **Fast and local.** Browser decisions are made by **Laya**, a 421M-parameter typed-decision model running on your Mac through
  MLX (median **16 ms** per decision, no output tokens, loaded once and kept warm). Chrome is driven over the DevTools Protocol
  on one persistent connection (median 0.4 ms round trip).
* **General purpose.** A small supervisory planner (a text model of your choice: Ollama by default, or LM Studio, OpenRouter,
  OpenAI, any OpenAI-compatible endpoint) turns the request into typed tool steps. It is consulted once per task and again only
  when the browser's state needs a decision — never per click.
* **Grounded.** Every clickable target comes from the observed page. Extracted prices, flights and rows are kept only if their
  values literally appear on the page. Links in answers are removed unless the browser actually saw them.
* **Private.** Backend bound to `127.0.0.1`, bearer-token authenticated, API keys in the macOS Keychain, no accounts, no cloud.
* **Safe.** Purchases, payments, deletions, account changes and sends need your click. CAPTCHAs, bot checks and sign-in walls
  pause the task for you; Jarvis never tries to get past them.

It is built on [laya-ultrafast](https://github.com/ipenywis/laya-ultrafast) (a port of Browser Use's
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast)), extended into a desktop app with a general planner. See
[NOTICE](NOTICE) for what was reused and how.

## Requirements

* A Mac with **Apple Silicon** (M1 or newer) on **macOS 14+** — Laya runs through MLX. On an Intel Mac the app explains why it
  cannot run; it never silently substitutes a hosted decision API.
* **Google Chrome** installed (the standard `/Applications` location is detected; you can pick another copy in Settings).
* A text model endpoint. The easiest: [Ollama](https://ollama.com) and `ollama pull qwen3:8b` (5 GB). Onboarding can start
  Ollama and download a model for you. Tested with `qwen3:8b` and `qwen3:30b-instruct`.
* To build from source: [uv](https://docs.astral.sh/uv/) (Python 3.12), Node 20+ with pnpm, and Rust (stable).

## Run it

```bash
make dev        # Tauri dev app: Rust shell + Vite UI; starts the Python backend through `uv run`
make build      # packages the Python sidecar (PyInstaller) and builds app/src-tauri/target/release/bundle/macos/Jarvis.app
make test       # UI tests, Rust tests, backend unit + integration tests (the integration tests open real Chrome windows)
```

A prebuilt `Jarvis.app` is produced by `make build` (≈275 MB: the Python runtime, MLX and its Metal kernels are inside; the Laya
weights are *not* — see below). It is ad-hoc signed, so on another Mac use right-click → Open the first time.

### First run

Jarvis walks through: Apple Silicon and macOS version → Google Chrome → Laya checkpoint (a one-time **≈850 MB** download from
Hugging Face with a progress bar; afterwards everything runs offline) → text model (detects Ollama / LM Studio, can start Ollama and
pull a model) → Chrome connection test. Then you land in the chat.

### Using it

Type a request. The task panel shows the current operation ("Searching Google…", "Selecting departure city…"), the page URL,
elapsed time, a compact timeline with per-step timing, and errors. **Pause / Resume / Cancel / Retry** are always available;
**Open current tab** brings the agent's Chrome tab to the front. Follow-ups ("Only show direct flights and sort by price", "Open the
second result", "Download the third image") continue in the same tab with the earlier context.

Shortcuts: ⌘N new chat · ⌘K composer · ⌘, settings · ⌘B sidebar · ⌘. cancel · ⌘/ cheat-sheet · ↑ previous prompt.

### Chrome modes

| Mode | What it does | Notes |
| --- | --- | --- |
| **Managed** (default) | Launches your installed Chrome with a *separate, persistent automation profile* (`~/Library/Application Support/Jarvis/chrome-profile`) and a DevTools port chosen by Chrome. | Logins persist between launches; your normal Chrome windows and profiles are untouched. *Reset profile* in Settings deletes it. |
| **Existing session** | Attaches to the Chrome you already use, so authenticated sessions are available. | Needs your explicit consent: tick *Allow remote debugging* at `chrome://inspect/#remote-debugging`, then click **Allow** on Chrome's "Allow remote debugging?" sheet. Jarvis never clicks it for you, never restarts Chrome and only touches tabs it opened itself. |

### Text model and privacy

Settings → AI model. With a local provider nothing leaves your Mac except the websites the browser visits. With a remote provider the
settings page lists exactly what is sent (your request, visible text/links of pages being read or extracted, form-field labels) and
what is not (Keychain, cookies, password/payment fields, screenshots, files). Laya decisions and all browser actions stay local either way.

## How it works

```
 request ─▶ planner (text model, JSON-schema constrained)  ─▶ typed steps: search · goto · interact · open_link · visit · read
                                                              · extract · images · tab · back/forward · scroll · wait · download · ask_user
 step ─▶ Chrome (CDP)  observe: indexed elements, text, freshness markers      ◀── no screenshots, no per-step subprocess
            └─ interact: sub-goal planned once against the page's real field labels, then
               Laya policy loop:  observe → narrow typed questions (+ plain-code rules) → validated action → verify → …
 finish ─▶ independent checks (expected host/title, requirements visible on the page, grounded extraction, LLM audit for data tasks)
         ─▶ answer composed only from collected notes; unverifiable links removed
```

* `backend/jarvis/page.js` — the in-page runtime (from jev-ultrafast's snapshot): node identity, freshness markers, occlusion-checked
  hit testing, **plus** open shadow roots, same-origin iframes, visually hidden radios/checkboxes via their labels, animation-aware
  settling, content/link/image extraction.
* `backend/jarvis/cdp.py`, `chrome.py`, `browser.py` — async CDP client, Chrome discovery/launch, tabs (popups adopted, dialogs
  handled, event-driven waits on lifecycle events, mutation observers and running animations — no fixed sleeps beyond bounded budgets).
* `backend/jarvis/policy.py`, `goal_runner.py`, `laya_engine.py` — the Laya policy and its executor; one dedicated thread owns the MLX model.
* `backend/jarvis/planner.py`, `tools.py`, `task.py` — supervisor, tool implementations, task state machine (pause/resume/cancel,
  confirmations, challenge pauses, budgets, loop and repeat detection, replanning).
* `backend/jarvis/server.py`, `app.py`, `store.py`, `settings.py` — FastAPI API ([docs/API.md](docs/API.md)), SQLite persistence, Keychain.
* `app/` — Tauri 2 + React + TypeScript + Tailwind + zustand UI and the Rust shell that owns the sidecar's lifecycle.

### Safety model

* The model chooses *among observed things*; it never writes selectors, coordinates or JavaScript. Page text is wrapped as untrusted
  data in every prompt; plans are schema-validated; URLs must be http(s) and not private-network addresses unless you typed them.
* Before any click whose label looks like a purchase, payment, booking, deletion, account change, send or price-alert, Jarvis stops and
  asks. Card, password, one-time-code and file fields are never exposed to the model. Landing on a booking/checkout URL by accident
  makes Jarvis go back and stop. If you decline, the task ends — it does not re-plan around your refusal.
* Downloads happen only on request, after you approve, into `~/Downloads/Jarvis`.
* Budgets: 60 browser actions and 10 minutes per task by default (Settings), 5 stale retries in a row, repeated-step detection,
  at most 6 re-plans.

## Measured performance

Apple M2 Max, macOS 27, Chrome 154. Numbers from `backend/scripts/benchmark.py` and the test runs; the text model dominates
end-to-end time, so those figures depend on your model.

| What | Result |
| --- | --- |
| Laya load from the local cache / first warm-up (Metal kernel compile) / later warm-ups | ~0.1–0.2 s / ~1.2–1.6 s / ~0.07–0.65 s |
| One Laya choice question (8 options), end to end | median 16.5 ms, p95 17.2 ms |
| CDP round trip · observe (small page) · freshness check | median 0.4 ms · ~1 ms · 0.4 ms (real pages: observe 15–50 ms) |
| Chrome launch + connect (managed) | ~0.5 s |
| "Open github.com/torvalds/linux" (no text-model call) | 1.3–1.6 s total |
| Search → open the official result (fixture, scripted planner) | < 5 s including 1–2 Laya calls |
| Same, live on DuckDuckGo with Ollama `qwen3:8b` | ~10 s (1 planning call, 1 Laya call) |
| Wikipedia: find and open the article (live, `qwen3:8b`) | 9–37 s (text-model time dominates) |
| Google Flights one-way form → grounded rows (live, `qwen3:8b` / `qwen3:30b-instruct`) | 35–70 s, of which 80–90 % is text-model time (plan, sub-plan, extract, audit, answer); the browser part is 3–5 s |
| Flights follow-up "only nonstop, sort by price" (live) | ~12 s |
| Google Images → 16 thumbnails, first 8 opened for source page / original image (live) | ~13 s |
| Three-site research with parallel background tabs (live, DuckDuckGo) | ~40–50 s |

Every task reports `total / planning / Laya / browser / page-load` time and LLM/Laya/browser-operation counts (shown in the UI).

## Tests

```bash
cd backend
uv run pytest tests --ignore=tests/integration      # 130 unit tests: CDP client, safety, planner, LLM client, store/settings, policy, API
uv run pytest tests/integration                     # real Chrome + real Laya + local fixture web (scripted text model)
uv run pytest tests/live --live -v                  # optional: real websites and a real text model
```

The integration suite covers: **(1)** search → open the official result, **(2)** site search → right article verified by URL and title,
**(3)** a Flights-like app (trip type, autocomplete, calendar dialog, passengers, results) with every extracted price verified against the page,
transient-error retry, **(4)** image search with thumbnails, source pages, original URLs and a sponsored tile left out, **(5)** research
across three background tabs with citation sanitising, **(6)** follow-up reusing the results page, filters and sort order, **(7)** stale DOM
and covered targets, **(8)** cancellation with Chrome still usable — plus confirmations, CAPTCHA pause/resume, pause/resume, downloads,
shadow DOM, iframes, popups, dialogs, existing-session mode, and the real sidecar process lifecycle over HTTP and WebSocket.
The UI has its own Vitest suite and the Rust shell has unit tests (`make test`).

## Limitations (please read)

* **Google bot checks.** After a number of automated searches Google showed "unusual traffic" CAPTCHAs on this machine's network. Jarvis
  pauses and asks you to solve it in Chrome (the managed profile remembers it afterwards); it does not and will not bypass it. Google
  Flights worked throughout testing, Google Search/Images intermittently did not. In *existing session* mode your own profile usually fares better.
* **Planner quality depends on your text model.** 8B models plan the common cases well (7/7 on `backend/scripts/plan_eval.py`) but can still
  choose poorly on open-ended research; larger models do better and are slower. Replanning is bounded.
* **Flights.** Verified live on Google Flights (English UI): one-way, route, date, passengers, Stops and Sort filters, grounded results.
  Google occasionally shows "Something went wrong" after a filter change in an automated profile; Jarvis retries once, then reports it. Round-trip,
  multi-city, cabin changes and non-English UIs are implemented through the generic mechanism but not separately verified. **Jarvis never books.**
* **Browser coverage.** Open shadow roots and same-origin iframes are observed; cross-origin iframes, closed shadow roots, canvas, drag-and-drop and
  file uploads are not. Keyboard-only widgets are limited to Enter / Escape / arrows / Tab.
* **Sensitive-action detection is label-based.** It will stop on obvious purchase/payment/delete/send buttons and checkout URLs, but a button
  with a misleading label can slip through. Watch tasks that touch accounts.
* **Downloads** are fetched by Jarvis (not Chrome's download manager), without your cookies, so authenticated downloads are not supported.
* **One task at a time** (there is one browser). The app is not notarized; the first launch on another Mac needs right-click → Open.
* Not verified in the packaged window: the native "Choose Chrome…" file dialog, opening links through the system browser from inside
  WKWebView, and light-mode sync with the system theme (checked in the browser pane only).
* The hosted Jev policy of the original project is intentionally unsupported.

## Credits

Browser Use ([jev-ultrafast](https://github.com/browser-use/jev-ultrafast), [browser-harness](https://github.com/browser-use/browser-harness)),
[laya-ultrafast](https://github.com/ipenywis/laya-ultrafast), [laya-mlx](https://github.com/mizorewww/laya-mlx) and
[Laya](https://github.com/NandhaKishorM/laya) by Convai Innovations. MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
