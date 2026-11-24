import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { AiSdkModelSession, type ModelAttemptEvent } from "../src/harness/ai-sdk-model-session.js";
import { createConfiguredLanguageModel } from "../src/harness/model-route.js";
import { chatSse, responsesSse } from "./support/model-stream-fixtures.js";

const servers: Server[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
afterEach(async () => {
  timers.splice(0).forEach(clearTimeout);
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
const input = { messages: [{ role: "user" as const, content: "Call inspect" }], tools: [{ name: "inspect", description: "Inspect", inputSchema: {
  type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false,
} }] };
const successful = chatSse({ id: "ok", model: "fixture", choices: [{ index: 0, message: { role: "assistant", tool_calls: [
  { id: "accepted", type: "function", function: { name: "inspect", arguments: '{"target":"stone"}' } },
] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
function chunk(delta: unknown, finish_reason: string | null = null) {
  return `data: ${JSON.stringify({ id: "stream", model: "fixture", created: 0, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}
function later(callback: () => void, ms: number) { timers.push(setTimeout(callback, ms)); }
function start(response: ServerResponse) { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); }
async function fixture(handle: (response: ServerResponse, attempt: number) => void,
  limits: { requestTimeoutMs?: number; firstOutputTimeoutMs?: number; outputIdleTimeoutMs?: number } = {}, protocol: "chat-completions" | "responses" = "chat-completions") {
  const requests: unknown[] = [];
  const closed: number[] = [];
  const events: ModelAttemptEvent[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    requests.push(JSON.parse(body)); const attempt = requests.length;
    response.once("close", () => closed.push(attempt));
    handle(response, attempt);
  });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const modelLimits = { contextWindowTokens: 10000, maxOutputTokens: 1000, requestTimeoutMs: 10000, firstOutputTimeoutMs: 500, outputIdleTimeoutMs: 100, ...limits };
  const model = createConfiguredLanguageModel({ provider: "openai-compatible", name: "fixture", model: "fixture",
    protocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, limits: modelLimits }, { modelApiKey: "fixture" });
  const session = new AiSdkModelSession(model, modelLimits);
  return { session, requests, closed, events, complete: (signal?: AbortSignal) => session.complete(input, { signal, onAttempt: e => { events.push(e); } }) };
}
const success = (response: ServerResponse) => { start(response); response.end(successful); };

describe("streaming Model Session owns retries, progress timeouts and cancellation", () => {
  it("times out before headers, closes the old request, and retries the same input", async () => {
    const test = await fixture((response, attempt) => { if (attempt === 2) success(response); }, { firstOutputTimeoutMs: 50 });
    await expect(test.complete()).resolves.toMatchObject({ finishReason: "tool-calls" });
    expect(test.requests).toHaveLength(2);
    expect(test.requests[0]).toEqual(test.requests[1]);
    expect(test.requests[0]).toMatchObject({ stream: true });
    expect(test.closed).toContain(1);
    expect(test.events.filter(e => e.outcome === "error")[0]).toMatchObject({ category: "timeout", errorDetails: { code: "MODEL_FIRST_OUTPUT_TIMEOUT" } });
  });

  it("does not let headers, heartbeat bytes or role-only chunks extend first-output time", async () => {
    const test = await fixture(response => {
      start(response);
      for (let i = 0; i < 8; i++) later(() => { if (!response.destroyed) response.write(': heartbeat\n\n' + chunk({ role: "assistant" })); }, i * 10);
    }, { firstOutputTimeoutMs: 50, requestTimeoutMs: 150 });
    await expect(test.complete()).rejects.toMatchObject({ category: "timeout", attempts: 1 });
    expect(test.events.find(e => e.outcome === "error")?.errorDetails?.code).toBe("MODEL_FIRST_OUTPUT_TIMEOUT");
    expect(test.requests).toHaveLength(1);
  });

  it("accepts slow continuous reasoning and fragmented tool input, retaining usage", async () => {
    const test = await fixture(response => {
      start(response);
      response.write(chunk({ reasoning_content: "thinking" }));
      later(() => response.write(chunk({ reasoning_content: " slowly" })), 40);
      later(() => response.write(chunk({ tool_calls: [{ index: 0, id: "complete", type: "function", function: { name: "inspect", arguments: '{"target":' } }] })), 80);
      later(() => response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"stone"}' } }] })), 120);
      later(() => response.end(chunk({}, "tool_calls") + `data: ${JSON.stringify({ id: "stream", model: "fixture", choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`), 160);
    });
    const decision = await test.complete();
    expect(decision.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", text: "thinking slowly" }),
      expect.objectContaining({ type: "tool-call", toolCallId: "complete", input: { target: "stone" } }),
    ]));
    expect(decision.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    expect(test.requests).toHaveLength(1);
    expect(test.events.find(e => e.outcome === "ok")?.firstOutputMs).toEqual(expect.any(Number));
  });

  it.each(["stall", "eof", "disconnect"] as const)("discards partial tools after %s and retries the whole response", async failure => {
    const test = await fixture((response, attempt) => {
      if (attempt > 1) { success(response); return; }
      start(response);
      response.write(chunk({ reasoning_content: "discard me", tool_calls: [{ index: 0, id: "discarded", type: "function", function: { name: "inspect", arguments: '{"target":' } }] }));
      if (failure === "eof") response.end();
      if (failure === "disconnect") later(() => response.destroy(), 20);
    }, { outputIdleTimeoutMs: 50 });
    const decision = await test.complete();
    expect(JSON.stringify(decision.message)).not.toContain("discard");
    expect(decision.message.content).toEqual([expect.objectContaining({ type: "tool-call", toolCallId: "accepted", input: { target: "stone" } })]);
    expect(test.requests).toHaveLength(2);
    expect(test.events.filter(e => e.type === "model_attempt_finished").map(e => e.outcome)).toEqual(["error", "ok"]);
  });

  it("does not accept a Responses stream missing response.completed", async () => {
    const body = responsesSse({ id: "response", created_at: 0, model: "fixture", status: "completed", output: [
      { type: "function_call", id: "fc_accepted", call_id: "accepted", name: "inspect", arguments: '{"target":"stone"}', status: "completed" },
    ], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } });
    const test = await fixture((response, attempt) => {
      start(response);
      response.end(attempt === 1 ? body.split("\n\n").filter(line => !line.includes('"type":"response.completed"')).join("\n\n") : body);
    }, {}, "responses");
    await expect(test.complete()).resolves.toMatchObject({ finishReason: "tool-calls" });
    expect(test.requests).toHaveLength(2);
    expect(test.events.find(e => e.outcome === "error")?.category).toBe("connection");
  });

  const providerFailure = { type: "server_error", code: "server_error", message: "upstream overloaded" };
  const failureEvidence = { code: "MODEL_STREAM_INTERRUPTED", cause: { name: "ModelStreamFailure", code: "server_error", message: "upstream overloaded" } };

  it.each([
    ["error", { type: "error", sequence_number: 2, error: providerFailure }],
    ["response.failed", { type: "response.failed", sequence_number: 2, response: { id: "response", created_at: 0, model: "fixture", status: "failed", output: [], usage: null, error: providerFailure } }],
  ])("retries a Responses %s frame after first output and keeps the Provider evidence", async (_name, frame) => {
    const body = responsesSse({ id: "response", created_at: 0, model: "fixture", status: "completed", output: [
      { type: "function_call", id: "fc_accepted", call_id: "accepted", name: "inspect", arguments: '{"target":"stone"}', status: "completed" },
    ], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } });
    const test = await fixture((response, attempt) => {
      start(response);
      response.end(attempt === 1 ? `${body.split("\n\n").slice(0, 2).join("\n\n")}\n\ndata: ${JSON.stringify(frame)}\n\n` : body);
    }, {}, "responses");
    await expect(test.complete()).resolves.toMatchObject({ finishReason: "tool-calls" });
    expect(test.requests).toHaveLength(2);
    expect(test.events.find(e => e.outcome === "error")).toMatchObject({ category: "connection", errorDetails: failureEvidence });
  });

  it("retries a Chat Completions failure frame after first output and discards partial reasoning", async () => {
    const test = await fixture((response, attempt) => {
      if (attempt > 1) { success(response); return; }
      start(response);
      response.end(`${chunk({ reasoning_content: "discard me" })}data: ${JSON.stringify({ error: providerFailure })}\n\n`);
    });
    const decision = await test.complete();
    expect(JSON.stringify(decision.message)).not.toContain("discard");
    expect(test.requests).toHaveLength(2);
    expect(test.events.find(e => e.outcome === "error")).toMatchObject({ category: "connection", errorDetails: failureEvidence });
  });

  it("caps 408 retries at three HTTP requests without SDK retries", async () => {
    const test = await fixture(response => {
      response.writeHead(408, { "content-type": "application/json", "retry-after-ms": "1" });
      response.end(JSON.stringify({ error: { message: "timeout" } }));
    }, { retries: 2 });
    await expect(test.complete()).rejects.toMatchObject({ category: "transient_http", statusCode: 408, attempts: 3 });
    expect(test.requests).toHaveLength(3);
  });

  it("exhausts three silent attempts without waiting for the longer overall deadline", async () => {
    const test = await fixture(() => {}, { firstOutputTimeoutMs: 50, requestTimeoutMs: 10000, retries: 2, retryMaxDelayMs: 1 });
    await expect(test.complete()).rejects.toMatchObject({ category: "timeout", code: "MODEL_FIRST_OUTPUT_TIMEOUT", attempts: 3 });
    expect(test.requests).toHaveLength(3);
    expect(test.events.filter(e => e.outcome === "error")).toHaveLength(3);
  });

  it.each(["headers", "body", "backoff"] as const)("cancels during %s without retrying", async phase => {
    const test = await fixture(response => {
      if (phase === "body") { start(response); response.write(chunk({ reasoning_content: "thinking" })); }
      if (phase === "backoff") { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":{"message":"retry"}}'); }
    });
    const controller = new AbortController();
    const pending = test.complete(controller.signal);
    later(() => controller.abort(), 60);
    await expect(pending).rejects.toMatchObject({ category: "cancelled", attempts: 1 });
    expect(test.requests).toHaveLength(1);
  });

  it("keeps the overall deadline even while semantic chunks continue", async () => {
    const test = await fixture(response => {
      start(response);
      for (let i = 0; i < 20; i++) later(() => { if (!response.destroyed) response.write(chunk({ reasoning_content: "." })); }, i * 20);
    }, { requestTimeoutMs: 150 });
    await expect(test.complete()).rejects.toMatchObject({ category: "timeout", attempts: 1 });
    expect(test.requests).toHaveLength(1);
  });
});
