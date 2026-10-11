// Pure event reducer: every WebSocket event funnels through `applyEvent`, keyed by task / conversation.
// It has no React or network dependencies so it is trivially unit-testable.
import type {
  ApiEvent,
  ChromeStatus,
  ConfirmKind,
  Conversation,
  LayaDownloadProgress,
  LayaStatus,
  LlmPullProgress,
  Message,
  Step,
  Task,
  TaskStatus,
} from "../api/types";

export type UiMessage = Message & {
  /** assistant text that is still being streamed (not yet replaced by `assistant.message`) */
  streaming?: boolean;
  /** optimistic user message not yet acknowledged by the backend */
  pending?: boolean;
};

export type ConfirmRequest = { confirmation_id: string; kind: ConfirmKind; question: string; detail: string };

export type Notice = { id: number; level: "info" | "warn" | "error"; message: string; ts: number };

export interface CoreState {
  conversations: Conversation[];
  /** messages by conversation id */
  messages: Record<string, UiMessage[]>;
  /** every task we know about, by id */
  tasks: Record<string, Task>;
  /** recent task ids, newest first (sidebar "Recent tasks") */
  taskOrder: string[];
  chrome: ChromeStatus | null;
  laya: LayaStatus | null;
  layaDownload: LayaDownloadProgress | null;
  llmPull: LlmPullProgress | null;
  /** last confirm.request per task (kind is not part of Task.waiting) */
  confirms: Record<string, ConfirmRequest>;
  notices: Notice[];
  lastSeq: number;
}

export const initialCore: CoreState = {
  conversations: [],
  messages: {},
  tasks: {},
  taskOrder: [],
  chrome: null,
  laya: null,
  layaDownload: null,
  llmPull: null,
  confirms: {},
  notices: [],
  lastSeq: 0,
};

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["queued", "running", "paused", "waiting_user"]);
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "partial", "failed", "cancelled"]);

export const isActiveTask = (t: Task | null | undefined): boolean => !!t && ACTIVE_STATUSES.has(t.status);

let noticeCounter = 1;
export function makeNotice(level: Notice["level"], message: string, ts = Date.now()): Notice {
  return { id: noticeCounter++, level, message, ts };
}

const MAX_NOTICES = 5;

export function addNotice<S extends CoreState>(state: S, level: Notice["level"], message: string): S {
  // collapse identical consecutive notices
  const last = state.notices[state.notices.length - 1];
  if (last && last.message === message && last.level === level) return state;
  const notices = [...state.notices, makeNotice(level, message)].slice(-MAX_NOTICES);
  return { ...state, notices };
}

export function dismissNotice<S extends CoreState>(state: S, id: number): S {
  return { ...state, notices: state.notices.filter((n) => n.id !== id) };
}

// ------------------------------------------------------------------ helpers

export function upsertTask<S extends CoreState>(state: S, task: Task): S {
  const existing = state.tasks[task.id];
  // Never lose steps/timings we already received over the socket if a REST snapshot is older.
  const merged: Task = existing && existing.steps.length > task.steps.length && isActiveTask(existing) && isActiveTask(task)
    ? { ...task, steps: existing.steps }
    : task;
  const withTimings: Task = !merged.timings && existing?.timings ? { ...merged, timings: existing.timings } : merged;
  const taskOrder = state.taskOrder.includes(task.id) ? state.taskOrder : [task.id, ...state.taskOrder];
  return syncConversationStatus({ ...state, tasks: { ...state.tasks, [task.id]: withTimings }, taskOrder }, withTimings);
}

export function upsertTasks<S extends CoreState>(state: S, tasks: Task[]): S {
  return tasks.reduce((s, t) => upsertTask(s, t), state);
}

function syncConversationStatus<S extends CoreState>(state: S, task: Task): S {
  const i = state.conversations.findIndex((c) => c.id === task.conversation_id);
  if (i === -1) return state;
  const conv = state.conversations[i]!;
  if (conv.last_task_status === task.status) return state;
  const conversations = state.conversations.slice();
  conversations[i] = { ...conv, last_task_status: task.status };
  return { ...state, conversations };
}

function touchConversation<S extends CoreState>(state: S, id: string | undefined, ts: string): S {
  if (!id) return state;
  const i = state.conversations.findIndex((c) => c.id === id);
  if (i === -1) return state;
  const conversations = state.conversations.slice();
  conversations[i] = { ...conversations[i]!, updated_at: ts };
  return { ...state, conversations };
}

function patchTask<S extends CoreState>(state: S, id: string | undefined, fn: (t: Task) => Task): S {
  if (!id) return state;
  const t = state.tasks[id];
  if (!t) return state;
  const next = fn(t);
  if (next === t) return state;
  return syncConversationStatus({ ...state, tasks: { ...state.tasks, [id]: next } }, next);
}

function setMessages<S extends CoreState>(state: S, convId: string, fn: (list: UiMessage[]) => UiMessage[]): S {
  const list = state.messages[convId] ?? [];
  const next = fn(list);
  if (next === list) return state;
  return { ...state, messages: { ...state.messages, [convId]: next } };
}

export function upsertMessage<S extends CoreState>(state: S, msg: UiMessage): S {
  return setMessages(state, msg.conversation_id, (list) => {
    // exact id match (also replaces an optimistic copy with the same id)
    const same = list.findIndex((m) => m.id === msg.id);
    if (same !== -1) {
      const next = list.slice();
      next[same] = msg;
      return next;
    }
    // a streamed provisional message of the same task is replaced in place by the final one
    if (msg.role === "assistant" && msg.task_id && !msg.streaming) {
      const prov = list.findIndex((m) => m.streaming && m.role === "assistant" && m.task_id === msg.task_id);
      if (prov !== -1) {
        const next = list.slice();
        next[prov] = msg;
        return next;
      }
    }
    return [...list, msg];
  });
}

/** Replace the optimistic local message by the acknowledged one. */
export function replacePending<S extends CoreState>(state: S, convId: string, localId: string, msg: Message): S {
  return setMessages(state, convId, (list) => {
    const withoutLocal = list.filter((m) => m.id !== localId);
    const exists = withoutLocal.some((m) => m.id === msg.id);
    return exists ? withoutLocal.map((m) => (m.id === msg.id ? msg : m)) : [...withoutLocal, msg];
  });
}

export function removeMessage<S extends CoreState>(state: S, convId: string, id: string): S {
  return setMessages(state, convId, (list) => {
    const next = list.filter((m) => m.id !== id);
    return next.length === list.length ? list : next;
  });
}

function endStreaming<S extends CoreState>(state: S, taskId: string | undefined): S {
  if (!taskId) return state;
  const task = state.tasks[taskId];
  const convId = task?.conversation_id;
  if (!convId) return state;
  return setMessages(state, convId, (list) => {
    if (!list.some((m) => m.streaming && m.task_id === taskId)) return list;
    return list.map((m) => (m.streaming && m.task_id === taskId ? { ...m, streaming: false } : m));
  });
}

function stepFromEvent(task: Task, step: Step): Task {
  const i = task.steps.findIndex((s) => s.id === step.id);
  const steps = i === -1 ? [...task.steps, step] : task.steps.map((s, j) => (j === i ? { ...s, ...step } : s));
  return { ...task, steps };
}

// ------------------------------------------------------------------ the reducer

/** Returns the same object when the event changes nothing. */
export function applyEvent<S extends CoreState>(state: S, ev: ApiEvent): S {
  const seq = typeof ev.seq === "number" && ev.seq > state.lastSeq ? ev.seq : state.lastSeq;
  const s: S = seq === state.lastSeq ? state : { ...state, lastSeq: seq };

  switch (ev.type) {
    case "hello":
      return s;

    case "task.created":
      return touchConversation(upsertTask(s, ev.data), ev.data.conversation_id, ev.ts);

    case "task.status": {
      const d = ev.data;
      let out = patchTask(s, ev.task_id, (t) => {
        const terminal = TERMINAL_STATUSES.has(d.status);
        const waiting = d.waiting !== undefined ? d.waiting : d.status === "waiting_user" ? t.waiting : null;
        return {
          ...t,
          status: d.status,
          waiting,
          error: d.error !== undefined ? d.error : t.error,
          current: d.current !== undefined ? d.current : t.current,
          finished_at: terminal && !t.finished_at ? ev.ts : t.finished_at,
        };
      });
      if (ev.task_id && d.status !== "waiting_user" && out.confirms[ev.task_id]) {
        const { [ev.task_id]: _gone, ...rest } = out.confirms;
        out = { ...out, confirms: rest };
      }
      if (TERMINAL_STATUSES.has(d.status)) out = endStreaming(out, ev.task_id);
      return out;
    }

    case "step.started":
    case "step.finished": {
      const step = ev.data;
      const running = ev.type === "step.started";
      return patchTask(s, ev.task_id, (t) => {
        const withStep = stepFromEvent(t, step);
        return {
          ...withStep,
          status: t.status === "queued" ? "running" : t.status,
          current: running
            ? { title: step.title, url: step.url ?? t.current?.url ?? null, page_title: t.current?.page_title ?? null }
            : t.current
              ? { ...t.current, url: step.url ?? t.current.url }
              : t.current,
        };
      });
    }

    case "page.updated":
      return patchTask(s, ev.task_id, (t) => ({
        ...t,
        current: { title: t.current?.title ?? "", url: ev.data.url, page_title: ev.data.title },
      }));

    case "assistant.delta": {
      const convId = ev.conversation_id ?? (ev.task_id ? s.tasks[ev.task_id]?.conversation_id : undefined);
      if (!convId) return s;
      const { message_id, text } = ev.data;
      return setMessages(s, convId, (list) => {
        const i = list.findIndex((m) => m.id === message_id);
        if (i === -1) {
          const created: UiMessage = {
            id: message_id,
            conversation_id: convId,
            role: "assistant",
            text,
            cards: [],
            task_id: ev.task_id ?? null,
            created_at: ev.ts,
            streaming: true,
          };
          return [...list, created];
        }
        const cur = list[i]!;
        if (!cur.streaming && (cur.text !== "" || cur.cards.length > 0)) return list; // final message already arrived
        const next = list.slice();
        next[i] = { ...cur, text: cur.text + text, streaming: true };
        return next;
      });
    }

    case "assistant.message":
      return upsertMessage(touchConversation(s, ev.data.conversation_id, ev.ts), { ...ev.data, streaming: false });

    case "confirm.request": {
      const d = ev.data;
      if (!ev.task_id) return s;
      let out: S = { ...s, confirms: { ...s.confirms, [ev.task_id]: d } };
      out = patchTask(out, ev.task_id, (t) => ({
        ...t,
        status: "waiting_user",
        waiting: {
          kind: "confirm",
          message: d.question,
          detail: d.detail || t.waiting?.detail,
          confirmation_id: d.confirmation_id,
        },
      }));
      return out;
    }

    case "needs_user":
      return patchTask(s, ev.task_id, (t) => ({
        ...t,
        status: "waiting_user",
        waiting: { kind: ev.data.kind, message: ev.data.message, detail: ev.data.url || undefined },
        current: t.current ? { ...t.current, url: ev.data.url || t.current.url } : t.current,
      }));

    case "task.timings":
      return patchTask(s, ev.task_id, (t) => ({ ...t, timings: ev.data }));

    case "chrome.status":
      return { ...s, chrome: ev.data };

    case "laya.status":
      return { ...s, laya: ev.data };

    case "laya.download":
      return { ...s, layaDownload: ev.data };

    case "llm.pull":
      return { ...s, llmPull: ev.data };

    case "notice":
      return addNotice(s, ev.data.level, ev.data.message);

    default:
      return s;
  }
}

/** Latest active task id (there is at most one at a time, the backend runs one task). */
export function findBusyTaskId(tasks: Record<string, Task>): string | null {
  let best: Task | null = null;
  for (const t of Object.values(tasks)) {
    if (!ACTIVE_STATUSES.has(t.status)) continue;
    if (!best || (t.started_at ?? "") > (best.started_at ?? "")) best = t;
  }
  return best?.id ?? null;
}

export function replaceConversation<S extends CoreState>(state: S, conv: Conversation): S {
  const i = state.conversations.findIndex((c) => c.id === conv.id);
  const conversations =
    i === -1 ? [conv, ...state.conversations] : state.conversations.map((c, j) => (j === i ? { ...c, ...conv } : c));
  return { ...state, conversations };
}

export type DeltaEvent = Extract<ApiEvent, { type: "assistant.delta" }>;

/** Merge consecutive deltas of the same message so one flush = one state update per message. */
export function coalesceDeltas(events: DeltaEvent[]): DeltaEvent[] {
  const out: DeltaEvent[] = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (prev && prev.data.message_id === ev.data.message_id && prev.task_id === ev.task_id) {
      out[out.length - 1] = { ...prev, seq: ev.seq, data: { ...prev.data, text: prev.data.text + ev.data.text } };
    } else out.push(ev);
  }
  return out;
}
