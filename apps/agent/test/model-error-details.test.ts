import { chatSse, sseResponse } from "./support/model-stream-fixtures.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSdkModelSession, type ModelAttemptEvent } from "../src/harness/ai-sdk-model-session.js";
import { modelErrorDetails } from "../src/harness/model-error-details.js";
import { HarnessRunEventLog } from "../src/harness/harness-run-event-log.js";
import { decisionCycle } from "./support/decision-cycle.js";
import { ModelContextManager } from "../src/harness/model-context-manager.js";
import { ModelSurface } from "../src/harness/model-surface.js";
import { textMessage, toolResultMessage } from "../src/harness/model-surface-message.js";
import { ScriptedLanguageModel } from "../src/harness/testing/scripted-language-model.js";
import { createOpenAiCompatibleTestTransport } from "./support/openai-compatible-test-transport.js";

function upstreamError() {
  return new APICallError({ message: "Upstream rejected request", url: "http://provider.test/v1/chat/completions",
    requestBodyValues: { secret: "REQUEST_MUST_NOT_BE_LOGGED" }, responseHeaders: { authorization: "HEADERS_MUST_NOT_BE_LOGGED" },
    statusCode: 404, responseBody: JSON.stringify({ error: { code: "model_not_found", message: "Requested model has no active deployment" } }),
    isRetryable: false,
  });
}
const tools = [{ name: "wait", description: "Wait", inputSchema: { type: "object", properties: {} } }];
const limits = { contextWindowTokens: 262144, maxOutputTokens: 65536 };

describe("persisted model error details", () => {
  const directories: string[] = [];
  const logs: HarnessRunEventLog[] = [];
  afterEach(async () => {
    await Promise.allSettled(logs.splice(0).map(log => log.close()));
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "model-errors-"));
    directories.push(directory);
    const eventLog = await HarnessRunEventLog.create(directory, "run");
    logs.push(eventLog);
    const context = textMessage("user", "context");
    const surface = new ModelSurface(textMessage("system", "contract"), { message: context, historyMessage: context });
    const events = async () => {
      await eventLog.drain();
      return (await readFile(eventLog.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    };
    return { eventLog, surface, events };
  }

  it("persists upstream code, message and response body in both attempt and terminal events", async () => {
    const f = await fixture();
    const languageModel = new ScriptedLanguageModel({ responses: [upstreamError()] });
    const cycle = decisionCycle({ mode: "native", model: new AiSdkModelSession(languageModel, limits), ...f });
    await expect(cycle.run({ tools, continuitySignal: new AbortController().signal, executeOuterCall: vi.fn() }))
      .resolves.toMatchObject({ status: "terminal", endReason: "model_transport_error" });
    const events = await f.events();
    const expected = { code: "model_not_found", statusCode: 404, providerMessage: "Requested model has no active deployment",
      responseBody: expect.stringContaining('"model_not_found"') };
    expect(events.find(event => event.type === "model_attempt_finished").errorDetails).toMatchObject(expected);
    expect(events.find(event => event.type === "model_call_finished").errorDetails.cause).toMatchObject(expected);
    expect(JSON.stringify(events)).not.toContain("REQUEST_MUST_NOT_BE_LOGGED");
    expect(JSON.stringify(events)).not.toContain("HEADERS_MUST_NOT_BE_LOGGED");
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"])("retains nested socket cause %s", async code => {
    const socket = Object.assign(new Error("socket failed"), { code });
    const error = new APICallError({ message: "fetch failed", url: "http://provider.test", requestBodyValues: {},
      cause: new TypeError("fetch failed", { cause: new AggregateError([socket], "connection attempts failed") }), isRetryable: false });
    const f = await fixture();
    const languageModel = new ScriptedLanguageModel({ responses: [error] });
    const cycle = decisionCycle({ mode: "native", model: new AiSdkModelSession(languageModel, limits), ...f });
    await cycle.run({ tools, continuitySignal: new AbortController().signal, executeOuterCall: vi.fn() });
    const event = (await f.events()).find(event => event.type === "model_call_finished");
    expect(event.category).toBe("connection");
    expect(event.errorDetails.cause.cause.cause.errors[0]).toMatchObject({ code, message: "socket failed" });
  });

  it("retains each retry's upstream error and the final provider cause", async () => {
    vi.useFakeTimers();
    const transport = createOpenAiCompatibleTestTransport([1, 2, 3].map(index => ({
      error: { statusCode: 503, code: "overloaded", message: `backend overloaded attempt ${index}` },
    })), { name: "test", baseUrl: "http://provider.test/v1" });
    const attempts: ModelAttemptEvent[] = [];
    const pending = new AiSdkModelSession(transport.model, { ...limits, retries: 2 }).complete({ messages: [textMessage("user", "test")] }, {
      onAttempt: event => { attempts.push(event); },
    }).then(() => { throw new Error("expected provider failure"); }, error => error);
    await vi.advanceTimersByTimeAsync(10000);
    const error = await pending;
    expect(error.attempts).toBe(3);
    expect(attempts.filter(event => event.outcome === "error").map(event => event.errorDetails?.providerMessage))
      .toEqual([1, 2, 3].map(index => `backend overloaded attempt ${index}`));
    expect(JSON.stringify(modelErrorDetails(error))).toContain("backend overloaded attempt 3");
  });

  it.each(["unknown", "malformed"])("asks again after a %s Tool Call and ends the run only when the model never recovers", async kind => {
    const f = await fixture();
    const bodies: string[] = [];
    const provider = createOpenAICompatible({ name: "test", baseURL: "http://provider.test/v1",
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return sseResponse(chatSse({ id: "test", model: "test", created: 0, choices: [{ index: 0,
          message: { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function",
            function: { name: kind === "unknown" ? "unregistered_tool" : "wait", arguments: kind === "malformed" ? '{"seconds":' : "{}" } }] },
          finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      },
    });
    const execute = vi.fn();
    const cycle = decisionCycle({ mode: "native", model: new AiSdkModelSession(provider.chatModel("test"), limits), ...f });
    await expect(cycle.run({ tools, continuitySignal: new AbortController().signal, executeOuterCall: execute }))
      .resolves.toMatchObject({ status: "terminal", endReason: "model_protocol_error" });
    expect(execute).not.toHaveBeenCalled();
    expect(f.surface.completedCycles).toHaveLength(0);
    const issues = (await f.events()).filter(event => event.type === "model_protocol_error");
    expect(issues).toHaveLength(17);
    expect(issues[0]).toMatchObject({ code: kind === "unknown" ? "invalid_tool_call_name" : "invalid_tool_call_arguments", willRetry: true });
    expect(issues.at(-1)).toMatchObject({ protocolRetries: 16, willRetry: false });
    expect(bodies[0]).not.toContain("could not be used");
    expect(bodies[1]).toContain("Your previous tool call could not be used");
  });

  it("persists upstream details when a compaction request fails", async () => {
    const f = await fixture();
    for (let index = 0; index < 2; index++) {
      f.surface.commit({ role: "assistant", content: [{ type: "tool-call", toolCallId: String(index), toolName: "wait", input: {} }] },
        toolResultMessage(String(index), "wait", index === 0 ? "x".repeat(700000) : "done"));
    }
    const languageModel = new ScriptedLanguageModel({ responses: [upstreamError()] });
    const manager = new ModelContextManager({ model: new AiSdkModelSession(languageModel, limits), ...f });
    await expect(manager.prepare({ tools })).resolves.toMatchObject({ removedCycles: 1 });
    const event = (await f.events()).find(event => event.type === "history_compaction_call_finished");
    expect(event.errorDetails.cause).toMatchObject({ code: "model_not_found", providerMessage: "Requested model has no active deployment" });
    expect(f.surface.completedCycles).toHaveLength(1);
  });

  it("preserves plain-text upstream bodies, bounds large errors, and excludes credentials", () => {
    const error = new APICallError({ message: "Proxy returned Bearer credential-value and sk-secret-value", url: "http://provider.test",
      requestBodyValues: {}, statusCode: 502, responseBody: "Bad gateway\n" + "x".repeat(20000), isRetryable: false });
    const details = modelErrorDetails(error);
    expect(details.responseBody).toHaveLength(16384);
    expect(details.responseBody).toMatch(/^Bad gateway/);
    expect(details.truncated).toBe(true);
    expect(details.message).toBe("Proxy returned Bearer [REDACTED] and [REDACTED]");
  });

  it("serializes cyclic causes without crashing the error logger", () => {
    const error = new Error("cycle");
    error.cause = error;
    expect(modelErrorDetails(error)).toMatchObject({ message: "cycle", cause: { truncated: true } });
  });
});
