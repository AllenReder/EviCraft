import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import { HarnessRunEventLog } from "../src/harness/harness-run-event-log.js";
import { ModelContextManager } from "../src/harness/model-context-manager.js";
import { decisionCycle } from "./support/decision-cycle.js";
import { ModelSurface } from "../src/harness/model-surface.js";
import { messageText, messageToolCalls, textMessage, toolResultMessage } from "../src/harness/model-surface-message.js";
import { ScriptedLanguageModel, type ScriptedLanguageModelOptions } from "../src/harness/testing/scripted-language-model.js";

const limits = { contextWindowTokens: 262144, maxOutputTokens: 65536 };
const tools = [{ name: "wait", description: "Wait", inputSchema: { type: "object", properties: {} } }];
const checkpoint = { role: "assistant" as const, content: "CHECKPOINT: wood location and unfinished work" };
const toolDecision = (id: string, input = {}) => ({ role: "assistant" as const,
  content: [{ type: "tool-call" as const, toolCallId: id, toolName: "wait", input }] });
const context = (value: string) => ({ message: textMessage("user", "AUTO_OBSERVATION " + value),
  historyMessage: textMessage("user", "history " + value) });

/** The flat error body SGLang and vLLM return; the AI SDK parses no structured data from it. */
function overflow() {
  return new APICallError({ message: "Bad Request", url: "http://provider.test", requestBodyValues: {}, statusCode: 400,
    responseBody: JSON.stringify({ object: "error", type: "BadRequestError", param: null, code: 400,
      message: "The input (293760 tokens) is longer than the model's context length (262144 tokens)." }),
    isRetryable: false });
}

describe("Model Context Manager", () => {
  const directories: string[] = [];
  const logs: HarnessRunEventLog[] = [];
  afterEach(async () => {
    await Promise.allSettled(logs.splice(0).map(log => log.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

  async function fixture(options: ScriptedLanguageModelOptions = { responses: [{ message: checkpoint }] }, modelLimits = limits) {
    const directory = await mkdtemp(join(tmpdir(), "context-manager-"));
    directories.push(directory);
    const eventLog = await HarnessRunEventLog.create(directory, "run");
    logs.push(eventLog);
    const surface = new ModelSurface(textMessage("system", "CONTRACT"), context("CURRENT"));
    const model = new ScriptedLanguageModel(options);
    const session = new AiSdkModelSession(model, modelLimits, "required");
    const manager = new ModelContextManager({ model: session, surface, eventLog });
    const events = async () => {
      await eventLog.drain();
      return (await readFile(eventLog.path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    };
    /** Commits `count` cycles whose results are `chars` long and start with `R<n>`. */
    const history = (count: number, chars: number) => {
      for (let index = 1; index <= count; index++) {
        surface.commit({ role: "assistant", content: [
          { type: "reasoning", text: "PRIVATE_REASONING", providerOptions: { opaque: { id: "OPAQUE" } } },
          ...toolDecision(`call-${index}`).content,
        ] }, toolResultMessage(`call-${index}`, "wait", `R${index} ` + "x".repeat(chars)));
      }
    };
    const cycle = () => decisionCycle({ mode: "native", model: session, surface, eventLog });
    const run = { tools, continuitySignal: new AbortController().signal, executeOuterCall: async () => ({ ok: true }) };
    return { surface, model, manager, session, eventLog, events, history, cycle, run };
  }

  it("leaves history alone below the trigger", async () => {
    const f = await fixture();
    f.history(3, 1000);
    await expect(f.manager.prepare({ tools })).resolves.toMatchObject({ removedCycles: 0 });
    expect(f.model.requests).toHaveLength(0);
    expect(f.surface.completedCycles).toHaveLength(3);
  });

  it("keeps the most recent cycles verbatim and folds the older ones into the summary", async () => {
    const f = await fixture();
    // Ten cycles of about 20k estimated tokens pass the 157k trigger; the 49k allowance holds two.
    f.history(10, 60000);
    await expect(f.manager.prepare({ tools })).resolves.toMatchObject({ removedCycles: 8 });
    expect(f.surface.completedCycles).toHaveLength(2);
    expect(messageText(f.surface.historySummary!)).toBe(checkpoint.content);
    const request = JSON.stringify(f.surface.requestMessages());
    expect(request).toContain("R9 ");
    expect(request).toContain("R10 ");
    expect(request).not.toContain("R8 ");
    expect(f.model.requests).toHaveLength(1);
    expect(f.model.requests[0]?.maxOutputTokens).toBe(16384);
    const summaryInput = JSON.stringify(f.model.requests[0]);
    expect(summaryInput).toContain("R1 ");
    expect(summaryInput).toContain("R8 ");
    expect(summaryInput).not.toContain("R9 ");
    expect(summaryInput).not.toContain("PRIVATE_REASONING");
    expect(summaryInput).not.toContain("OPAQUE");
    expect(summaryInput).not.toContain("AUTO_OBSERVATION");
    // A summary reads the head and tail of each result, not all of it.
    expect(summaryInput.length).toBeLessThan(100000);
    expect((await f.events()).find(event => event.type === "history_compacted")).toMatchObject({
      strategy: "summary", trigger: "input_budget", summarizedCompleteToolCycles: 8, retainedCompleteToolCycles: 2,
    });
  });

  it("returns the prepared request including the current observation and temporary correction", async () => {
    const f = await fixture();
    f.history(10, 60000);
    const prepared = await f.manager.prepare({ tools, correction: "Call an available tool." });
    const messages = prepared.request.messages.map(message => messageText(message));
    expect(messages.at(-2)).toContain("AUTO_OBSERVATION CURRENT");
    expect(messages.at(-1)).toBe("Call an available tool.");
    expect(prepared.request.tools).toEqual(tools);
  });

  it("folds a long history into the summary over several requests", async () => {
    const f = await fixture({ respond: (_request, index) => ({ message: { role: "assistant", content: `SUMMARY_${index}` } }) },
      { contextWindowTokens: 20000, maxOutputTokens: 4000 });
    f.history(20, 5000);
    await f.manager.prepare({ tools });
    expect(f.model.requests.length).toBeGreaterThan(2);
    expect(JSON.stringify(f.model.requests[1])).toContain("SUMMARY_0");
    expect(messageText(f.surface.historySummary!)).toBe(`SUMMARY_${f.model.requests.length - 1}`);
    const summarized = (await f.events()).filter(event => event.type === "history_compaction_started")
      .reduce((total, event) => total + event.summarizedCompleteToolCycles, 0);
    expect(summarized).toBe(20 - f.surface.completedCycles.length);
  });

  it("marks the history as omitted when the summary cannot be produced", async () => {
    const f = await fixture({ responses: [new Error("summary unavailable")] });
    f.history(10, 60000);
    await f.manager.prepare({ tools });
    expect(f.surface.completedCycles).toHaveLength(2);
    expect(messageText(f.surface.historySummary!)).toContain("summarization was unavailable");
    expect((await f.events()).find(event => event.type === "history_compaction_failed")).toMatchObject({ reason: "summary_failure" });
  });

  it("keeps a cancelled summary from changing history", async () => {
    const controller = new AbortController();
    const f = await fixture({ respond: () => { controller.abort(new Error("operator stopped")); return { message: checkpoint }; } });
    f.history(10, 60000);
    const before = f.surface.requestMessages();
    await expect(f.manager.prepare({ tools }, controller.signal)).rejects.toThrow("operator stopped");
    expect(f.surface.requestMessages()).toEqual(before);
  });

  it("starts from the measured request and counts new text at two bytes a token", async () => {
    const f = await fixture();
    const first = await f.manager.prepare({ tools });
    expect(first.estimate.source).toBe("local_estimate");
    f.manager.observe(first.request, 1000);
    f.history(1, 20000);
    const second = await f.manager.prepare({ tools });
    expect(second.estimate.source).toBe("usage_calibrated");
    expect(second.estimate.inputTokens).toBeGreaterThan(1000 + 10000);
    expect(second.estimate.inputTokens).toBeLessThan(1000 + 10500);
  });

  it("recovers from a provider overflow by halving the verbatim history, then keeping only the summary", async () => {
    let decisions = 0;
    const f = await fixture({ respond: request => request.tools === undefined
      ? { message: checkpoint }
      : ++decisions <= 2 ? overflow() : { message: toolDecision("next") } });
    f.history(4, 30000);
    await expect(f.cycle().run(f.run)).resolves.toMatchObject({ status: "committed" });
    const compacted = (await f.events()).filter(event => event.type === "history_compacted");
    expect(compacted.map(event => [event.trigger, event.retainedCompleteToolCycles])).toEqual([
      ["provider_overflow", 1], ["provider_overflow", 0],
    ]);
    expect(decisions).toBe(3);
    expect(messageText(f.surface.historySummary!)).toBe(checkpoint.content);
    expect(f.surface.completedCycles.map(cycle => messageToolCalls(cycle.assistant)[0]?.id)).toEqual(["next"]);
  });

  it("ends the run when the summary-only request still does not fit", async () => {
    const f = await fixture({ respond: () => overflow() });
    await expect(f.cycle().run({ ...f.run, executeOuterCall: vi.fn() }))
      .resolves.toMatchObject({ status: "terminal", endReason: "model_transport_error" });
    expect(f.model.requests).toHaveLength(3);
  });

  it("continues to a tool decision when the summary provider fails", async () => {
    const f = await fixture({ responses: [new Error("summary unavailable"), { message: toolDecision("next") }] });
    f.history(10, 60000);
    await expect(f.cycle().run(f.run)).resolves.toMatchObject({ status: "committed" });
    expect(messageToolCalls(f.surface.completedCycles.at(-1)!.assistant)[0]?.id).toBe("next");
  });

  it("discards a summary invalidated by continuity before any tool execution", async () => {
    const controller = new AbortController();
    const f = await fixture({ respond: () => { controller.abort(); return { message: checkpoint }; } });
    f.history(10, 60000);
    const before = f.surface.requestMessages();
    const execute = vi.fn();
    await expect(f.cycle().run({ tools, continuitySignal: controller.signal, executeOuterCall: execute })).resolves.toEqual({ status: "discarded" });
    expect(execute).not.toHaveBeenCalled();
    expect(f.surface.requestMessages()).toEqual(before);
  });
});
