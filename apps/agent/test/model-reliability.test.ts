import { chatSse, responsesSse } from "./support/model-stream-fixtures.js";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSdkModelSession, retryDelayMs, type ModelAttemptEvent } from "../src/harness/ai-sdk-model-session.js";
import { ModelContextOverflowError } from "../src/harness/model-surface-message.js";
import type { ModelLimits } from "../src/harness/config.js";
import { createConfiguredLanguageModel } from "../src/harness/model-route.js";

const archived = JSON.parse(await readFile(new URL("./fixtures/context-window-rejection.json", import.meta.url), "utf8"));
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

async function httpProvider(kind: "openai" | "openai-compatible", responses: Array<{ status?: number; message?: string; code?: string; retryMs?: number; disconnect?: boolean; hang?: boolean }>, timeout = 2000, retryLimits: Pick<ModelLimits, "retries" | "retryMaxDelayMs"> = {}) {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    const fixture = responses[Math.min(requests++, responses.length - 1)]!;
    if (fixture.disconnect) { request.socket.destroy(); return; }
    if (fixture.hang) return;
    response.setHeader("content-type", "application/json");
    if (fixture.retryMs !== undefined) response.setHeader("retry-after-ms", fixture.retryMs);
    response.statusCode = fixture.status ?? 200;
    if (response.statusCode !== 200) {
      response.end(JSON.stringify({ error: { message: fixture.message ?? "temporary failure", ...(fixture.code === undefined ? {} : { code: fixture.code }) } }));
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    response.end(kind === "openai"
      ? responsesSse({ id: "resp_recovered", created_at: 1700000000, status: "completed", model: "local",
        output: [{ type: "message", id: "msg_recovered", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "recovered", annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } })
      : chatSse({ id: "response", model: "local", choices: [{ index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
  });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing server address");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  const model = kind === "openai"
    ? createConfiguredLanguageModel({ provider: "openai", model: "local", limits: { contextWindowTokens: 128000, maxOutputTokens: 4096 } }, { modelApiKey: "test-key" })
    : createOpenAICompatible({ name: "fault-injection", baseURL }).chatModel("local");
  return { session: new AiSdkModelSession(model, { contextWindowTokens: 128000, maxOutputTokens: 4096, requestTimeoutMs: timeout, ...retryLimits }), requests: () => requests };
}
const input = { messages: [{ role: "user" as const, content: "test" }] };

describe.each(["openai", "openai-compatible"] as const)("%s SDK reliability against local HTTP faults", kind => {
  const provider = (responses: Parameters<typeof httpProvider>[1], timeout?: number, retryLimits?: Parameters<typeof httpProvider>[3]) => httpProvider(kind, responses, timeout, retryLimits);
  it("recognizes the archived context rejection without a structured code", async () => {
    const test = await provider([{ status: archived.httpStatus, message: archived.message }]);
    await expect(test.session.complete(input)).rejects.toBeInstanceOf(ModelContextOverflowError);
    expect(test.requests()).toBe(1);
  });

  it("preserves a provider failure when writing its attempt audit also fails", async () => {
    const test = await provider([{ status: 503, retryMs: 1 }]);
    const auditError = new Error("audit disk failure");
    await expect(test.session.complete(input, { onAttempt: event => {
      if (event.type === "model_attempt_finished") throw auditError;
    } })).rejects.toMatchObject({ cause: { statusCode: 503 }, errors: [expect.objectContaining({ statusCode: 503 }), auditError] });
    expect(test.requests()).toBe(1);
  });

  it.each([
    [400, "Invalid tool schema", undefined],
    [400, "max_tokens must be positive", "max_tokens_exceeded"],
    [400, "Invalid reasoning signature", "thinking_signature_invalid"],
    [401, archived.message, undefined],
    [403, "Forbidden", undefined],
  ])("does not confuse HTTP %s %s with context exhaustion", async (status, message, code) => {
    const test = await provider([{ status, message, ...(code === undefined ? {} : { code }) }]);
    await expect(test.session.complete(input)).rejects.not.toBeInstanceOf(ModelContextOverflowError);
    expect(test.requests()).toBe(1);
  });

  it("records all three actual attempts through 503, 502 and recovery", async () => {
    const test = await provider([{ status: 503, retryMs: 1 }, { status: 502, retryMs: 1 }, {}]);
    const events: ModelAttemptEvent[] = [];
    await expect(test.session.complete(input, { onAttempt: event => { events.push(event); } })).resolves.toMatchObject({ message: { role: "assistant" } });
    expect(test.requests()).toBe(3);
    expect(events.filter(event => event.type === "model_attempt_finished").map(event => [event.attempt, event.outcome, event.statusCode])).toEqual([[1, "error", 503], [2, "error", 502], [3, "ok", undefined]]);
  });

  it("keeps retrying through a long outage when retries is raised", async () => {
    const test = await provider([...Array.from({ length: 8 }, () => ({ status: 503, retryMs: 1 })), {}], undefined, { retries: 8 });
    const events: ModelAttemptEvent[] = [];
    await expect(test.session.complete(input, { onAttempt: event => { events.push(event); } })).resolves.toMatchObject({ message: { role: "assistant" } });
    expect(test.requests()).toBe(9);
    expect(events.filter(event => event.type === "model_attempt_finished").at(-1)).toMatchObject({ attempt: 9, outcome: "ok" });
  });

  it("gives up after the configured retries and reports the attempt count", async () => {
    const test = await provider([{ status: 503, retryMs: 1 }], undefined, { retries: 4 });
    await expect(test.session.complete(input)).rejects.toMatchObject({ category: "transient_http", attempts: 5 });
    expect(test.requests()).toBe(5);
  });

  it("makes a single attempt when retries is 0", async () => {
    const test = await provider([{ status: 503, retryMs: 1 }], undefined, { retries: 0 });
    await expect(test.session.complete(input)).rejects.toMatchObject({ attempts: 1 });
    expect(test.requests()).toBe(1);
  });

  it("recognizes a context rejection after a transient SDK retry wrapper", async () => {
    const test = await provider([{ status: 503, retryMs: 1 }, { status: 400, message: archived.message }]);
    await expect(test.session.complete(input)).rejects.toBeInstanceOf(ModelContextOverflowError);
    expect(test.requests()).toBe(2);
  });

  it("includes backoff in the total deadline", async () => {
    const test = await provider([{ status: 503, retryMs: 1000 }], 70);
    const started = performance.now();
    await expect(test.session.complete(input)).rejects.toMatchObject({ category: "timeout" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(test.requests()).toBe(1);
  });

  it.each(["backoff", "request"])("cancels a pending %s without another attempt", async mode => {
    const test = await provider([mode === "backoff" ? { status: 503, retryMs: 1000 } : { hang: true }]);
    const controller = new AbortController();
    const running = test.session.complete(input, { signal: controller.signal });
    const rejected = expect(running).rejects.toMatchObject({ category: "cancelled" });
    await new Promise(resolve => setTimeout(resolve, 40)); controller.abort();
    await rejected;
    expect(test.requests()).toBe(1);
  });

  it("terminates a disconnected request within its deadline", async () => {
    const test = await provider([{ disconnect: true }], 70);
    await expect(test.session.complete(input)).rejects.toMatchObject({ category: "timeout" });
    expect(test.requests()).toBe(1);
  });
});

describe("retryDelayMs", () => {
  it("caps only the exponential backoff", () => {
    expect([1, 2, 3, 4, 5, 6].map(attempt => retryDelayMs(new Error("x"), attempt, 30_000))).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
