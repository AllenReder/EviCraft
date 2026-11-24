import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import { HarnessRunEventLog } from "../src/harness/harness-run-event-log.js";
import { decisionCycle } from "./support/decision-cycle.js";
import { ModelSurface } from "../src/harness/model-surface.js";
import {
  ModelContextOverflowError,
  messageText,
  textMessage,
  toolResultMessage,
} from "../src/harness/model-surface-message.js";
import { ScriptedLanguageModel } from "../src/harness/testing/scripted-language-model.js";

describe("Model Decision Cycle", () => {
  const directories: string[] = [];
  const logs: HarnessRunEventLog[] = [];

  afterEach(async () => {
    await Promise.allSettled(logs.splice(0).map(log => log.close()));
    await Promise.all(directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  async function createLog(...args: Parameters<typeof HarnessRunEventLog.create>) {
    const log = await HarnessRunEventLog.create(...args);
    logs.push(log);
    return log;
  }


  it("preserves journal errors after model success without settling a request twice", async () => {
    const eventLog = await createLog(await temporaryDirectory(directories), "settlement");
    const original = eventLog.commit.bind(eventLog);
    vi.spyOn(eventLog, "commit").mockImplementation(async (event) => {
      if (event.type === "model_call_finished") throw new Error("DISK_WRITE_FAILURE");
      return await original(event);
    });
    const languageModel = new ScriptedLanguageModel({ responses: [{ message: toolDecision("one") }] });
    const cycle = decisionCycle({ mode: "native", model: new AiSdkModelSession(languageModel, languageModel.limits),
      surface: seededSurface(), eventLog });
    await expect(cycle.run({ tools: [waitTool], continuitySignal: new AbortController().signal,
      executeOuterCall: async () => ({ ok: true }) })).rejects.toThrow("DISK_WRITE_FAILURE");
  });


  it("carries the existing summary through successive proactive compactions", async () => {
    const eventLog = await createLog(await temporaryDirectory(directories), "cumulative");
    const surface = seededSurface();
    surface.replaceHistory(textMessage("user", "UNIQUE_OLD_MEMORY"), surface.completedCycles.slice(-1));
    const summaries: string[] = [];
    const model = new ScriptedLanguageModel({ limits: { contextWindowTokens: 16384, maxOutputTokens: 2048 }, respond: request => {
      if (request.tools === undefined) {
        summaries.push(JSON.stringify(request.messages));
        expect(summaries.at(-1)).toContain("UNIQUE_OLD_MEMORY");
        return { message: { role: "assistant", content: "UNIQUE_OLD_MEMORY and recent facts" } };
      }
      return { message: toolDecision("cycle-" + summaries.length) };
    } });
    const cycle = decisionCycle({ mode: "native", model: new AiSdkModelSession(model, model.limits), surface, eventLog });
    for (let index = 0; index < 3; index++) {
      surface.commit(toolDecision("large-" + index), toolResultMessage("large-" + index, "wait", "x".repeat(36000)));
      surface.commit(toolDecision("recent-" + index), toolResultMessage("recent-" + index, "wait", "done"));
      await expect(cycle.run({ tools: [waitTool], continuitySignal: new AbortController().signal,
        executeOuterCall: async () => ({ ok: true }) })).resolves.toMatchObject({ status: "committed" });
    }
    expect(summaries).toHaveLength(3);
    expect(JSON.stringify(surface.requestMessages())).toContain("UNIQUE_OLD_MEMORY");
  });

  it("commits one accepted outer Tool settlement as one Completed Tool Cycle", async () => {
    const artifactsDirectory = await temporaryDirectory(directories);
    const eventLog = await createLog(artifactsDirectory, "cycle");
    const surface = new ModelSurface(
      textMessage("system", "contract"),
      {
        message: textMessage("user", "current decision context with fresh observation"),
        historyMessage: textMessage("user", "current decision context"),
      },
    );
    const languageModel = new ScriptedLanguageModel({
      responses: [{
        message: {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "wait",
            input: { seconds: 0 },
          }],
        },
      }],
    });
    const cycle = decisionCycle({
      mode: "native",
      model: new AiSdkModelSession(languageModel, languageModel.limits),
      surface,
      eventLog,
    });

    const result = await cycle.run({
      tools: [{
        name: "wait",
        description: "Wait without changing the world.",
        inputSchema: {
          type: "object",
          properties: { seconds: { type: "number" } },
          required: ["seconds"],
          additionalProperties: false,
        },
      }],
      continuitySignal: new AbortController().signal,
      executeOuterCall: async () => ({
        ok: true,
        result: { ok: true, data: { waited: true } },
        modelContent: "waited",
      }),

    });
    await eventLog.drain();

    expect(result).toEqual({ status: "committed" });
    expect(surface.completedCycles).toHaveLength(1);
    expect(surface.completedCycles[0]?.decisionContext).toEqual(
      textMessage("user", "current decision context"),
    );
    const events = (await readFile(eventLog.path, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter(event => event.type === "model_call_finished" || event.type === "committed_tool_cycle"))
      .toEqual([
        expect.objectContaining({ decisionContext: textMessage("user", "current decision context with fresh observation") }),
        expect.objectContaining({ decisionContext: textMessage("user", "current decision context with fresh observation") }),
      ]);
    expect(events.map(event => event.type)).toEqual([
      "model_call_started",
      "model_attempt_started",
      "model_attempt_finished",
      "model_call_finished",
      "outer_call_started",
      "outer_call_finished",
      "committed_tool_cycle",
    ]);
  });

  it("discards an in-flight decision when Harness continuity changes", async () => {
    const artifactsDirectory = await temporaryDirectory(directories);
    const eventLog = await createLog(artifactsDirectory, "discarded");
    const surface = new ModelSurface(textMessage("system", "contract"), contextMessages("context"));
    const languageModel = new ScriptedLanguageModel({
      respond: async (_request, _index, { signal }) => await new Promise((resolve) => {
        signal?.addEventListener("abort", () => { resolve(new Error("superseded")); }, { once: true });
      }),
    });
    const continuity = new AbortController();
    const cycle = decisionCycle({
      mode: "native",
      model: new AiSdkModelSession(languageModel, languageModel.limits),
      surface,
      eventLog,
    });

    const pending = cycle.run({
      tools: [waitTool],
      continuitySignal: continuity.signal,
      executeOuterCall: async () => { throw new Error("discarded decision must not execute a Tool"); },

    });
    await waitForRequest(languageModel);
    continuity.abort("fresh continuity");

    await expect(pending).resolves.toEqual({ status: "discarded" });
    expect(surface.completedCycles).toHaveLength(0);
  });

  it("commits an interrupted action-phase cycle as INTERRUPTED when synthesis supplies content", async () => {
    const artifactsDirectory = await temporaryDirectory(directories);
    const eventLog = await createLog(artifactsDirectory, "interrupted-commit");
    const surface = new ModelSurface(textMessage("system", "contract"), contextMessages("context"));
    const languageModel = new ScriptedLanguageModel({ responses: [{ message: toolDecision("tool-1") }] });
    const continuity = new AbortController();
    const cycle = decisionCycle({
      mode: "code",
      model: new AiSdkModelSession(languageModel, languageModel.limits),
      surface,
      eventLog,
    });
    const interruptedCalls: string[] = [];

    const result = await cycle.run({
      tools: [waitTool],
      continuitySignal: continuity.signal,
      executeOuterCall: async () => {
        continuity.abort("Hazard decision requested: low_air");
        return { ok: false, error: { name: "ProgrammaticExecutionError", code: "canceled", message: "Programmatic Execution canceled" } };
      },
      onInterrupted: async () => { interruptedCalls.push("journaled"); },
      interruptedResultContent: () => "Programmatic Execution interrupted (low_air)",
    });
    await eventLog.drain();

    expect(result).toEqual({ status: "committed" });
    expect(interruptedCalls).toEqual(["journaled"]);
    expect(surface.completedCycles).toHaveLength(1);
    expect(messageText(surface.completedCycles[0]!.toolResult)).toBe("Programmatic Execution interrupted (low_air)");
    const events = (await readFile(eventLog.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.some(event => event.type === "model_call_discarded")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "outer_call_finished", outcome: "interrupted", result: { interrupted: true },
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "committed_tool_cycle", toolCallId: "tool-1" }));
  });

  it("snapshots the interruption reason at abort before journaling and synthesis", async () => {
    const artifactsDirectory = await temporaryDirectory(directories);
    const eventLog = await createLog(artifactsDirectory, "interrupted-snapshot-order");
    const surface = new ModelSurface(textMessage("system", "contract"), contextMessages("context"));
    const languageModel = new ScriptedLanguageModel({ responses: [{ message: toolDecision("tool-1") }] });
    const continuity = new AbortController();
    const cycle = decisionCycle({
      mode: "native",
      model: new AiSdkModelSession(languageModel, languageModel.limits),
      surface,
      eventLog,
    });
    const ordering: string[] = [];

    const result = await cycle.run({
      tools: [waitTool],
      continuitySignal: continuity.signal,
      executeOuterCall: async () => {
        continuity.abort("Hazard decision requested: low_air");
        return { ok: true, result: { ok: true } };
      },
      onInterruptionSnapshot: () => { ordering.push("snapshot"); },
      onInterrupted: async () => { ordering.push("journaled"); },
      interruptedResultContent: () => { ordering.push("synthesized"); return "Ability wait interrupted (low_air)"; },
    });
    await eventLog.drain();

    expect(result).toEqual({ status: "committed" });
    // The abort-time snapshot is atomic with the interruption: it runs before
    // the onInterrupted journaling and the INTERRUPTED-result synthesis, so a
    // hazard arriving during settlement cannot drain into this cycle's result.
    expect(ordering).toEqual(["snapshot", "journaled", "synthesized"]);
  });

  it("discards an interrupted action-phase cycle when synthesis declines", async () => {
    const artifactsDirectory = await temporaryDirectory(directories);
    const eventLog = await createLog(artifactsDirectory, "interrupted-discard");
    const surface = new ModelSurface(textMessage("system", "contract"), contextMessages("context"));
    const languageModel = new ScriptedLanguageModel({ responses: [{ message: toolDecision("tool-1") }] });
    const continuity = new AbortController();
    const cycle = decisionCycle({
      mode: "native",
      model: new AiSdkModelSession(languageModel, languageModel.limits),
      surface,
      eventLog,
    });

    const result = await cycle.run({
      tools: [waitTool],
      continuitySignal: continuity.signal,
      executeOuterCall: async () => {
        continuity.abort("Hazard decision requested: low_air");
        return { ok: true, result: { ok: true } };
      },
      interruptedResultContent: () => undefined,
    });
    await eventLog.drain();

    expect(result).toEqual({ status: "discarded" });
    expect(surface.completedCycles).toHaveLength(0);
    const events = (await readFile(eventLog.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ type: "model_call_discarded", reason: "hazard_preemption" }));
    expect(events.some(event => event.type === "committed_tool_cycle")).toBe(false);
  });

  it("commits an interrupted cycle whose action never produced a result", async () => {
    const artifactsDirectory = await temporaryDirectory(directories);
    const eventLog = await createLog(artifactsDirectory, "interrupted-unsettled");
    const surface = new ModelSurface(textMessage("system", "contract"), contextMessages("context"));
    const languageModel = new ScriptedLanguageModel({ responses: [{ message: toolDecision("tool-1") }] });
    const continuity = new AbortController();
    const cycle = decisionCycle({
      mode: "code",
      model: new AiSdkModelSession(languageModel, languageModel.limits),
      surface,
      eventLog,
    });

    const result = await cycle.run({
      tools: [waitTool],
      continuitySignal: continuity.signal,
      executeOuterCall: async () => {
        continuity.abort("Hazard decision requested: on_fire");
        return await new Promise(() => {});
      },
      interruptedResultContent: (_call, outerResult) => {
        expect(outerResult).toBeUndefined();
        return "Programmatic Execution interrupted (on_fire)";
      },
    });
    await eventLog.drain();

    expect(result).toEqual({ status: "committed" });
    expect(surface.completedCycles).toHaveLength(1);
    expect(messageText(surface.completedCycles[0]!.toolResult)).toBe("Programmatic Execution interrupted (on_fire)");
  });

  it.each(["stop", "length"] as const)("recovers missing tool calls after %s without retaining failed output", async finishReason => {
    const eventLog = await createLog(await temporaryDirectory(directories), "missing-recovery");
    const surface = seededSurface();
    const model = new ScriptedLanguageModel({ responses: [
      { message: { role: "assistant", content: "FAILED_OUTPUT" }, finishReason: { unified: finishReason, raw: finishReason } },
      { message: { role: "assistant", content: "FAILED_OUTPUT_AGAIN" }, finishReason: { unified: finishReason, raw: finishReason } },
      { message: toolDecision("recovered") },
    ] });
    const prepareDecision = vi.fn(async () => {});
    const execute = vi.fn(async () => ({ ok: true }));
    const cycle = decisionCycle({ mode: "native", model: new AiSdkModelSession(model, model.limits), surface, eventLog });
    await expect(cycle.run({ tools: [waitTool], continuitySignal: new AbortController().signal,
      prepareDecision, executeOuterCall: execute })).resolves.toEqual({ status: "committed" });
    expect(prepareDecision).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(3);
    for (const request of model.requests.slice(1)) {
      const messages = JSON.stringify(request.messages);
      expect(messages).not.toContain("FAILED_OUTPUT");
      expect(messages.match(/structured tool call/g)).toHaveLength(1);
      expect(messages).toContain("Call one available tool directly");
    }
    expect(JSON.stringify(surface.requestMessages())).not.toContain("Call one available tool directly");
    expect(JSON.stringify(surface.requestMessages())).not.toContain("FAILED_OUTPUT");
    await eventLog.drain();
    const events = (await readFile(eventLog.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.code === "missing_tool_call")).toHaveLength(2);
    expect(events.filter(event => event.type === "model_call_finished")).toHaveLength(3);
  });

  it.each(["operator", "continuity"])("stops missing-tool recovery on %s cancellation", async kind => {
    const eventLog = await createLog(await temporaryDirectory(directories), "missing-cancel");
    const operator = new AbortController();
    const continuity = new AbortController();
    const commit = eventLog.commit.bind(eventLog);
    vi.spyOn(eventLog, "commit").mockImplementation(async event => {
      await commit(event);
      if (event.type === "model_protocol_error") (kind === "operator" ? operator : continuity).abort();
    });
    const model = new ScriptedLanguageModel({ respond: () => ({ message: textMessage("assistant", "no tool") }) });
    const surface = seededSurface();
    const before = surface.requestMessages();
    const cycle = decisionCycle({ mode: "native", model: new AiSdkModelSession(model, model.limits), surface, eventLog });
    const execute = vi.fn();
    await expect(cycle.run({ tools: [waitTool], signal: operator.signal, continuitySignal: continuity.signal,
      executeOuterCall: execute })).resolves.toEqual(kind === "operator"
        ? { status: "terminal", endReason: "external_stop" } : { status: "discarded" });
    expect(model.requests).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(surface.requestMessages()).toEqual(before);
  });

});

const waitTool = {
  name: "wait",
  description: "Wait without changing the world.",
  inputSchema: {
    type: "object",
    properties: { seconds: { type: "number" } },
    required: ["seconds"],
    additionalProperties: false,
  },
} as const;

function seededSurface(): ModelSurface {
  const surface = new ModelSurface(textMessage("system", "contract"), contextMessages("context-1"));
  surface.commit(toolDecision("tool-old-1"), toolResultMessage("tool-old-1", "wait", "first"));
  surface.replaceCurrentContext(contextMessages("context-2"));
  surface.commit(toolDecision("tool-old-2"), toolResultMessage("tool-old-2", "wait", "second"));
  surface.replaceCurrentContext(contextMessages("context-3"));
  return surface;
}

function contextMessages(text: string) {
  const message = textMessage("user", text);
  return { message, historyMessage: message };
}

function toolDecision(toolCallId: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId, toolName: "wait", input: { seconds: 0 } }],
  };
}

async function temporaryDirectory(directories: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "model-decision-cycle-"));
  directories.push(directory);
  return directory;
}

async function waitForRequest(model: ScriptedLanguageModel): Promise<void> {
  while (model.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
}
