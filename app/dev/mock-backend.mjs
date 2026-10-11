#!/usr/bin/env node
// Mock Jarvis backend implementing docs/API.md with scripted behaviour, for UI development.
//
//   node app/dev/mock-backend.mjs                        # random port, token "devtoken"
//   JARVIS_PORT=8765 JARVIS_TOKEN=devtoken node app/dev/mock-backend.mjs
//   JARVIS_BACKEND_CMD="node app/dev/mock-backend.mjs" pnpm --dir app tauri dev   # through the real Rust path
//
// Prompt keywords: "confirm" -> approval banner, "captcha" -> manual-help banner, "fail" -> failed task,
//                  "quick" -> short answer without cards.
// Dev-only helpers (Bearer auth): POST /dev/scenario {"name": "ready" | "fresh" | "x86" | "remote"}
//
// Contract details enforced like the real sidecar: 127.0.0.1 bind, Host / Origin checks, Bearer auth,
// WebSocket auth through the ["jarvis.v1", "bearer.<token>"] subprotocols, one JSON "ready" line on stdout.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.JARVIS_TOKEN || "devtoken";
const REQUEST_PORT = Number(process.env.JARVIS_PORT || 0);
const SPEED = Number(process.env.MOCK_SPEED || 1); // >1 = faster
const VERSION = "0.1.0-mock";
const DOWNLOADS = join(homedir(), "Downloads", "Jarvis");

const log = (...a) => console.error("[mock]", ...a);
const sleepRaw = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const now = () => new Date().toISOString();
let idCounter = 1;
const nid = (p) => `${p}_${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// ------------------------------------------------------------------ state

const DEFAULT_SETTINGS = () => ({
  appearance: "system",
  chrome: { mode: "managed", path: null, keep_open_on_quit: false, existing_debug_port: null },
  llm: { provider: "ollama", base_url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", api_key_set: false, json_mode: "auto", reasoning: "default" },
  laya: { model: "aac6fef/laya-typed-decisions-mlx" },
  agent: { max_steps: 60, max_minutes: 10, confirm_sensitive: true, allow_local_urls: false, screenshots: "on_demand" },
});

const S = {
  settings: DEFAULT_SETTINGS(),
  arch: "arm64",
  mlx: true,
  chromeInstalled: true,
  ollamaRunning: true,
  ollamaModels: ["qwen3:8b", "llama3.1:8b", "gemma3:4b"],
  lmstudioRunning: false,
  layaDownloaded: true,
  layaState: "ready",
  chrome: { state: "disconnected", debugging: "unknown", tabs: [], error: null },
  conversations: new Map(),
  messages: new Map(), // convId -> Message[]
  tasks: new Map(),
  controls: new Map(), // taskId -> control block
  secrets: new Set(),
  seq: 0,
};

function scenario(name) {
  const keepClients = true;
  void keepClients;
  S.settings = DEFAULT_SETTINGS();
  S.arch = "arm64";
  S.mlx = true;
  S.chromeInstalled = true;
  S.ollamaRunning = true;
  S.layaDownloaded = true;
  S.layaState = "ready";
  S.chrome = { state: "disconnected", debugging: "unknown", tabs: [], error: null };
  S.secrets.clear();
  if (name === "fresh") {
    S.layaDownloaded = false;
    S.layaState = "missing";
    S.ollamaRunning = false;
    S.ollamaModels = [];
  } else if (name === "x86") {
    S.arch = "x86_64";
    S.mlx = false;
    S.layaState = "unsupported";
    S.layaDownloaded = false;
  } else if (name === "remote") {
    S.settings.llm = { provider: "openrouter", base_url: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", api_key_set: true, json_mode: "auto", reasoning: "default" };
    S.secrets.add("llm_api_key");
  } else {
    S.ollamaModels = ["qwen3:8b", "llama3.1:8b", "gemma3:4b"];
  }
  broadcast("laya.status", layaStatus());
  broadcast("chrome.status", chromeStatus());
}

// ------------------------------------------------------------------ websocket

const sockets = new Set();

function broadcast(type, data, extra = {}) {
  const ev = { seq: ++S.seq, ts: now(), type, ...extra, data };
  const frame = JSON.stringify(ev);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(frame);
}
const taskEvent = (task, type, data) => broadcast(type, data, { conversation_id: task.conversation_id, task_id: task.id });

// ------------------------------------------------------------------ derived status objects

const isLoopback = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
};

function layaStatus() {
  return {
    model: S.settings.laya.model,
    downloaded: S.layaDownloaded,
    size_bytes: S.layaDownloaded ? 891_289_600 : null,
    state: S.layaState,
    load_ms: S.layaState === "ready" ? 2140 : null,
    warm_ms: S.layaState === "ready" ? 310 : null,
    error: S.layaState === "unsupported" ? "Laya requires Apple Silicon." : null,
  };
}

function llmStatus() {
  const { provider, base_url, model } = S.settings.llm;
  const remote = !isLoopback(base_url);
  let reachable = remote ? true : provider === "lmstudio" ? S.lmstudioRunning : S.ollamaRunning;
  const models = !reachable ? [] : remote ? ["openai/gpt-4o-mini", "anthropic/claude-3.5-haiku", "meta-llama/llama-3.1-70b-instruct"] : provider === "lmstudio" ? ["lmstudio-community/qwen2.5-7b"] : S.ollamaModels;
  return {
    provider,
    base_url,
    model,
    remote,
    reachable,
    model_available: reachable && models.includes(model),
    models,
    error: reachable ? null : `Could not connect to ${base_url}`,
    disclosure: remote
      ? [
          "Your task prompts and follow-up messages",
          "Text and links extracted from the web pages Jarvis reads",
          "Summaries of page structure (titles, headings, button labels)",
          "Not sent: your passwords, cookies, or screenshots",
        ]
      : [],
  };
}

function chromeStatus() {
  const mode = S.settings.chrome.mode;
  const c = S.chrome;
  return {
    installed: S.chromeInstalled,
    path: S.chromeInstalled ? (S.settings.chrome.path ?? "/Applications/Google Chrome.app") : null,
    version: S.chromeInstalled ? "141.0.7390.55" : null,
    mode,
    state: c.state,
    debugging: mode === "existing" ? (c.state === "connected" ? "on" : "off") : "unknown",
    how_to_enable:
      mode === "existing" && c.state !== "connected"
        ? "1. In Chrome, open `chrome://inspect/#remote-debugging`.\n2. Switch on **Allow remote debugging for this browser instance**.\n3. Come back here and press **Connect**. Chrome will ask once for permission."
        : null,
    profile_dir: mode === "managed" ? join(homedir(), "Library/Application Support/Jarvis/chrome-profile") : null,
    tabs: c.tabs,
    error: c.error,
  };
}

function onboardingChecks() {
  const llm = llmStatus();
  const checks = [
    { id: "apple_silicon", title: "Apple Silicon", status: S.arch === "arm64" ? "ok" : "error", detail: S.arch === "arm64" ? "Apple M-series detected" : "Intel Mac detected: Laya needs Apple Silicon" },
    { id: "macos", title: "macOS 14 or newer", status: "ok", detail: "macOS 27.0" },
    S.chromeInstalled
      ? { id: "chrome", title: "Google Chrome", status: "ok", detail: "Version 141.0.7390.55 at /Applications/Google Chrome.app" }
      : { id: "chrome", title: "Google Chrome", status: "error", detail: "Chrome wasn't found in /Applications", action: { id: "choose_chrome", label: "Choose Chrome…" } },
    { id: "python", title: "Jarvis engine", status: "ok", detail: "Python 3.12, MLX ready" },
    S.layaDownloaded
      ? { id: "laya_model", title: "Laya model", status: "ok", detail: `${S.settings.laya.model} (850 MB) is ready` }
      : { id: "laya_model", title: "Laya model", status: S.arch === "arm64" ? "error" : "pending", detail: S.layaState === "downloading" ? "Downloading…" : "The local decision model isn't downloaded yet", action: { id: "download_laya", label: "Download model (850 MB)" } },
    llm.reachable && llm.model_available
      ? { id: "text_model", title: "Text model", status: "ok", detail: `${llm.model} via ${llm.provider}${llm.remote ? " (remote)" : ""}` }
      : { id: "text_model", title: "Text model", status: "error", detail: llm.reachable ? `Model “${llm.model}” isn't available at ${llm.base_url}` : `Nothing is listening at ${llm.base_url}. Start Ollama or LM Studio, or choose another provider.`, action: { id: "setup_text_model", label: "Set up" } },
    S.chrome.state === "connected"
      ? { id: "chrome_connection", title: "Chrome connection", status: "ok", detail: "Connected" }
      : { id: "chrome_connection", title: "Chrome connection", status: "warn", detail: "Not connected yet. Jarvis connects on the first task, or you can test it now.", action: { id: "connect_chrome", label: "Connect" } },
  ];
  const ready = checks.every((c) => c.status === "ok" || (c.id === "chrome_connection" && c.status === "warn"));
  return { checks, ready };
}

const busyTaskId = () => [...S.tasks.values()].find((t) => ["queued", "running", "paused", "waiting_user"].includes(t.status))?.id ?? null;

function systemStatus() {
  return { version: VERSION, arch: S.arch, macos: "27.0.1", mlx_supported: S.mlx, chrome: chromeStatus(), laya: layaStatus(), llm: llmStatus(), busy_task_id: busyTaskId() };
}

// ------------------------------------------------------------------ chrome simulation

async function chromeConnect(mode) {
  if (mode && mode !== S.settings.chrome.mode) S.settings.chrome.mode = mode;
  if (!S.chromeInstalled) {
    S.chrome.state = "error";
    S.chrome.error = "Google Chrome is not installed.";
    broadcast("chrome.status", chromeStatus());
    return chromeStatus();
  }
  S.chrome.error = null;
  S.chrome.state = "connecting";
  broadcast("chrome.status", chromeStatus());
  await sleepRaw(900);
  if (S.settings.chrome.mode === "existing") {
    S.chrome.state = "awaiting_permission";
    broadcast("chrome.status", chromeStatus());
    await sleepRaw(3500);
  }
  S.chrome.state = "connected";
  S.chrome.tabs = [{ id: "tab1", title: "Jarvis", url: "about:blank", active: true }];
  broadcast("chrome.status", chromeStatus());
  return chromeStatus();
}

// ------------------------------------------------------------------ task scripting

class Cancelled extends Error {}

function makeTask(conv, message) {
  const previous = [...S.tasks.values()].filter((t) => t.conversation_id === conv.id).at(-1);
  return {
    id: nid("t"),
    conversation_id: conv.id,
    message_id: message.id,
    goal: message.text,
    status: "queued",
    started_at: null,
    finished_at: null,
    elapsed_ms: 0,
    steps: [],
    current: null,
    waiting: null,
    error: null,
    timings: null,
    parent_task_id: previous?.id ?? null,
  };
}

function svgThumb(i, label) {
  const hues = [215, 265, 330, 25, 160, 190, 45, 300];
  const h = hues[i % hues.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},75%,62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},70%,38%)"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><circle cx="200" cy="130" r="${46 + (i % 3) * 10}" fill="rgba(255,255,255,.28)"/><rect x="150" y="190" width="100" height="14" rx="7" fill="rgba(255,255,255,.55)"/><text x="200" y="270" font-family="sans-serif" font-size="22" fill="rgba(255,255,255,.9)" text-anchor="middle">${label}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function buildAnswer(goal, outcome) {
  const quick = /\bquick\b/i.test(goal);
  if (outcome === "denied") {
    return { text: "I stopped before placing the order because you denied the confirmation. Nothing was purchased. Tell me if you'd like me to try again or pick a different option.", cards: [] };
  }
  if (quick) return { text: `Done. Here's the short version: I searched, opened the top result and read it. **Nothing else is needed.**`, cards: [] };
  const text = [
    `## Here's what I found`,
    ``,
    `I searched for **${goal.slice(0, 90)}** and checked the top results. The best options are listed below.`,
    ``,
    `- The cheapest direct option is **€79** with *Iberia Express*, leaving at 07:45.`,
    `- Morning departures are cheaper on Fridays; evening ones cost about 25% more.`,
    `- Everything below was read live from the sites, not from memory.`,
    ``,
    `| Option | Time | Price |`,
    `| --- | --- | --- |`,
    `| Iberia Express | 07:45 | €79 |`,
    `| TAP Air Portugal | 10:20 | €93 |`,
    `| Ryanair | 18:05 | €71 |`,
    ``,
    `You can reproduce the search with:`,
    ``,
    "```python",
    `import requests`,
    `r = requests.get("https://example.com/api/flights", params={"from": "MAD", "to": "LIS"})`,
    `print(r.json()["cheapest"])`,
    "```",
    ``,
    `Want me to [open the booking page](https://example.com/book) or narrow this down further?`,
  ].join("\n");
  const cards = [
    {
      type: "links",
      title: "Top results",
      items: [
        { title: "Madrid to Lisbon flights from €71 | Skyscanner", url: "https://www.skyscanner.net/routes/mad/lis/madrid-to-lisbon.html", snippet: "Compare cheap flights from Madrid to Lisbon. Prices updated every few minutes from airlines and agents." },
        { title: "Cheap flights Madrid - Lisbon | Kayak", url: "https://www.kayak.com/flight-routes/Madrid-MAD/Lisbon-LIS", snippet: "Find the best deals on direct flights, with a price calendar for the whole month." },
        { title: "Direct flights MAD → LIS - Iberia", url: "https://www.iberia.com/es/vuelos/madrid-lisboa/", snippet: "Book direct flights with Iberia Express. Free carry-on bag on selected fares." },
        { title: "TAP Air Portugal: Madrid to Lisbon", url: "https://www.flytap.com/en-es/flights/madrid-to-lisbon" },
      ],
    },
    {
      type: "images",
      title: "Images",
      items: Array.from({ length: 8 }, (_, i) => ({
        title: ["Lisbon skyline", "Tram 28", "Alfama at dusk", "Belém Tower", "Madrid Gran Vía", "Retiro Park", "Cathedral", "Rooftops"][i],
        thumbnail_url: i === 5 ? null : svgThumb(i, ["Lisbon", "Tram 28", "Alfama", "Belém", "Madrid", "Retiro", "Sé", "Roofs"][i]),
        source_url: `https://example.com/photos/${i + 1}`,
        image_url: `https://example.com/photos/${i + 1}.jpg`,
        width: 1600,
        height: 1067,
      })),
    },
    {
      type: "table",
      title: "Flight comparison",
      columns: ["Airline", "Departs", "Duration", "Stops", "Price"],
      rows: [
        { cells: ["Ryanair", "18:05", "1h 20m", "Direct", "€71"], url: "https://www.ryanair.com/" },
        { cells: ["Iberia Express", "07:45", "1h 15m", "Direct", "€79"], url: "https://www.iberia.com/" },
        { cells: ["TAP Air Portugal", "10:20", "1h 15m", "Direct", "€93"], url: "https://www.flytap.com/" },
        { cells: ["Vueling", "13:40", "3h 05m", "1 stop (BCN)", "€88"] },
      ],
      note: "Prices are for one adult, hand luggage only, as shown on each airline's website at the time of the search.",
    },
    { type: "files", items: [{ name: "flight-comparison.pdf", path: join(DOWNLOADS, "flight-comparison.pdf"), size: 182_400, url: "https://example.com/flight-comparison" }, { name: "boarding-times.csv", path: join(DOWNLOADS, "boarding-times.csv"), size: 2_048 }] },
    {
      type: "sources",
      items: [
        { title: "Skyscanner", url: "https://www.skyscanner.net/routes/mad/lis/madrid-to-lisbon.html" },
        { title: "Kayak", url: "https://www.kayak.com/flight-routes/Madrid-MAD/Lisbon-LIS" },
        { title: "Iberia", url: "https://www.iberia.com/es/vuelos/madrid-lisboa/" },
        { title: "TAP", url: "https://www.flytap.com/en-es/flights/madrid-to-lisbon" },
      ],
    },
  ];
  return { text, cards };
}

async function runTask(task, conv) {
  const ctl = { cancelled: false, paused: false, waiter: null, started: Date.now(), t: { planning: 0, laya: 0, browser: 0, page: 0, llm: 0, layaCalls: 0, ops: 0 } };
  S.controls.set(task.id, ctl);

  const sleep = async (ms) => {
    let left = ms / SPEED;
    while (left > 0) {
      if (ctl.cancelled) throw new Cancelled();
      if (ctl.paused) {
        await new Promise((r) => setTimeout(r, 80));
        continue;
      }
      const slice = Math.min(60, left);
      await new Promise((r) => setTimeout(r, slice));
      left -= slice;
    }
    if (ctl.cancelled) throw new Cancelled();
  };

  const setStatus = (status, extra = {}) => {
    task.status = status;
    Object.assign(task, extra);
    if (status !== "waiting_user" && status !== "paused") task.waiting = status === "waiting_user" ? task.waiting : null;
    taskEvent(task, "task.status", { status, waiting: task.waiting, error: task.error, current: task.current });
  };

  let index = 0;
  const step = async (kind, title, detail, ms, opts = {}) => {
    const s = { id: nid("s"), index: index++, kind, title, detail, url: opts.url, status: "running", started_at: now(), elapsed_ms: null, error: null };
    task.steps.push(s);
    task.current = { title, url: opts.url ?? task.current?.url ?? null, page_title: task.current?.page_title ?? null };
    taskEvent(task, "step.started", { ...s });
    if (opts.page) {
      task.current = { title, url: opts.page.url, page_title: opts.page.title };
      taskEvent(task, "page.updated", opts.page);
    }
    const t0 = Date.now();
    try {
      await sleep(ms);
    } catch (e) {
      s.status = "skipped";
      s.elapsed_ms = Date.now() - t0;
      taskEvent(task, "step.finished", { ...s });
      throw e;
    }
    s.elapsed_ms = Date.now() - t0;
    s.status = opts.fail ? "error" : "ok";
    s.error = opts.fail ?? null;
    if (kind === "plan") ctl.t.planning += s.elapsed_ms, (ctl.t.llm += 1);
    else if (kind === "navigate" || kind === "search") ctl.t.page += s.elapsed_ms * 0.6, (ctl.t.browser += s.elapsed_ms * 0.4), (ctl.t.ops += 1), (ctl.t.layaCalls += 1), (ctl.t.laya += 90);
    else (ctl.t.browser += s.elapsed_ms), (ctl.t.ops += 1), (ctl.t.layaCalls += 1), (ctl.t.laya += 80);
    taskEvent(task, "step.finished", { ...s });
    return s;
  };

  const waitForUser = () =>
    new Promise((resolve, reject) => {
      ctl.waiter = { resolve, reject };
    });

  let outcome = "ok";
  try {
    task.started_at = now();
    taskEvent(task, "task.created", { ...task });
    setStatus("running");
    if (S.chrome.state !== "connected") {
      await step("tab", "Connecting to Chrome…", undefined, 300);
      await chromeConnect();
    }

    await step("plan", "Planning the steps…", undefined, 900);
    await step("search", "Searching Google…", task.goal.slice(0, 80), 1400, { url: "https://www.google.com/search?q=" + encodeURIComponent(task.goal.slice(0, 60)), page: { url: "https://www.google.com/search?q=" + encodeURIComponent(task.goal.slice(0, 60)), title: "Google Search" } });
    await step("click", "Opening the first result", "Madrid to Lisbon flights | Skyscanner", 1000);
    await step("navigate", "Loading skyscanner.net…", undefined, 1500, { url: "https://www.skyscanner.net/routes/mad/lis/madrid-to-lisbon.html", page: { url: "https://www.skyscanner.net/routes/mad/lis/madrid-to-lisbon.html", title: "Madrid to Lisbon flights | Skyscanner" } });
    await step("scroll", "Scrolling to the price list", undefined, 600);
    await step("read", "Reading the page", undefined, 1300);

    if (/captcha/i.test(task.goal)) {
      await step("verify", "Checking the page is loaded", undefined, 500);
      task.waiting = { kind: "captcha", message: "The site is asking to verify you're human. Solve the check in Chrome, then press Resume.", detail: "https://www.skyscanner.net/routes/mad/lis/madrid-to-lisbon.html" };
      setStatus("waiting_user");
      broadcast("needs_user", { kind: "captcha", message: task.waiting.message, url: task.waiting.detail }, { conversation_id: task.conversation_id, task_id: task.id });
      await waitForUser();
      task.waiting = null;
      setStatus("running");
      await step("verify", "Verification complete", undefined, 600);
    }

    if (/confirm/i.test(task.goal)) {
      await step("click", "Selecting the cheapest fare", "Ryanair · 18:05 · €71", 900);
      const confirmationId = nid("c");
      task.waiting = { kind: "confirm", message: "Place the booking for €71.00 with the card ending 4242?", confirmation_id: confirmationId, detail: "Ryanair MAD → LIS · Fri 17 Oct · 1 adult · hand luggage" };
      setStatus("waiting_user");
      broadcast("confirm.request", { confirmation_id: confirmationId, kind: "purchase", question: task.waiting.message, detail: task.waiting.detail }, { conversation_id: task.conversation_id, task_id: task.id });
      const approved = await waitForUser();
      task.waiting = null;
      setStatus("running");
      if (approved) await step("click", "Placing the booking…", undefined, 1200);
      else {
        outcome = "denied";
        await step("confirm", "Booking denied by you", undefined, 400);
      }
    }

    if (/\bfail/i.test(task.goal)) {
      await step("click", "Clicking “Continue to payment”", undefined, 800, { fail: "Element not found: the button disappeared after the page re-rendered." });
      throw Object.assign(new Error("I couldn't finish: the page changed while I was working and the button I needed disappeared."), { failed: true });
    }

    await step("extract", "Collecting the results", "4 flights, 6 photos", 900);

    // stream the answer
    const answer = buildAnswer(task.goal, outcome);
    const messageId = nid("m");
    const chunks = answer.text.match(/[\s\S]{1,28}/g) ?? [];
    for (const c of chunks) {
      broadcast("assistant.delta", { message_id: messageId, text: c }, { conversation_id: conv.id, task_id: task.id });
      await sleep(38);
    }
    const message = { id: messageId, conversation_id: conv.id, role: "assistant", text: answer.text, cards: answer.cards, task_id: task.id, created_at: now() };
    S.messages.get(conv.id).push(message);
    conv.updated_at = now();
    broadcast("assistant.message", message, { conversation_id: conv.id, task_id: task.id });
    ctl.t.llm += 1;
    task.finished_at = now();
    task.elapsed_ms = Date.now() - ctl.started;
    setStatus(outcome === "denied" ? "partial" : "done");
  } catch (e) {
    task.finished_at = now();
    task.elapsed_ms = Date.now() - ctl.started;
    if (e instanceof Cancelled) {
      task.error = "Cancelled by you.";
      setStatus("cancelled");
    } else {
      task.error = e.message;
      const message = { id: nid("m"), conversation_id: conv.id, role: "assistant", text: `I ran into a problem and had to stop.\n\n> ${e.message}\n\nYou can press **Retry** to try again.`, cards: [], task_id: task.id, created_at: now() };
      S.messages.get(conv.id).push(message);
      broadcast("assistant.message", message, { conversation_id: conv.id, task_id: task.id });
      setStatus("failed");
    }
  }

  const total = Date.now() - ctl.started;
  task.timings = { total_ms: total, planning_ms: Math.round(ctl.t.planning), laya_ms: Math.round(ctl.t.laya), browser_ms: Math.round(ctl.t.browser), page_load_ms: Math.round(ctl.t.page), llm_calls: ctl.t.llm, laya_calls: ctl.t.layaCalls, browser_ops: ctl.t.ops };
  taskEvent(task, "task.timings", task.timings);
  conv.last_task_status = task.status;
  S.controls.delete(task.id);
}

function startTask(conv, text) {
  const message = { id: nid("m"), conversation_id: conv.id, role: "user", text, cards: [], task_id: null, created_at: now() };
  const task = makeTask(conv, message);
  message.task_id = task.id;
  S.messages.get(conv.id).push(message);
  S.tasks.set(task.id, task);
  conv.updated_at = now();
  conv.last_task_status = "queued";
  setTimeout(() => void runTask(task, conv), 30);
  return { message, task };
}

// ------------------------------------------------------------------ http plumbing

const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420", ...(process.env.MOCK_ALLOW_ORIGIN ? process.env.MOCK_ALLOW_ORIGIN.split(",") : [])]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "text/plain", ...headers });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "Request body is not valid JSON.");
  }
}

const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] ? deepMerge(out[k], v) : v;
  return out;
};

const getConv = (id) => {
  const c = S.conversations.get(id);
  if (!c) throw new HttpError(404, "not_found", "Conversation not found.");
  return c;
};
const getTask = (id) => {
  const t = S.tasks.get(id);
  if (!t) throw new HttpError(404, "not_found", "Task not found.");
  return t;
};

function seed() {
  const mk = (title, ageMs) => {
    const c = { id: nid("c"), title, created_at: new Date(Date.now() - ageMs).toISOString(), updated_at: new Date(Date.now() - ageMs).toISOString(), last_task_status: "done" };
    S.conversations.set(c.id, c);
    S.messages.set(c.id, []);
    return c;
  };
  const day = 24 * 3600 * 1000;
  const a = mk("Cheapest flights Madrid to Lisbon", 3 * 3600 * 1000);
  const b = mk("Standing desks under €400", day + 2 * 3600 * 1000);
  mk("Summarise Hacker News front page", 4 * day);
  mk("Find a vegan restaurant in Lavapiés", 9 * day);
  for (const [c, q] of [[a, "Find the cheapest direct flights from Madrid to Lisbon next Friday"], [b, "Compare standing desks under €400 with at least 120 cm width"]]) {
    const um = { id: nid("m"), conversation_id: c.id, role: "user", text: q, cards: [], task_id: null, created_at: c.created_at };
    const t = makeTask(c, um);
    um.task_id = t.id;
    t.status = "done";
    t.started_at = c.created_at;
    t.finished_at = c.created_at;
    t.elapsed_ms = 14_200;
    t.steps = [
      { id: nid("s"), index: 0, kind: "plan", title: "Planning the steps…", status: "ok", started_at: c.created_at, elapsed_ms: 1100 },
      { id: nid("s"), index: 1, kind: "search", title: "Searching Google…", detail: q.slice(0, 60), status: "ok", started_at: c.created_at, elapsed_ms: 2300 },
      { id: nid("s"), index: 2, kind: "read", title: "Reading the page", status: "ok", started_at: c.created_at, elapsed_ms: 1800 },
    ];
    t.timings = { total_ms: 14200, planning_ms: 1100, laya_ms: 420, browser_ms: 7300, page_load_ms: 4100, llm_calls: 2, laya_calls: 9, browser_ops: 9 };
    const ans = buildAnswer(q, "ok");
    const am = { id: nid("m"), conversation_id: c.id, role: "assistant", text: ans.text, cards: c === a ? ans.cards : ans.cards.slice(0, 1), task_id: t.id, created_at: c.created_at };
    S.messages.get(c.id).push(um, am);
    S.tasks.set(t.id, t);
  }
}

// ------------------------------------------------------------------ routes

async function route(req, res, url) {
  const m = req.method;
  const path = url.pathname;
  let match;

  if (m === "GET" && path === "/health") return send(res, 200, { status: "ready", version: VERSION });

  // ---- dev helpers
  if (m === "POST" && path === "/dev/log") {
    const body = await readJson(req);
    log("[ui]", body.m);
    return send(res, 200, { ok: true });
  }
  if (m === "POST" && path === "/dev/scenario") {
    const body = await readJson(req);
    scenario(body.name || "ready");
    return send(res, 200, { ok: true, name: body.name || "ready" });
  }

  // ---- system
  if (m === "GET" && path === "/api/status") return send(res, 200, systemStatus());
  if (m === "POST" && path === "/api/onboarding/check") {
    await sleepRaw(350);
    return send(res, 200, onboardingChecks());
  }
  if (m === "GET" && path === "/api/settings") return send(res, 200, S.settings);
  if (m === "PUT" && path === "/api/settings") {
    const body = await readJson(req);
    const next = deepMerge(S.settings, body);
    next.llm.api_key_set = S.secrets.has("llm_api_key");
    S.settings = next;
    broadcast("chrome.status", chromeStatus());
    return send(res, 200, S.settings);
  }
  if ((match = path.match(/^\/api\/secrets\/([^/]+)$/))) {
    const name = decodeURIComponent(match[1]);
    if (name !== "llm_api_key") throw new HttpError(404, "unknown_secret", "Unknown secret name.");
    if (m === "PUT") {
      const body = await readJson(req);
      if (!body.value) throw new HttpError(400, "bad_request", "value is required.");
      S.secrets.add(name);
      S.settings.llm.api_key_set = true;
      return send(res, 200, { name, set: true });
    }
    if (m === "DELETE") {
      S.secrets.delete(name);
      S.settings.llm.api_key_set = false;
      return send(res, 200, { name, set: false });
    }
  }
  if (m === "POST" && path === "/api/shutdown") {
    send(res, 200, { ok: true });
    log("shutdown requested");
    setTimeout(() => process.exit(0), 120);
    return;
  }

  // ---- chrome
  if (m === "GET" && path === "/api/chrome/status") return send(res, 200, chromeStatus());
  if (m === "POST" && path === "/api/chrome/connect") {
    const body = await readJson(req);
    return send(res, 200, await chromeConnect(body.mode));
  }
  if (m === "POST" && path === "/api/chrome/disconnect") {
    S.chrome = { state: "disconnected", debugging: "unknown", tabs: [], error: null };
    broadcast("chrome.status", chromeStatus());
    return send(res, 200, chromeStatus());
  }
  if (m === "POST" && path === "/api/chrome/reset-profile") {
    const body = await readJson(req);
    if (body.confirm !== true) throw new HttpError(400, "confirm_required", "Pass {\"confirm\": true}.");
    if (busyTaskId()) throw new HttpError(409, "task_running", "Can't reset the profile while a task is running.");
    S.chrome = { state: "disconnected", debugging: "unknown", tabs: [], error: null };
    broadcast("chrome.status", chromeStatus());
    return send(res, 200, chromeStatus());
  }
  if (m === "POST" && path === "/api/chrome/focus") {
    if (S.chrome.state !== "connected") throw new HttpError(409, "not_connected", "Chrome isn't connected.");
    return send(res, 200, chromeStatus());
  }
  if (m === "PUT" && path === "/api/chrome/path") {
    const body = await readJson(req);
    if (!/Google Chrome[^/]*\.app\/?$/i.test(body.path || "")) throw new HttpError(400, "not_chrome", "That application doesn't look like Google Chrome.");
    S.settings.chrome.path = body.path;
    S.chromeInstalled = true;
    broadcast("chrome.status", chromeStatus());
    return send(res, 200, chromeStatus());
  }

  // ---- laya + llm
  if (m === "GET" && path === "/api/laya/status") return send(res, 200, layaStatus());
  if (m === "POST" && path === "/api/laya/download") {
    if (S.arch !== "arm64") throw new HttpError(400, "unsupported", "Laya needs Apple Silicon.");
    S.layaState = "downloading";
    send(res, 200, layaStatus());
    broadcast("laya.status", layaStatus());
    (async () => {
      const total = 891_289_600;
      const files = ["config.json", "tokenizer.json", "model.safetensors"];
      for (let i = 0; i <= 40; i++) {
        const bytes = Math.round((total * i) / 40);
        broadcast("laya.download", { bytes, total, file: files[Math.min(2, Math.floor(i / 14))], done: false });
        await sleepRaw(130);
      }
      S.layaDownloaded = true;
      S.layaState = "ready";
      broadcast("laya.download", { bytes: total, total, file: "model.safetensors", done: true });
      broadcast("laya.status", layaStatus());
    })();
    return;
  }
  if (m === "POST" && path === "/api/laya/load") {
    S.layaState = "loading";
    broadcast("laya.status", layaStatus());
    await sleepRaw(1200);
    S.layaState = S.layaDownloaded ? "ready" : "missing";
    broadcast("laya.status", layaStatus());
    return send(res, 200, layaStatus());
  }
  if (m === "GET" && path === "/api/llm/status") return send(res, 200, llmStatus());
  if (m === "GET" && path === "/api/llm/detect") {
    await sleepRaw(500);
    return send(res, 200, {
      candidates: [
        { provider: "ollama", base_url: "http://127.0.0.1:11434/v1", models: S.ollamaRunning ? S.ollamaModels : [], reachable: S.ollamaRunning },
        { provider: "lmstudio", base_url: "http://127.0.0.1:1234/v1", models: S.lmstudioRunning ? ["lmstudio-community/qwen2.5-7b"] : [], reachable: S.lmstudioRunning },
      ],
    });
  }
  if (m === "POST" && path === "/api/llm/test") {
    await sleepRaw(700);
    const st = llmStatus();
    if (!st.reachable) return send(res, 200, { ok: false, latency_ms: 0, error: st.error });
    if (!st.model_available) return send(res, 200, { ok: false, latency_ms: 0, error: `Model “${st.model}” not found. Available: ${st.models.join(", ") || "none"}` });
    return send(res, 200, { ok: true, latency_ms: 412 });
  }
  if (m === "POST" && path === "/api/llm/pull") {
    const body = await readJson(req);
    if (!body.model) throw new HttpError(400, "bad_request", "model is required.");
    if (!S.ollamaRunning) throw new HttpError(409, "ollama_not_running", "Ollama isn't running.");
    send(res, 200, { ok: true });
    (async () => {
      broadcast("llm.pull", { status: "pulling manifest", completed: 0, total: 0, done: false });
      await sleepRaw(500);
      const total = 4_900_000_000;
      for (let i = 1; i <= 24; i++) {
        broadcast("llm.pull", { status: `pulling ${body.model}`, completed: Math.round((total * i) / 24), total, done: false });
        await sleepRaw(140);
      }
      broadcast("llm.pull", { status: "verifying sha256 digest", completed: total, total, done: false });
      await sleepRaw(400);
      if (!S.ollamaModels.includes(body.model)) S.ollamaModels.push(body.model);
      broadcast("llm.pull", { status: "success", completed: total, total, done: true });
    })();
    return;
  }
  if (m === "POST" && path === "/api/ollama/start") {
    await sleepRaw(900);
    S.ollamaRunning = true;
    return send(res, 200, { ok: true });
  }

  // ---- conversations
  if (path === "/api/conversations") {
    if (m === "GET") return send(res, 200, [...S.conversations.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    if (m === "POST") {
      const body = await readJson(req);
      const c = { id: nid("c"), title: (body.title || "New chat").slice(0, 120), created_at: now(), updated_at: now() };
      S.conversations.set(c.id, c);
      S.messages.set(c.id, []);
      return send(res, 200, c);
    }
  }
  if ((match = path.match(/^\/api\/conversations\/([^/]+)(?:\/(clear|messages))?$/))) {
    const conv = getConv(decodeURIComponent(match[1]));
    const sub = match[2];
    if (!sub && m === "GET") return send(res, 200, { conversation: conv, messages: S.messages.get(conv.id), tasks: [...S.tasks.values()].filter((t) => t.conversation_id === conv.id) });
    if (!sub && m === "PATCH") {
      const body = await readJson(req);
      if (!body.title) throw new HttpError(400, "bad_request", "title is required.");
      conv.title = String(body.title).slice(0, 120);
      conv.updated_at = now();
      return send(res, 200, conv);
    }
    if (!sub && m === "DELETE") {
      if ([...S.tasks.values()].some((t) => t.conversation_id === conv.id && ["queued", "running", "paused", "waiting_user"].includes(t.status))) throw new HttpError(409, "task_running", "Cancel the running task first.");
      S.conversations.delete(conv.id);
      S.messages.delete(conv.id);
      for (const [id, t] of S.tasks) if (t.conversation_id === conv.id) S.tasks.delete(id);
      return send(res, 200, { ok: true });
    }
    if (sub === "clear" && m === "POST") {
      S.messages.set(conv.id, []);
      for (const [id, t] of S.tasks) if (t.conversation_id === conv.id) S.tasks.delete(id);
      return send(res, 200, { ok: true });
    }
    if (sub === "messages" && m === "POST") {
      const body = await readJson(req);
      if (!body.text || !String(body.text).trim()) throw new HttpError(400, "bad_request", "text is required.");
      if (busyTaskId()) throw new HttpError(409, "task_running", "Another task is already running.");
      return send(res, 200, startTask(conv, String(body.text).trim()));
    }
  }

  // ---- tasks
  if (m === "GET" && path === "/api/tasks") {
    const limit = Number(url.searchParams.get("limit") || 30);
    const list = [...S.tasks.values()].sort((a, b) => (b.started_at ?? b.finished_at ?? "").localeCompare(a.started_at ?? a.finished_at ?? "")).slice(0, limit);
    return send(res, 200, list);
  }
  if ((match = path.match(/^\/api\/tasks\/([^/]+)(?:\/(pause|resume|cancel|retry|confirm|screenshot))?$/))) {
    const task = getTask(decodeURIComponent(match[1]));
    const sub = match[2];
    const ctl = S.controls.get(task.id);
    if (!sub && m === "GET") return send(res, 200, task);
    if (sub === "pause" && m === "POST") {
      if (ctl) ctl.paused = true;
      task.status = "paused";
      taskEvent(task, "task.status", { status: "paused", waiting: null, error: null, current: task.current });
      return send(res, 200, task);
    }
    if (sub === "resume" && m === "POST") {
      if (task.status === "waiting_user" && ctl?.waiter) {
        const w = ctl.waiter;
        ctl.waiter = null;
        w.resolve(true);
      } else if (ctl) {
        ctl.paused = false;
        task.status = "running";
        taskEvent(task, "task.status", { status: "running", waiting: null, error: null, current: task.current });
      }
      return send(res, 200, task);
    }
    if (sub === "cancel" && m === "POST") {
      if (ctl) {
        ctl.cancelled = true;
        ctl.paused = false;
        if (ctl.waiter) {
          ctl.waiter.reject(new Cancelled());
          ctl.waiter = null;
        }
      }
      return send(res, 200, task);
    }
    if (sub === "retry" && m === "POST") {
      if (busyTaskId()) throw new HttpError(409, "task_running", "Another task is already running.");
      return send(res, 200, startTask(getConv(task.conversation_id), task.goal));
    }
    if (sub === "confirm" && m === "POST") {
      const body = await readJson(req);
      if (!ctl?.waiter || task.waiting?.confirmation_id !== body.confirmation_id) throw new HttpError(409, "no_pending_confirmation", "There is nothing to confirm.");
      const w = ctl.waiter;
      ctl.waiter = null;
      w.resolve(body.approved === true);
      return send(res, 200, task);
    }
    if (sub === "screenshot" && m === "GET") {
      if (S.settings.agent.screenshots === "off") throw new HttpError(403, "screenshots_off", "Screenshots are turned off in Settings.");
      return send(res, 200, readFileSync(join(__dirname, "mock-screenshot.jpg")), { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
    }
  }

  if (m === "POST" && path === "/api/open-path") {
    const body = await readJson(req);
    if (!String(body.path || "").startsWith(DOWNLOADS)) throw new HttpError(400, "path_not_allowed", "That path is outside the downloads folder.");
    log("reveal in Finder:", body.path);
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, "not_found", `No route for ${m} ${path}`);
}

// ------------------------------------------------------------------ server

let port = 0;

function hostAllowed(host) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = {};
  try {
    if (!hostAllowed(req.headers.host || "")) throw new HttpError(403, "bad_host", "Unexpected Host header.");
    if (origin) {
      if (!ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, "bad_origin", `Origin ${origin} is not allowed.`);
      cors["Access-Control-Allow-Origin"] = origin;
      cors["Vary"] = "Origin";
    }
    if (req.method === "OPTIONS") {
      return send(res, 204, undefined, { ...cors, "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600" });
    }
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/health" && req.headers.authorization !== `Bearer ${TOKEN}`) throw new HttpError(401, "unauthorized", "Missing or invalid bearer token.");
    const patched = { writeHead: res.writeHead.bind(res) };
    res.writeHead = (status, headers) => patched.writeHead(status, { ...headers, ...cors });
    await route(req, res, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) log("error", e);
    if (!res.headersSent) send(res, status, { error: { code: e instanceof HttpError ? e.code : "internal", message: e.message || "Internal error" } }, cors);
  }
});

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => (protocols.has("jarvis.v1") ? "jarvis.v1" : false),
});

server.on("upgrade", (req, socket, head) => {
  const reject = (code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname !== "/api/events") return reject(404, "Not Found");
  if (!hostAllowed(req.headers.host || "")) return reject(403, "Forbidden");
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reject(403, "Forbidden");
  const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  if (!protocols.includes(`bearer.${TOKEN}`)) return reject(401, "Unauthorized");
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => sockets.delete(ws));
    ws.send(JSON.stringify({ seq: S.seq, ts: now(), type: "hello", data: { seq: S.seq } }));
  });
});

seed();

server.listen(REQUEST_PORT, "127.0.0.1", () => {
  port = server.address().port;
  // exactly one JSON line on stdout, like the real sidecar
  process.stdout.write(JSON.stringify({ event: "ready", port, version: VERSION, pid: process.pid }) + "\n");
  log(`listening on http://127.0.0.1:${port} (token: ${TOKEN === "devtoken" ? "devtoken" : "<from JARVIS_TOKEN>"})`);
  if (TOKEN === "devtoken") log(`browser dev URL: http://127.0.0.1:1420/?backend=http://127.0.0.1:${port}&token=${TOKEN}`);
});

// ------------------------------------------------------------------ lifecycle

const exit = (code = 0) => {
  for (const ws of sockets) ws.terminate();
  server.close();
  setTimeout(() => process.exit(code), 50).unref();
};
process.on("SIGTERM", () => {
  log("SIGTERM");
  exit(0);
});
process.on("SIGINT", () => exit(0));

// exit when the app that started us disappears (the real sidecar watches its parent pid too)
const parentPid = Number(process.env.JARVIS_PARENT_PID || process.ppid);
if (parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      log("parent gone, exiting");
      exit(0);
    }
  }, 1500).unref();
}
