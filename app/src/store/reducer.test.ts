import { describe, expect, it } from "vitest";
import type { ApiEvent, Message, Step, Task, Timings } from "../api/types";
import { applyEvent, coalesceDeltas, findBusyTaskId, initialCore, upsertTask, type CoreState, type DeltaEvent } from "./reducer";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  conversation_id: "c1",
  message_id: "m1",
  goal: "find flights",
  status: "running",
  started_at: "2026-01-01T10:00:00.000Z",
  finished_at: null,
  elapsed_ms: 0,
  steps: [],
  current: null,
  waiting: null,
  error: null,
  timings: null,
  parent_task_id: null,
  ...over,
});

const step = (over: Partial<Step> = {}): Step => ({
  id: "s1",
  index: 0,
  kind: "search",
  title: "Searching Google…",
  status: "running",
  started_at: "2026-01-01T10:00:01.000Z",
  elapsed_ms: null,
  ...over,
});

let seq = 0;
const ev = <T extends ApiEvent["type"]>(type: T, data: Extract<ApiEvent, { type: T }>["data"], extra: Partial<ApiEvent> = {}): ApiEvent =>
  ({ seq: ++seq, ts: "2026-01-01T10:00:02.000Z", type, conversation_id: "c1", task_id: "t1", data, ...extra }) as ApiEvent;

const withTask = (t: Task = task()): CoreState =>
  upsertTask(
    { ...initialCore, conversations: [{ id: "c1", title: "Chat", created_at: "x", updated_at: "x" }] },
    t,
  );

describe("applyEvent: tasks and steps", () => {
  it("creates a task and links the conversation status", () => {
    const base: CoreState = { ...initialCore, conversations: [{ id: "c1", title: "Chat", created_at: "x", updated_at: "x" }] };
    const s = applyEvent(base, ev("task.created", task()));
    expect(s.tasks["t1"]?.status).toBe("running");
    expect(s.taskOrder).toEqual(["t1"]);
    expect(s.conversations[0]?.last_task_status).toBe("running");
  });

  it("step.started appends a step and updates the current operation", () => {
    const s = applyEvent(withTask(), ev("step.started", step()));
    expect(s.tasks["t1"]?.steps).toHaveLength(1);
    expect(s.tasks["t1"]?.current?.title).toBe("Searching Google…");
  });

  it("step.finished replaces the same step id instead of appending", () => {
    let s = applyEvent(withTask(), ev("step.started", step()));
    s = applyEvent(s, ev("step.finished", step({ status: "ok", elapsed_ms: 1200 })));
    const steps = s.tasks["t1"]!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: "ok", elapsed_ms: 1200 });
  });

  it("page.updated sets the current url and page title", () => {
    const s = applyEvent(withTask(), ev("page.updated", { url: "https://example.com/a", title: "Example" }));
    expect(s.tasks["t1"]?.current).toMatchObject({ url: "https://example.com/a", page_title: "Example" });
  });

  it("task.status stores waiting info and clears it again", () => {
    let s = applyEvent(withTask(), ev("task.status", { status: "waiting_user", waiting: { kind: "captcha", message: "Solve it" } }));
    expect(s.tasks["t1"]?.waiting?.kind).toBe("captcha");
    s = applyEvent(s, ev("task.status", { status: "running" }));
    expect(s.tasks["t1"]?.waiting).toBeNull();
  });

  it("confirm.request marks the task as waiting for confirmation", () => {
    const s = applyEvent(withTask(), ev("confirm.request", { confirmation_id: "k1", kind: "purchase", question: "Buy?", detail: "€10" }));
    expect(s.tasks["t1"]).toMatchObject({ status: "waiting_user", waiting: { kind: "confirm", confirmation_id: "k1", message: "Buy?" } });
    expect(s.confirms["t1"]?.kind).toBe("purchase");
  });

  it("a terminal status sets finished_at and drops the pending confirmation", () => {
    let s = applyEvent(withTask(), ev("confirm.request", { confirmation_id: "k1", kind: "send", question: "Send?", detail: "" }));
    s = applyEvent(s, ev("task.status", { status: "cancelled" }));
    expect(s.tasks["t1"]?.finished_at).toBe("2026-01-01T10:00:02.000Z");
    expect(s.confirms["t1"]).toBeUndefined();
  });

  it("task.timings is attached and survives a stale REST snapshot", () => {
    const timings: Timings = { total_ms: 5000, planning_ms: 1, laya_ms: 2, browser_ms: 3, page_load_ms: 4, llm_calls: 1, laya_calls: 2, browser_ops: 3 };
    let s = applyEvent(withTask(), ev("task.timings", timings));
    expect(s.tasks["t1"]?.timings).toEqual(timings);
    s = upsertTask(s, task({ timings: null }));
    expect(s.tasks["t1"]?.timings).toEqual(timings);
  });

  it("ignores events for unknown tasks without throwing", () => {
    const s = applyEvent(initialCore, ev("step.started", step(), { task_id: "nope" }));
    expect(s.tasks).toEqual({});
  });

  it("tracks the highest seq", () => {
    const s = applyEvent(initialCore, { seq: 41, ts: "x", type: "hello", data: { seq: 41 } });
    expect(s.lastSeq).toBe(41);
  });

  it("findBusyTaskId returns the active task only", () => {
    const s = applyEvent(withTask(), ev("task.status", { status: "done" }));
    expect(findBusyTaskId(s.tasks)).toBeNull();
    expect(findBusyTaskId(withTask().tasks)).toBe("t1");
  });
});

describe("applyEvent: assistant messages", () => {
  const final: Message = {
    id: "m2",
    conversation_id: "c1",
    role: "assistant",
    text: "Final answer",
    cards: [{ type: "sources", items: [{ title: "A", url: "https://a.example" }] }],
    task_id: "t1",
    created_at: "x",
  };

  it("streams deltas into a provisional message", () => {
    let s = applyEvent(withTask(), ev("assistant.delta", { message_id: "m2", text: "Hel" }));
    s = applyEvent(s, ev("assistant.delta", { message_id: "m2", text: "lo" }));
    const list = s.messages["c1"]!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "m2", text: "Hello", streaming: true, role: "assistant" });
  });

  it("assistant.message replaces the streamed text and its cards arrive", () => {
    let s = applyEvent(withTask(), ev("assistant.delta", { message_id: "m2", text: "Partial" }));
    s = applyEvent(s, ev("assistant.message", final));
    const list = s.messages["c1"]!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ text: "Final answer", streaming: false });
    expect(list[0]?.cards).toHaveLength(1);
  });

  it("replaces a provisional message even when the final id differs", () => {
    let s = applyEvent(withTask(), ev("assistant.delta", { message_id: "tmp", text: "Partial" }));
    s = applyEvent(s, ev("assistant.message", final));
    expect(s.messages["c1"]!.map((m) => m.id)).toEqual(["m2"]);
  });

  it("does not append a late delta to a finished message", () => {
    let s = applyEvent(withTask(), ev("assistant.message", final));
    s = applyEvent(s, ev("assistant.delta", { message_id: "m2", text: " extra" }));
    expect(s.messages["c1"]![0]?.text).toBe("Final answer");
  });

  it("leaves other messages untouched (same object identity) while streaming", () => {
    let s = applyEvent(withTask(), ev("assistant.message", { ...final, id: "m0", text: "earlier" }));
    const before = s.messages["c1"]![0];
    s = applyEvent(s, ev("assistant.delta", { message_id: "m9", text: "x" }));
    expect(s.messages["c1"]![0]).toBe(before);
  });

  it("stops streaming when the task is cancelled", () => {
    let s = applyEvent(withTask(), ev("assistant.delta", { message_id: "m2", text: "Partial" }));
    s = applyEvent(s, ev("task.status", { status: "cancelled" }));
    expect(s.messages["c1"]![0]?.streaming).toBe(false);
  });
});

describe("applyEvent: system events", () => {
  it("stores chrome / laya / llm progress and notices", () => {
    let s = applyEvent(initialCore, ev("laya.download", { bytes: 5, total: 10, file: "m.safetensors", done: false }, { task_id: undefined, conversation_id: undefined }));
    expect(s.layaDownload).toMatchObject({ bytes: 5, total: 10 });
    s = applyEvent(s, ev("llm.pull", { status: "pulling", completed: 1, total: 4, done: false }));
    expect(s.llmPull?.completed).toBe(1);
    s = applyEvent(s, ev("notice", { level: "warn", message: "Heads up" }));
    expect(s.notices.at(-1)).toMatchObject({ level: "warn", message: "Heads up" });
  });

  it("collapses identical consecutive notices and caps the list", () => {
    let s = initialCore;
    for (let i = 0; i < 3; i++) s = applyEvent(s, ev("notice", { level: "info", message: "same" }));
    expect(s.notices).toHaveLength(1);
    for (let i = 0; i < 9; i++) s = applyEvent(s, ev("notice", { level: "info", message: `n${i}` }));
    expect(s.notices.length).toBeLessThanOrEqual(5);
  });
});

describe("coalesceDeltas", () => {
  const d = (message_id: string, text: string): DeltaEvent => ev("assistant.delta", { message_id, text }) as DeltaEvent;
  it("merges consecutive chunks of the same message and keeps order", () => {
    const out = coalesceDeltas([d("a", "He"), d("a", "llo"), d("b", "x"), d("a", "!")]);
    expect(out.map((e) => [e.data.message_id, e.data.text])).toEqual([["a", "Hello"], ["b", "x"], ["a", "!"]]);
  });
});
