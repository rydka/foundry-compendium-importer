// C5: minimal Ollama client (scripts/core/ai/ollama.mjs), `fetch` injected. Statuses: ok | unreachable | timeout |
// aborted | http | invalid.
import { describe, expect, it, vi } from "vitest";
import { chat } from "../../scripts/core/ai/ollama.mjs";

const URL_BASE = "http://localhost:11434";
const body = { model: "m", messages: [{ role: "user", content: "hi" }], stream: false };
const response = ({ ok = true, status = 200, json, text } = {}) => ({
  ok, status,
  json: json ?? (async () => { throw new SyntaxError("Unexpected token"); }),
  text: text ?? (async () => "")
});
const okResponse = () => response({ json: async () => ({ message: { role: "assistant", content: "{\"a\":1}" }, done: true }) });

describe("chat", () => {
  it("returns ok with the parsed answer", async () => {
    const fetch = vi.fn(async () => okResponse());
    const r = await chat(URL_BASE, body, { fetch, timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ok");
    expect(r.json).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("localhost:11434");
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe("m");
  });

  it("reports an unreachable server (fetch rejects)", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await chat(URL_BASE, body, { fetch, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: "unreachable" });
  });

  it("reports a timeout when the server does not answer in time, and aborts the request", async () => {
    let signal;
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const r = await chat(URL_BASE, body, { fetch, timeoutMs: 30 });
    expect(r).toMatchObject({ ok: false, status: "timeout" });
    expect(signal.aborted).toBe(true);
  });

  it("reports an abort asked by the caller (not a timeout)", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const pending = chat(URL_BASE, body, { fetch, signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, status: "aborted" });
  });

  it("does not even call fetch when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => okResponse());
    const r = await chat(URL_BASE, body, { fetch, signal: controller.signal, timeoutMs: 1000 });
    expect(r.status).toBe("aborted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an HTTP error", async () => {
    const fetch = vi.fn(async () => response({ ok: false, status: 500, json: async () => ({ error: "boom" }) }));
    expect(await chat(URL_BASE, body, { fetch, timeoutMs: 1000 })).toMatchObject({ ok: false, status: "http" });
  });

  it("reports an answer that is not JSON", async () => {
    const fetch = vi.fn(async () => response({ json: async () => { throw new SyntaxError("bad"); }, text: async () => "<html>" }));
    expect(await chat(URL_BASE, body, { fetch, timeoutMs: 1000 })).toMatchObject({ ok: false, status: "invalid" });
  });
});
