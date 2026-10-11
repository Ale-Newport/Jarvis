// Application store (zustand): REST snapshots + WebSocket events -> one state tree.
import { create } from "zustand";
import { ApiError, api, errorMessage } from "../api/client";
import { EventStream, type StreamState } from "../api/events";
import type {
  ApiEvent,
  BackendInfo,
  ChromeMode,
  LlmStatus,
  OnboardingResult,
  Settings,
  SettingsPatch,
  SystemStatus,
  Task,
} from "../api/types";
import { titleFromPrompt } from "../lib/format";
import { deepMerge } from "../lib/merge";
import { KEYS, lsGetBool, lsSetBool } from "../lib/storage";
import { onBackendExited, resolveBackendInfo, restartBackend, type BackendExited } from "../lib/tauri";
import {
  addNotice,
  applyEvent,
  coalesceDeltas,
  dismissNotice,
  findBusyTaskId,
  initialCore,
  isActiveTask,
  removeMessage,
  replaceConversation,
  replacePending,
  upsertMessage,
  upsertTask,
  upsertTasks,
  type CoreState,
  type DeltaEvent,
  type UiMessage,
} from "./reducer";
import { useUi } from "./ui";

export type Phase = "booting" | "ready" | "error";

export interface AppState extends CoreState {
  phase: Phase;
  bootError: string | null;
  backendExited: BackendExited | null;
  stream: StreamState;
  /** performance.now()-style timestamp of when the stream went down (null while up) */
  streamDownSince: number | null;
  status: SystemStatus | null;
  settings: Settings | null;
  llm: LlmStatus | null;
  onboarding: OnboardingResult | null;
  onboardingChecking: boolean;
  activeId: string | null;
  conversationLoading: boolean;
  sending: boolean;
  chromeBusy: boolean;

  boot: () => Promise<void>;
  restartEngine: () => Promise<void>;
  retryConnection: () => void;
  resync: () => Promise<void>;
  runOnboardingCheck: () => Promise<OnboardingResult | null>;
  finishOnboarding: () => void;

  notify: (level: "info" | "warn" | "error", message: string) => void;
  notifyError: (e: unknown, prefix?: string) => void;
  dismiss: (id: number) => void;

  newChat: () => void;
  openConversation: (id: string | null) => Promise<void>;
  refreshConversations: () => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  sendMessage: (text: string) => Promise<boolean>;

  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  retryTask: (id: string) => Promise<void>;
  confirmTask: (task: Task, approved: boolean) => Promise<void>;
  refreshTasks: () => Promise<void>;

  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
  saveApiKey: (value: string) => Promise<boolean>;
  clearApiKey: () => Promise<void>;
  refreshLlm: () => Promise<void>;
  refreshStatus: () => Promise<void>;

  chromeConnect: (mode?: ChromeMode) => Promise<void>;
  chromeDisconnect: () => Promise<void>;
  chromeFocus: () => Promise<void>;
  chromeSetMode: (mode: ChromeMode) => Promise<void>;
}

let stream: EventStream | null = null;
let unlistenExit: (() => void) | null = null;
const fetchingTasks = new Set<string>();

// ------------------------------------------------------------------ event dispatch

let pendingDeltas: DeltaEvent[] = [];
let deltaTimer: ReturnType<typeof setTimeout> | null = null;
let convRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function flushDeltas(): void {
  if (deltaTimer) clearTimeout(deltaTimer);
  deltaTimer = null;
  if (pendingDeltas.length === 0) return;
  const batch = coalesceDeltas(pendingDeltas);
  pendingDeltas = [];
  useApp.setState((s) => batch.reduce<AppState>((acc, ev) => applyEvent(acc, ev), s));
}

export function dispatchEvent(ev: ApiEvent): void {
  if (ev.type === "assistant.delta") {
    pendingDeltas.push(ev);
    if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 33);
    return;
  }
  flushDeltas(); // keep ordering: deltas before whatever follows
  useApp.setState((s) => applyEvent(s, ev));
  afterEvent(ev);
}

function scheduleConversationRefresh(): void {
  if (convRefreshTimer) return;
  convRefreshTimer = setTimeout(() => {
    convRefreshTimer = null;
    void useApp.getState().refreshConversations();
  }, 700);
}

function afterEvent(ev: ApiEvent): void {
  const st = useApp.getState();
  switch (ev.type) {
    case "task.created":
    case "assistant.message":
      scheduleConversationRefresh();
      break;
    case "task.status":
      if (ev.task_id && ["done", "partial", "failed", "cancelled"].includes(ev.data.status)) {
        // reconcile once with the persisted snapshot (final elapsed_ms, steps, timings)
        void api
          .getTask(ev.task_id)
          .then((t) => useApp.setState((s) => upsertTask(s, t)))
          .catch(() => {});
        scheduleConversationRefresh();
      }
      break;
    case "llm.pull":
      if (ev.data.done && !ev.data.error) void st.refreshLlm();
      break;
    case "laya.download":
      if (ev.data.done) void api.layaStatus().then((laya) => useApp.setState({ laya })).catch(() => {});
      break;
    default:
      break;
  }
  // events about a task we have never seen (another window, missed task.created): fetch it
  if (ev.task_id && ev.type !== "task.created" && !st.tasks[ev.task_id] && !fetchingTasks.has(ev.task_id)) {
    const id = ev.task_id;
    fetchingTasks.add(id);
    void api
      .getTask(id)
      .then((t) => useApp.setState((s) => upsertTask(s, t)))
      .catch(() => {})
      .finally(() => fetchingTasks.delete(id));
  }
}

// ------------------------------------------------------------------ helpers

async function waitForHealth(): Promise<void> {
  let lastError: unknown = null;
  for (let i = 0; i < 20; i++) {
    try {
      await api.health();
      return;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, Math.min(1500, 200 + i * 150)));
    }
  }
  throw new Error(
    `The Jarvis engine did not answer at ${api.info.base_url}. ${lastError instanceof Error ? lastError.message : ""}`.trim(),
  );
}

function startStream(info: BackendInfo): void {
  stream?.stop();
  stream = new EventStream(info, {
    onEvent: dispatchEvent,
    onState: (state, meta) => {
      useApp.setState((s) => ({
        stream: state,
        streamDownSince: state === "open" ? null : (s.streamDownSince ?? Date.now()),
      }));
      if (state === "open" && meta.reconnected) void useApp.getState().resync();
    },
  });
  stream.start();
}

function mergeLoadedMessages(local: UiMessage[] | undefined, server: UiMessage[]): UiMessage[] {
  if (!local || local.length === 0) return server;
  const ids = new Set(server.map((m) => m.id));
  const keep = local.filter((m) => !ids.has(m.id) && (m.streaming || m.pending));
  return keep.length ? [...server, ...keep] : server;
}

function applyStatusSnapshot(st: SystemStatus): Partial<AppState> {
  return { status: st, chrome: st.chrome, laya: st.laya, llm: st.llm };
}

async function loadConversationInto(id: string): Promise<void> {
  const detail = await api.getConversation(id);
  useApp.setState((s) => {
    let next: AppState = {
      ...s,
      messages: { ...s.messages, [id]: mergeLoadedMessages(s.messages[id], detail.messages) },
    };
    next = upsertTasks(next, detail.tasks);
    return replaceConversation(next, detail.conversation);
  });
}

export const useApp = create<AppState>()((set, get) => ({
  ...initialCore,
  phase: "booting",
  bootError: null,
  backendExited: null,
  stream: "connecting",
  streamDownSince: null,
  status: null,
  settings: null,
  llm: null,
  onboarding: null,
  onboardingChecking: false,
  activeId: null,
  conversationLoading: false,
  sending: false,
  chromeBusy: false,

  // ---------------------------------------------------------------- boot / connection

  boot: async () => {
    set({ phase: "booting", bootError: null, backendExited: null });
    stream?.stop();
    try {
      const info = await resolveBackendInfo();
      api.configure(info);
      await waitForHealth();
      const [status, settings, conversations, tasks] = await Promise.all([
        api.status(),
        api.getSettings(),
        api.listConversations(),
        api.listTasks(30),
      ]);
      set((s) => {
        let next: AppState = { ...s, ...applyStatusSnapshot(status), settings, conversations };
        next = upsertTasks(next, tasks);
        next.taskOrder = tasks.map((t) => t.id);
        return next;
      });
      startStream(info);
      unlistenExit?.();
      void onBackendExited((p) => {
        stream?.stop();
        set({ backendExited: p, phase: "error", bootError: p.message });
      }).then((un) => (unlistenExit = un));

      // Resume watching a running task, otherwise open a fresh chat.
      const busy = findBusyTaskId(get().tasks);
      const busyTask = busy ? get().tasks[busy] : null;
      if (busyTask) await get().openConversation(busyTask.conversation_id);

      const result = await Promise.race([
        get().runOnboardingCheck(),
        new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
      ]);
      const onboarded = lsGetBool(KEYS.onboarded, false);
      if ((result && !result.ready) || !onboarded) useUi.getState().setOnboardingOpen(true);
      set({ phase: "ready" });
    } catch (e) {
      set({ phase: "error", bootError: errorMessage(e) });
    }
  },

  restartEngine: async () => {
    set({ phase: "booting", bootError: null });
    try {
      await restartBackend();
      await get().boot();
    } catch (e) {
      set({ phase: "error", bootError: errorMessage(e) });
    }
  },

  retryConnection: () => {
    if (get().phase === "error") void get().boot();
    else stream?.retryNow();
  },

  resync: async () => {
    try {
      const [status, settings, conversations, tasks] = await Promise.all([
        api.status(),
        api.getSettings(),
        api.listConversations(),
        api.listTasks(30),
      ]);
      set((s) => {
        let next: AppState = { ...s, ...applyStatusSnapshot(status), settings, conversations };
        next = upsertTasks(next, tasks);
        next.taskOrder = tasks.map((t) => t.id);
        return next;
      });
      const id = get().activeId;
      if (id) {
        try {
          await loadConversationInto(id);
        } catch (e) {
          // the conversation disappeared while we were away (e.g. the engine restarted): fall back to a new chat
          if (e instanceof ApiError && e.status === 404) set((s) => (s.activeId === id ? { activeId: null } : s));
          else throw e;
        }
      }
      // refresh any task we believe is still active (we may have missed its final events)
      await Promise.all(
        Object.values(get().tasks)
          .filter(isActiveTask)
          .map((t) =>
            api
              .getTask(t.id)
              .then((fresh) => set((s) => upsertTask(s, fresh)))
              .catch(() => {}),
          ),
      );
    } catch (e) {
      if (!(e instanceof ApiError && e.unreachable)) get().notifyError(e);
    }
  },

  runOnboardingCheck: async () => {
    set({ onboardingChecking: true });
    try {
      const result = await api.onboardingCheck();
      set({ onboarding: result, onboardingChecking: false });
      return result;
    } catch (e) {
      set({ onboardingChecking: false });
      get().notifyError(e, "Setup check failed");
      return null;
    }
  },

  finishOnboarding: () => {
    lsSetBool(KEYS.onboarded, true);
    useUi.getState().setOnboardingOpen(false);
    useUi.getState().focusComposer();
  },

  // ---------------------------------------------------------------- notices

  notify: (level, message) => set((s) => addNotice(s, level, message)),
  notifyError: (e, prefix) => {
    const msg = errorMessage(e);
    set((s) => addNotice(s, "error", prefix ? `${prefix}: ${msg}` : msg));
  },
  dismiss: (id) => set((s) => dismissNotice(s, id)),

  // ---------------------------------------------------------------- conversations

  newChat: () => {
    set({ activeId: null });
    useUi.getState().setDraft("");
    useUi.getState().focusComposer();
  },

  openConversation: async (id) => {
    set({ activeId: id });
    if (!id) return;
    const loaded = get().messages[id] !== undefined;
    if (!loaded) set({ conversationLoading: true });
    try {
      await loadConversationInto(id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        set((s) => ({ ...s, activeId: s.activeId === id ? null : s.activeId }));
        void get().refreshConversations();
      } else get().notifyError(e, "Couldn't open conversation");
    } finally {
      set({ conversationLoading: false });
    }
  },

  refreshConversations: async () => {
    try {
      const conversations = await api.listConversations();
      set((s) => {
        // keep a locally created conversation that the list snapshot does not know yet
        const known = new Set(conversations.map((c) => c.id));
        const extra = s.conversations.filter((c) => !known.has(c.id) && c.id === s.activeId);
        return { conversations: [...extra, ...conversations] };
      });
    } catch {
      /* transient */
    }
  },

  renameConversation: async (id, title) => {
    const clean = title.trim();
    if (!clean) return;
    const before = get().conversations;
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: clean } : c)) }));
    try {
      const conv = await api.renameConversation(id, clean);
      set((s) => replaceConversation(s, conv));
    } catch (e) {
      set({ conversations: before });
      get().notifyError(e, "Couldn't rename");
    }
  },

  deleteConversation: async (id) => {
    try {
      await api.deleteConversation(id);
      set((s) => {
        const { [id]: _m, ...messages } = s.messages;
        const tasks = Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => t.conversation_id !== id));
        return {
          conversations: s.conversations.filter((c) => c.id !== id),
          messages,
          tasks,
          taskOrder: s.taskOrder.filter((tid) => tasks[tid]),
          activeId: s.activeId === id ? null : s.activeId,
        };
      });
    } catch (e) {
      get().notifyError(e, "Couldn't delete");
    }
  },

  sendMessage: async (text) => {
    const clean = text.trim();
    if (!clean || get().sending) return false;
    const busy = findBusyTaskId(get().tasks);
    if (busy) {
      get().notify("warn", "Jarvis is still working on a task. Wait for it to finish or cancel it first.");
      return false;
    }
    set({ sending: true });
    let convId = get().activeId;
    let localId: string | null = null;
    try {
      if (!convId) {
        const conv = await api.createConversation(titleFromPrompt(clean));
        convId = conv.id;
        set((s) => ({ ...replaceConversation(s, conv), messages: { ...s.messages, [conv.id]: [] }, activeId: conv.id }));
      }
      localId = `local-${Date.now()}`;
      const optimistic: UiMessage = {
        id: localId,
        conversation_id: convId,
        role: "user",
        text: clean,
        cards: [],
        task_id: null,
        created_at: new Date().toISOString(),
        pending: true,
      };
      set((s) => upsertMessage(s, optimistic));
      const res = await api.sendMessage(convId, clean);
      set((s) => upsertTask(replacePending(s, convId!, localId!, res.message), res.task));
      return true;
    } catch (e) {
      if (convId && localId) set((s) => removeMessage(s, convId!, localId!));
      if (e instanceof ApiError && e.code === "task_running") {
        get().notify("warn", "Another task is already running. Wait for it to finish or cancel it first.");
        void get().refreshTasks();
      } else get().notifyError(e, "Couldn't send");
      return false;
    } finally {
      set({ sending: false });
    }
  },

  // ---------------------------------------------------------------- tasks

  pauseTask: async (id) => {
    try {
      const t = await api.pauseTask(id);
      set((s) => upsertTask(s, t));
    } catch (e) {
      get().notifyError(e, "Couldn't pause");
    }
  },
  resumeTask: async (id) => {
    try {
      const t = await api.resumeTask(id);
      set((s) => upsertTask(s, t));
    } catch (e) {
      get().notifyError(e, "Couldn't resume");
    }
  },
  cancelTask: async (id) => {
    try {
      const t = await api.cancelTask(id);
      set((s) => upsertTask(s, t));
    } catch (e) {
      get().notifyError(e, "Couldn't cancel");
    }
  },
  retryTask: async (id) => {
    try {
      const res = await api.retryTask(id);
      set((s) => upsertTask(upsertMessage(s, res.message), res.task));
      if (get().activeId !== res.task.conversation_id) await get().openConversation(res.task.conversation_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "task_running") get().notify("warn", "Another task is already running.");
      else get().notifyError(e, "Couldn't retry");
    }
  },
  confirmTask: async (task, approved) => {
    const confirmationId = task.waiting?.confirmation_id ?? get().confirms[task.id]?.confirmation_id;
    if (!confirmationId) {
      get().notify("warn", "This confirmation is no longer available.");
      return;
    }
    try {
      const t = await api.confirmTask(task.id, confirmationId, approved);
      set((s) => upsertTask(s, t));
    } catch (e) {
      get().notifyError(e, approved ? "Couldn't approve" : "Couldn't deny");
    }
  },
  refreshTasks: async () => {
    try {
      const tasks = await api.listTasks(30);
      set((s) => ({ ...upsertTasks(s, tasks), taskOrder: tasks.map((t) => t.id) }));
    } catch {
      /* transient */
    }
  },

  // ---------------------------------------------------------------- settings

  saveSettings: async (patch) => {
    const before = get().settings;
    if (before) set({ settings: deepMerge(before, patch) });
    try {
      const saved = await api.putSettings(patch);
      set({ settings: saved });
      if (patch.llm) void get().refreshLlm();
      if (patch.chrome) void api.chromeStatus().then((chrome) => set({ chrome })).catch(() => {});
      return true;
    } catch (e) {
      set({ settings: before });
      get().notifyError(e, "Couldn't save settings");
      return false;
    }
  },

  saveApiKey: async (value) => {
    try {
      await api.putSecret("llm_api_key", value);
      set((s) => (s.settings ? { settings: { ...s.settings, llm: { ...s.settings.llm, api_key_set: true } } } : s));
      void get().refreshLlm();
      return true;
    } catch (e) {
      get().notifyError(e, "Couldn't store the key");
      return false;
    }
  },

  clearApiKey: async () => {
    try {
      await api.deleteSecret("llm_api_key");
      set((s) => (s.settings ? { settings: { ...s.settings, llm: { ...s.settings.llm, api_key_set: false } } } : s));
      void get().refreshLlm();
    } catch (e) {
      get().notifyError(e, "Couldn't remove the key");
    }
  },

  refreshLlm: async () => {
    try {
      const llm = await api.llmStatus();
      set({ llm });
    } catch {
      /* transient */
    }
  },

  refreshStatus: async () => {
    try {
      const st = await api.status();
      set(applyStatusSnapshot(st));
    } catch {
      /* transient */
    }
  },

  // ---------------------------------------------------------------- chrome

  chromeConnect: async (mode) => {
    set({ chromeBusy: true });
    try {
      const chrome = await api.chromeConnect(mode);
      set({ chrome });
    } catch (e) {
      get().notifyError(e, "Couldn't connect to Chrome");
      void api.chromeStatus().then((chrome) => set({ chrome })).catch(() => {});
    } finally {
      set({ chromeBusy: false });
    }
  },

  chromeDisconnect: async () => {
    set({ chromeBusy: true });
    try {
      set({ chrome: await api.chromeDisconnect() });
    } catch (e) {
      get().notifyError(e, "Couldn't disconnect");
    } finally {
      set({ chromeBusy: false });
    }
  },

  chromeFocus: async () => {
    try {
      set({ chrome: await api.chromeFocus() });
    } catch (e) {
      get().notifyError(e, "Couldn't open the browser tab");
    }
  },

  chromeSetMode: async (mode) => {
    const wasConnected = get().chrome?.state === "connected";
    const ok = await get().saveSettings({ chrome: { mode } });
    if (!ok) return;
    if (wasConnected) {
      await get().chromeDisconnect();
      await get().chromeConnect(mode);
    }
  },
}));

// ------------------------------------------------------------------ selectors

export const selectBusyTaskId = (s: AppState): string | null => findBusyTaskId(s.tasks);

export const selectActiveMessages = (s: AppState): UiMessage[] | undefined => (s.activeId ? s.messages[s.activeId] : undefined);

/** True when the connected backend can run Laya at all (Apple Silicon + MLX). */
export const selectUnsupported = (s: AppState): string | null => {
  const st = s.status;
  if (!st) return null;
  if (st.arch !== "arm64") return `This Mac reports a ${st.arch} processor.`;
  if (!st.mlx_supported) return "MLX, the machine-learning runtime Laya uses, is not available on this Mac.";
  return null;
};
