// WebSocket event stream with automatic reconnect (exponential backoff, capped at 5 s).
import { toWsUrl, wsProtocols } from "./client";
import type { ApiEvent, BackendInfo } from "./types";

export type StreamState = "connecting" | "open" | "closed";

export type StreamHandlers = {
  onEvent: (ev: ApiEvent) => void;
  onState: (state: StreamState, meta: { reconnected: boolean }) => void;
};

export const MAX_BACKOFF_MS = 5000;
export const BASE_BACKOFF_MS = 250;

export function backoffDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt));
}

type WsCtor = new (url: string, protocols?: string | string[]) => WebSocket;

export class EventStream {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private everOpened = false;

  constructor(
    private info: BackendInfo,
    private handlers: StreamHandlers,
    private WS: WsCtor = WebSocket,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Force an immediate reconnect attempt (the "Retry" button). */
  retryNow(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws && this.ws.readyState <= 1) return;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.handlers.onState("connecting", { reconnected: this.everOpened });
    let ws: WebSocket;
    try {
      ws = new this.WS(toWsUrl(this.info.base_url), wsProtocols(this.info.token));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.handlers.onState("open", { reconnected });
    };
    ws.onmessage = (m: MessageEvent) => {
      if (typeof m.data !== "string") return;
      try {
        this.handlers.onEvent(JSON.parse(m.data) as ApiEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onState("closed", { reconnected: this.everOpened });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = backoffDelay(this.attempt++);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
