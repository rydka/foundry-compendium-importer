/**
 * Minimal Ollama client, pure: `fetch` is injected (the tests give a fake one), nothing runs at import.
 * Statuses: ok | unreachable | timeout | aborted | http | invalid.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const KEEP_ALIVE = "10m";

const baseUrl = url => String(url ?? "").replace(/\/+$/, "");

/**
 * Run `task(signal)` with a timeout and an optional external signal.
 * @param {number} timeoutMs
 * @param {AbortSignal} [external]
 * @param {(signal: AbortSignal) => Promise<*>} task
 * @returns {Promise<{value?: *, reason?: "timeout"|"aborted"|"error", error?: string}>}
 */
export async function guarded(timeoutMs, external, task) {
  if ( external?.aborted ) return { reason: "aborted" };
  const controller = new globalThis.AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  external?.addEventListener?.("abort", onAbort, { once: true });
  const timer = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return { value: await task(controller.signal) };
  } catch(err) {
    if ( timedOut ) return { reason: "timeout" };
    if ( external?.aborted || (err?.name === "AbortError") ) return { reason: "aborted" };
    return { reason: "error", error: String(err?.message ?? err) };
  } finally {
    globalThis.clearTimeout(timer);
    external?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * POST a JSON body and read a JSON answer.
 * @returns {Promise<{ok: boolean, status: string, json?: object, error?: string, httpStatus?: number}>}
 */
async function post(url, path, body, { fetch: request, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const run = await guarded(timeoutMs, signal, async s => {
    const response = await request(`${baseUrl(url)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream: false, keep_alive: KEEP_ALIVE, ...body }),
      signal: s
    });
    if ( !response?.ok ) return { ok: false, status: "http", httpStatus: response?.status };
    try {
      return { ok: true, status: "ok", json: await response.json() };
    } catch(err) {
      return { ok: false, status: "invalid", error: String(err?.message ?? err) };
    }
  });
  if ( run.value ) return run.value;
  if ( run.reason === "error" ) return { ok: false, status: "unreachable", error: run.error };
  return { ok: false, status: run.reason };
}

/**
 * `/api/chat`: the answer's message content, parsed as JSON.
 * @param {string} url  Base URL of Ollama (`http://localhost:11434`).
 * @param {object} body  Chat body (model, messages, format, options…).
 * @param {{fetch: Function, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, status: "ok"|"unreachable"|"timeout"|"aborted"|"http"|"invalid", json?: *,
 *   content?: string, error?: string, httpStatus?: number}>}
 */
export async function chat(url, body, options = {}) {
  const r = await post(url, "/api/chat", body, options);
  if ( !r.ok ) return r;
  const content = r.json?.message?.content;
  if ( typeof content !== "string" ) return { ok: false, status: "invalid", error: "no message content" };
  try {
    return { ok: true, status: "ok", content, json: JSON.parse(content) };
  } catch(err) {
    return { ok: false, status: "invalid", content, error: String(err.message) };
  }
}

/**
 * `/api/generate` without a prompt: loads the model into memory (warm-up before the first block).
 * @param {string} url
 * @param {string} model
 * @param {{fetch: Function, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, status: string}>}
 */
export function warmUp(url, model, options = {}) {
  return post(url, "/api/generate", { model }, options);
}

/**
 * `/api/tags`: true when the server answers.
 * @param {string} url
 * @param {{fetch: Function, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<boolean>}
 */
export async function ping(url, { fetch: request, signal, timeoutMs = 5000 } = {}) {
  const run = await guarded(timeoutMs, signal, async s => (await request(`${baseUrl(url)}/api/tags`, { signal: s }))?.ok === true);
  return run.value === true;
}
