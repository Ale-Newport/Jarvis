import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, EventStream } from "./events";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWS.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("backoffDelay", () => {
  it("grows exponentially and is capped at 5 s", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(backoffDelay)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });
});

describe("EventStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("connects with the contract subprotocols, reconnects with backoff and flags reconnects", () => {
    const states: [string, boolean][] = [];
    const events: string[] = [];
    const s = new EventStream(
      { base_url: "http://127.0.0.1:9", token: "tok" },
      { onEvent: (e) => events.push(e.type), onState: (st, meta) => states.push([st, meta.reconnected]) },
      FakeWS as unknown as new (u: string, p?: string | string[]) => WebSocket,
    );
    s.start();
    const first = FakeWS.instances[0]!;
    expect(first.url).toBe("ws://127.0.0.1:9/api/events");
    expect(first.protocols).toEqual(["jarvis.v1", "bearer.tok"]);
    first.open();
    first.onmessage?.({ data: JSON.stringify({ seq: 1, ts: "t", type: "hello", data: { seq: 1 } }) });
    first.onmessage?.({ data: "not json" });
    expect(events).toEqual(["hello"]);

    first.drop();
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1]!.open();
    expect(states.at(-1)).toEqual(["open", true]); // reconnected = true => store re-syncs REST state

    FakeWS.instances[1]!.drop();
    FakeWS.instances[1]!.drop(); // duplicate close must not schedule twice
    vi.advanceTimersByTime(250);
    expect(FakeWS.instances).toHaveLength(3);
    s.stop();
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.instances).toHaveLength(3);
  });
});
