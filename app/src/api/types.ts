// Types mirroring docs/API.md exactly (the binding contract between UI and backend).
// Keep this file in sync with that document.

// ---------------------------------------------------------------- system, onboarding, settings

export type CheckId =
  | "apple_silicon"
  | "macos"
  | "chrome"
  | "python"
  | "laya_model"
  | "text_model"
  | "chrome_connection";

export type Check = {
  id: CheckId;
  title: string;
  status: "ok" | "warn" | "error" | "pending";
  detail: string;
  action?: { id: string; label: string };
};

export type OnboardingResult = { checks: Check[]; ready: boolean };

export type SystemStatus = {
  version: string;
  arch: "arm64" | "x86_64";
  macos: string;
  mlx_supported: boolean;
  chrome: ChromeStatus;
  laya: LayaStatus;
  llm: LlmStatus;
  busy_task_id: string | null;
};

export type Appearance = "system" | "light" | "dark";
export type ChromeMode = "managed" | "existing";
export type LlmProvider = "ollama" | "lmstudio" | "openrouter" | "openai" | "custom";
export type ScreenshotsMode = "off" | "on_demand" | "per_step";

export type Settings = {
  appearance: Appearance;
  chrome: {
    mode: ChromeMode;
    path: string | null; // null = auto-detect
    keep_open_on_quit: boolean; // managed mode only (default false)
    existing_debug_port: number | null; // optional hint, e.g. 9222
  };
  llm: {
    provider: LlmProvider;
    base_url: string; // OpenAI-compatible, e.g. http://127.0.0.1:11434/v1
    model: string;
    api_key_set: boolean; // secret itself lives in the Keychain
    json_mode: "auto" | "on" | "off";
    reasoning: "default" | "off";
  };
  laya: { model: string }; // default "aac6fef/laya-typed-decisions-mlx"
  agent: {
    max_steps: number; // browser actions per task, default 60
    max_minutes: number; // wall clock per task, default 10
    confirm_sensitive: boolean; // default true; always true for payments
    allow_local_urls: boolean; // default false
    screenshots: ScreenshotsMode; // default "on_demand"
  };
};

/** Recursive partial used for PUT /api/settings (deep-merged server side). */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type SettingsPatch = DeepPartial<Settings>;

// ---------------------------------------------------------------- chrome

export type ChromeState = "disconnected" | "connecting" | "awaiting_permission" | "connected" | "error";

export type ChromeTab = { id: string; title: string; url: string; active: boolean };

export type ChromeStatus = {
  installed: boolean;
  path: string | null;
  version: string | null;
  mode: ChromeMode;
  state: ChromeState;
  // "existing" mode specifics:
  debugging: "unknown" | "off" | "on"; // is remote debugging reachable?
  how_to_enable?: string | null; // markdown steps when debugging is off
  profile_dir?: string | null; // managed mode automation profile
  tabs: ChromeTab[]; // tabs opened by Jarvis
  error?: string | null;
};

// ---------------------------------------------------------------- laya + text model

export type LayaState = "missing" | "downloading" | "loading" | "ready" | "unsupported" | "error";

export type LayaStatus = {
  model: string;
  downloaded: boolean;
  size_bytes: number | null;
  state: LayaState;
  load_ms?: number | null;
  warm_ms?: number | null;
  error?: string | null;
};

export type LlmStatus = {
  provider: string;
  base_url: string;
  model: string;
  remote: boolean; // true when base_url is not loopback -> data leaves this Mac
  reachable: boolean;
  model_available: boolean;
  models: string[]; // models the endpoint lists
  error?: string | null;
  disclosure: string[]; // plain-language list of what is sent to this provider
};

export type LlmCandidate = { provider: string; base_url: string; models: string[]; reachable: boolean };
export type LlmDetectResult = { candidates: LlmCandidate[] };
export type LlmTestResult = { ok: boolean; latency_ms: number; error?: string };

// ---------------------------------------------------------------- conversations, messages, tasks

export type LinksCard = {
  type: "links";
  title?: string;
  items: { title: string; url: string; snippet?: string }[];
};
export type ImagesCard = {
  type: "images";
  title?: string;
  items: {
    title: string;
    thumbnail_url: string | null;
    source_url: string | null;
    image_url: string | null;
    width?: number;
    height?: number;
    local_path?: string;
  }[];
};
export type TableCard = {
  type: "table";
  title?: string;
  columns: string[];
  rows: { cells: string[]; url?: string }[];
  note?: string;
};
export type FilesCard = {
  type: "files";
  items: { name: string; path: string; size?: number; url?: string }[];
};
export type SourcesCard = { type: "sources"; items: { title: string; url: string }[] };

export type Card = LinksCard | ImagesCard | TableCard | FilesCard | SourcesCard;

export type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  text: string; // markdown for assistant
  cards: Card[];
  task_id: string | null;
  created_at: string; // ISO 8601
};

export type Timings = {
  total_ms: number;
  planning_ms: number;
  laya_ms: number;
  browser_ms: number;
  page_load_ms: number;
  llm_calls: number;
  laya_calls: number;
  browser_ops: number;
};

export type StepKind =
  | "navigate"
  | "search"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "read"
  | "extract"
  | "plan"
  | "wait"
  | "tab"
  | "download"
  | "verify"
  | "confirm"
  | "key"
  | "back"
  | "forward";

export type StepStatus = "running" | "ok" | "error" | "skipped";

export type Step = {
  id: string;
  index: number;
  kind: StepKind;
  title: string; // "Searching Google…"
  detail?: string; // e.g. the typed text or the clicked element label
  url?: string;
  status: StepStatus;
  started_at: string;
  elapsed_ms: number | null;
  error?: string | null;
};

export type TaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting_user"
  | "done"
  | "partial"
  | "failed"
  | "cancelled";

export type WaitingKind = "confirm" | "captcha" | "login" | "manual";

export type Waiting = {
  kind: WaitingKind;
  message: string;
  confirmation_id?: string;
  detail?: string;
};

export type TaskCurrent = { title: string; url: string | null; page_title: string | null };

export type Task = {
  id: string;
  conversation_id: string;
  message_id: string;
  goal: string;
  status: TaskStatus;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number;
  steps: Step[];
  current: TaskCurrent | null;
  waiting: Waiting | null;
  error: string | null;
  timings: Timings | null;
  parent_task_id: string | null; // follow-ups reference the previous task whose context they continue
};

export type Conversation = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_task_status?: string;
};

export type ConversationDetail = { conversation: Conversation; messages: Message[]; tasks: Task[] };
export type SendMessageResult = { message: Message; task: Task };

// ---------------------------------------------------------------- websocket events

export type ConfirmKind = "purchase" | "payment" | "destructive" | "account" | "send" | "sensitive";

export type EventEnvelope = {
  seq: number;
  ts: string;
  conversation_id?: string;
  task_id?: string;
};

export type ApiEvent = EventEnvelope &
  (
    | { type: "hello"; data: { seq: number } }
    | { type: "task.created"; data: Task }
    | {
        type: "task.status";
        data: { status: TaskStatus; waiting?: Waiting | null; error?: string | null; current?: TaskCurrent | null };
      }
    | { type: "step.started"; data: Step }
    | { type: "step.finished"; data: Step }
    | { type: "page.updated"; data: { url: string; title: string } }
    | { type: "assistant.delta"; data: { message_id: string; text: string } }
    | { type: "assistant.message"; data: Message }
    | {
        type: "confirm.request";
        data: { confirmation_id: string; kind: ConfirmKind; question: string; detail: string };
      }
    | { type: "needs_user"; data: { kind: "captcha" | "login" | "manual"; message: string; url: string } }
    | { type: "task.timings"; data: Timings }
    | { type: "chrome.status"; data: ChromeStatus }
    | { type: "laya.status"; data: LayaStatus }
    | { type: "laya.download"; data: { bytes: number; total: number; file: string; done: boolean } }
    | { type: "llm.pull"; data: { status: string; completed: number; total: number; done: boolean; error?: string } }
    | { type: "notice"; data: { level: "info" | "warn" | "error"; message: string } }
  );

export type ApiEventType = ApiEvent["type"];

export type LayaDownloadProgress = { bytes: number; total: number; file: string; done: boolean };
export type LlmPullProgress = { status: string; completed: number; total: number; done: boolean; error?: string };

export type BackendInfo = { base_url: string; token: string };
