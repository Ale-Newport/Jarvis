// The one typed REST client. Every call goes through `request()` (Bearer auth, JSON, error mapping).
import type {
  BackendInfo,
  ChromeMode,
  ChromeStatus,
  Conversation,
  ConversationDetail,
  LayaStatus,
  LlmDetectResult,
  LlmStatus,
  LlmTestResult,
  OnboardingResult,
  SendMessageResult,
  Settings,
  SettingsPatch,
  SystemStatus,
  Task,
} from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
  /** True when the backend could not be reached at all (as opposed to answering with an error). */
  get unreachable(): boolean {
    return this.status === 0;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong.";
}

type RequestOptions = {
  body?: unknown;
  /** milliseconds; the Chrome connect long-poll needs more than the default */
  timeoutMs?: number;
  auth?: boolean;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "") + "/api/events";
}

export function wsProtocols(token: string): string[] {
  return ["jarvis.v1", "bearer." + token];
}

export class ApiClient {
  private baseUrl = "";
  private token = "";
  /** replaceable for tests */
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  configure(info: BackendInfo): void {
    this.baseUrl = info.base_url.replace(/\/+$/, "");
    this.token = info.token;
  }

  get configured(): boolean {
    return this.baseUrl !== "";
  }

  get info(): BackendInfo {
    return { base_url: this.baseUrl, token: this.token };
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError("bad_response", "The backend sent a response the app could not read.", res.status);
    }
  }

  private async raw(method: string, path: string, opts: RequestOptions): Promise<Response> {
    if (!this.configured) throw new ApiError("not_configured", "The backend connection is not set up yet.", 0);
    const headers: Record<string, string> = {};
    if (opts.auth !== false) headers["Authorization"] = `Bearer ${this.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opts.signal ? anySignal([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { method, headers, body, signal });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      throw new ApiError(
        timedOut ? "timeout" : "unreachable",
        timedOut ? "The backend took too long to answer." : "Can't reach the Jarvis engine.",
        0,
      );
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  // ------------------------------------------------------------------ system

  health = () => this.request<{ status: string; version: string }>("GET", "/health", { auth: false, timeoutMs: 4000 });
  status = () => this.request<SystemStatus>("GET", "/api/status");
  onboardingCheck = () => this.request<OnboardingResult>("POST", "/api/onboarding/check", { timeoutMs: 60_000 });
  getSettings = () => this.request<Settings>("GET", "/api/settings");
  putSettings = (patch: SettingsPatch) => this.request<Settings>("PUT", "/api/settings", { body: patch });
  putSecret = (name: string, value: string) =>
    this.request<{ name: string; set: boolean }>("PUT", `/api/secrets/${encodeURIComponent(name)}`, { body: { value } });
  deleteSecret = (name: string) =>
    this.request<{ name: string; set: boolean }>("DELETE", `/api/secrets/${encodeURIComponent(name)}`);
  shutdown = () => this.request<{ ok: boolean }>("POST", "/api/shutdown");

  // ------------------------------------------------------------------ chrome

  chromeStatus = () => this.request<ChromeStatus>("GET", "/api/chrome/status");
  /** Long poll (<= 60 s on the server); status events keep flowing meanwhile. */
  chromeConnect = (mode?: ChromeMode) =>
    this.request<ChromeStatus>("POST", "/api/chrome/connect", { body: mode ? { mode } : {}, timeoutMs: 75_000 });
  chromeDisconnect = () => this.request<ChromeStatus>("POST", "/api/chrome/disconnect", { body: {} });
  chromeResetProfile = () =>
    this.request<ChromeStatus>("POST", "/api/chrome/reset-profile", { body: { confirm: true } });
  chromeFocus = () => this.request<ChromeStatus>("POST", "/api/chrome/focus", { body: {} });
  chromeSetPath = (path: string) => this.request<ChromeStatus>("PUT", "/api/chrome/path", { body: { path } });

  // ------------------------------------------------------------------ laya + text model

  layaStatus = () => this.request<LayaStatus>("GET", "/api/laya/status");
  layaDownload = () => this.request<LayaStatus>("POST", "/api/laya/download", { body: {} });
  layaLoad = () => this.request<LayaStatus>("POST", "/api/laya/load", { body: {}, timeoutMs: 120_000 });
  llmStatus = () => this.request<LlmStatus>("GET", "/api/llm/status", { timeoutMs: 20_000 });
  llmDetect = () => this.request<LlmDetectResult>("GET", "/api/llm/detect", { timeoutMs: 20_000 });
  llmTest = () => this.request<LlmTestResult>("POST", "/api/llm/test", { body: {}, timeoutMs: 90_000 });
  llmPull = (model: string) => this.request<{ ok: boolean }>("POST", "/api/llm/pull", { body: { model }, timeoutMs: 60_000 });
  ollamaStart = () => this.request<{ ok: boolean }>("POST", "/api/ollama/start", { body: {}, timeoutMs: 60_000 });

  // ------------------------------------------------------------------ conversations / tasks

  listConversations = () => this.request<Conversation[]>("GET", "/api/conversations");
  createConversation = (title?: string) =>
    this.request<Conversation>("POST", "/api/conversations", { body: title ? { title } : {} });
  getConversation = (id: string) =>
    this.request<ConversationDetail>("GET", `/api/conversations/${encodeURIComponent(id)}`);
  renameConversation = (id: string, title: string) =>
    this.request<Conversation>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, { body: { title } });
  deleteConversation = (id: string) =>
    this.request<{ ok: boolean }>("DELETE", `/api/conversations/${encodeURIComponent(id)}`);
  clearConversation = (id: string) =>
    this.request<{ ok: boolean }>("POST", `/api/conversations/${encodeURIComponent(id)}/clear`, { body: {} });
  sendMessage = (conversationId: string, text: string) =>
    this.request<SendMessageResult>("POST", `/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      body: { text },
    });

  listTasks = (limit = 30) => this.request<Task[]>("GET", `/api/tasks?limit=${limit}`);
  getTask = (id: string) => this.request<Task>("GET", `/api/tasks/${encodeURIComponent(id)}`);
  pauseTask = (id: string) => this.request<Task>("POST", `/api/tasks/${encodeURIComponent(id)}/pause`, { body: {} });
  resumeTask = (id: string) => this.request<Task>("POST", `/api/tasks/${encodeURIComponent(id)}/resume`, { body: {} });
  cancelTask = (id: string) => this.request<Task>("POST", `/api/tasks/${encodeURIComponent(id)}/cancel`, { body: {} });
  retryTask = (id: string) =>
    this.request<SendMessageResult>("POST", `/api/tasks/${encodeURIComponent(id)}/retry`, { body: {} });
  confirmTask = (id: string, confirmationId: string, approved: boolean) =>
    this.request<Task>("POST", `/api/tasks/${encodeURIComponent(id)}/confirm`, {
      body: { confirmation_id: confirmationId, approved },
    });
  /** One capture per call. Returns the JPEG as a Blob. */
  async screenshot(id: string, signal?: AbortSignal): Promise<Blob> {
    const res = await this.raw("GET", `/api/tasks/${encodeURIComponent(id)}/screenshot`, { signal, timeoutMs: 15_000 });
    return res.blob();
  }
  openPath = (path: string) => this.request<{ ok: boolean }>("POST", "/api/open-path", { body: { path } });
}

/** AbortSignal.any needs Safari 17.4; the app supports macOS 14.0 (Safari 17.0). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = `The backend answered with HTTP ${res.status}.`;
  try {
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    const err = json?.error;
    if (err && typeof err === "object") {
      if (typeof err.code === "string") code = err.code;
      if (typeof err.message === "string") message = err.message;
    } else if (typeof json?.detail === "string") {
      message = json.detail; // tolerate FastAPI-style errors
    }
  } catch {
    /* keep defaults */
  }
  return new ApiError(code, message, res.status);
}

/** Singleton used by the whole app. */
export const api = new ApiClient();
