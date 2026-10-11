import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, toWsUrl, wsProtocols } from "./client";

function clientWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const c = new ApiClient();
  c.configure({ base_url: "http://127.0.0.1:5000/", token: "tok123" });
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  c.fetchImpl = fn as unknown as typeof fetch;
  return { c, fn };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ApiClient", () => {
  it("sends the Bearer token and joins the base url without a double slash", async () => {
    const { c, fn } = clientWith(() => json({ arch: "arm64" }));
    await c.status();
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:5000/api/status");
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok123");
  });

  it("does not send auth to /health", async () => {
    const { c, fn } = clientWith(() => json({ status: "ready", version: "1" }));
    await c.health();
    expect((fn.mock.calls[0]![1]!.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("serialises JSON bodies and sets the content type", async () => {
    const { c, fn } = clientWith(() => json({ message: {}, task: {} }));
    await c.sendMessage("c 1", "hello");
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:5000/api/conversations/c%201/messages");
    expect(init!.method).toBe("POST");
    expect(init!.body).toBe('{"text":"hello"}');
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("maps {error:{code,message}} responses to ApiError", async () => {
    const { c } = clientWith(() => json({ error: { code: "task_running", message: "Another task is running" } }, 409));
    const err = await c.sendMessage("c1", "x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "task_running", status: 409, message: "Another task is running" });
  });

  it("falls back to a generic error for non-JSON failures", async () => {
    const { c } = clientWith(() => new Response("boom", { status: 502 }));
    const err = await c.status().catch((e) => e);
    expect(err).toMatchObject({ code: "http_502", status: 502 });
  });

  it("reports an unreachable backend (network failure) with status 0", async () => {
    const c = new ApiClient();
    c.configure({ base_url: "http://127.0.0.1:1", token: "t" });
    c.fetchImpl = (async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch;
    const err = await c.status().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.unreachable).toBe(true);
    expect(err.code).toBe("unreachable");
  });

  it("refuses to call before it is configured", async () => {
    const c = new ApiClient();
    await expect(c.status()).rejects.toMatchObject({ code: "not_configured" });
  });

  it("returns the screenshot as a Blob", async () => {
    const { c } = clientWith(() => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    const blob = await c.screenshot("t1");
    expect(blob.size).toBe(3);
  });

  it("posts the confirmation payload exactly as the contract says", async () => {
    const { c, fn } = clientWith(() => json({ id: "t1" }));
    await c.confirmTask("t1", "k9", true);
    expect(fn.mock.calls[0]![1]!.body).toBe('{"confirmation_id":"k9","approved":true}');
  });
});

describe("websocket helpers", () => {
  it("derives the ws url from the base url", () => {
    expect(toWsUrl("http://127.0.0.1:53211")).toBe("ws://127.0.0.1:53211/api/events");
    expect(toWsUrl("http://127.0.0.1:53211/")).toBe("ws://127.0.0.1:53211/api/events");
  });
  it("offers the jarvis.v1 and bearer subprotocols", () => {
    expect(wsProtocols("abc")).toEqual(["jarvis.v1", "bearer.abc"]);
  });
});
