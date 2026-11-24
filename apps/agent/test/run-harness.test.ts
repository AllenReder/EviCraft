import { chatSse, sseResponse } from "./support/model-stream-fixtures.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ModelContextOverflowError,
  messageText,
} from "../src/harness/model-surface-message.js";
import { borrowedRuntimeSession, ownedRuntimeSession, runHarness as actualRunHarness, STALLED_DECISIONS_BEFORE_HISTORY_RESET, staticGoalContext, type HarnessProgressEvent } from "../src/harness/run-harness.js";
import type { OperatorInteraction } from "../src/harness/operator-interaction.js";
import { createProjectSkillSnapshotBuilder } from "../src/harness/project-skills/project-skill-library.js";
import { RuntimeAdapter, type RuntimeSdkClient } from "../src/harness/runtime-adapter.js";
import {
  ScriptedLanguageModel as BaseScriptedLanguageModel,
  type ScriptedDecision,
  type ScriptedModelCall,
  type ScriptedLanguageModelOptions,
} from "../src/harness/testing/scripted-language-model.js";
import { createDeepSeekTestTransport } from "./support/deepseek-test-transport.js";
import { createOpenAiTestTransport } from "./support/openai-test-transport.js";
import { createOpenAiCompatibleTestTransport } from "./support/openai-compatible-test-transport.js";
import { runScenarioHarness, scriptedScenarioEnd, scriptedToolDecision } from "../src/smoke/scenario-harness.js";

// Legacy fixture endings now exercise the operator stop path after a normal Tool cycle.
class ScriptedLanguageModel extends BaseScriptedLanguageModel {
  readonly finishCallIds: Set<string>;
  constructor(options: ScriptedLanguageModelOptions) {
    const finishCallIds = new Set<string>();
    const convert = (response: ScriptedDecision | Error): ScriptedDecision | Error => {
      if (response instanceof Error || typeof response.message.content === "string") return response;
      return { ...response, message: { ...response.message, content: response.message.content.map(part => {
        if (part.type !== "tool-call" || part.toolName !== "end_run") return part;
        finishCallIds.add(part.toolCallId);
        return { ...part, toolName: "update_plan", input: { items: [] } };
      }) } };
    };
    super({ ...options,
      ...(options.responses ? { responses: options.responses.map(convert) } : {}),
      ...(options.respond ? { respond: async (request, index, context) => convert(await options.respond!(request, index, context)) } : {}),
    });
    this.finishCallIds = finishCallIds;
  }
}

type ActionBoundary = Readonly<{ type: "harness_model_request_started" | "harness_action_started" } | { type: "harness_action_ended"; status: string }>;

/**
 * `onLifecycleEvent` lets a test act at the boundaries of a cycle. An action start is reported one microtask
 * after the Tool call is accepted, which is after the call was handed to the Ability Runtime and before the
 * Ability itself begins.
 */
function runHarness({ onLifecycleEvent, ...options }: Parameters<typeof actualRunHarness>[0] & { onLifecycleEvent?: (event: ActionBoundary) => unknown }) {
  const controller = new AbortController();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
  return actualRunHarness({ ...options, signal, onProgress: event => {
    options.onProgress?.(event);
    if (event.type === "decision_context") onLifecycleEvent?.({ type: "harness_model_request_started" });
    if (event.type === "outer_call_started") queueMicrotask(() => onLifecycleEvent?.({ type: "harness_action_started" }));
    if (event.type === "outer_call_finished") {
      onLifecycleEvent?.({ type: "harness_action_ended", status: event.outcome === "ok" ? "completed" : event.outcome === "interrupted" ? "interrupted" : "failed" });
    }
    if (event.type === "outer_call_finished" && (event.toolCallId === "finish" || event.toolCallId === "end"
      || (options.languageModel instanceof ScriptedLanguageModel && options.languageModel.finishCallIds.has(event.toolCallId)))) {
      controller.abort(new Error("Test operator stopped the Run"));
    }
  } });
}

describe("Harness Run", () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await Promise.all(directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("externally stops a conformance scenario after a successful final Tool cycle", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new BaseScriptedLanguageModel({ responses: [
      scriptedToolDecision("end-wait", "wait", { seconds: 0 }),
      scriptedScenarioEnd(),
      scriptedScenarioEnd(),
    ] });
    const completed: string[] = [];
    const options = {
      config: { ...config(directory), mode: "native" }, secrets: {},
      createRuntimeSession: async () => borrowedRuntimeSession(new RuntimeAdapter(client)),
      onProgress(event: HarnessProgressEvent) {
        if (event.type === "outer_call_finished") completed.push(event.toolCallId);
      },
    };
    const agentContext = staticGoalContext("Complete the scenario");
    const result = await runScenarioHarness({ ...options, agentContext,
      languageModel: model, modelLimits: model.limits, decisionCycleLimit: 3,
    });
    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(model.requests).toHaveLength(2);
    expect(completed).toEqual(["end-wait"]);
    expect(client.close).not.toHaveBeenCalled();
    expect(await runEvents(directory)).toContainEqual(expect.objectContaining({
      type: "outer_call_finished", toolCallId: "scenario-end", tool: "update_plan", outcome: "ok",
    }));
  });

  it.each([
    ["grounded_evidence", undefined, true],
    ["loaded_world_state", undefined, true],
    ["grounded_evidence", "shared", true],
    ["loaded_world_state", "shared", true],
    ["grounded_evidence", "profile-default", true],
    ["loaded_world_state", "profile-default", false],
  ] as const)("selects one native registry for profile %s and ability set %s", async (profile, abilitySet, searchAvailable) => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ profile });
    const model = new ScriptedLanguageModel({ responses: [decision("wait", "wait", { seconds: 0 }), decision("end", "end_run", {})] });
    const result = await runHarness({ agentContext: staticGoalContext("Use available abilities"),
      config: { ...config(directory), mode: "native", ...(abilitySet === undefined ? {} : { abilitySet }) }, secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    const names = model.requests[0]!.tools.map(tool => tool.name).filter(name => !["load_skill", "update_plan", "end_run"].includes(name));
    expect(names).toContain("mine_down");
    expect(names.includes("explore_and_return")).toBe(searchAvailable);
    expect(names.includes("tunnel_for_blocks")).toBe(searchAvailable);
    const events = await runEvents(directory);
    expect(events.find(event => event.type === "registry_view")).toMatchObject({ abilities: names,
      abilitySet: { version: "1", mode: abilitySet ?? "shared", worldKnowledgeProfile: profile } });
    expect(events).toContainEqual(expect.objectContaining({ type: "ability_call_finished", ability: "wait", outcome: "succeeded" }));
    expect(client.runtimeInfo).toHaveBeenCalledOnce();
  });

  it("omits unavailable P abilities from the code SDK and rejects a disabled child call", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ profile: "loaded_world_state" });
    const model = new ScriptedLanguageModel({ responses: [decision("attempt", "run_code", {
      description: "Attempt an unavailable search strategy", code: 'return await abilities.tunnel_for_blocks({ block_id_glob: "minecraft:iron_ore", direction: "north", max_length: 1 });',
    }), decision("wait", "run_code", { description: "Use an available child", code: "const result = await abilities.wait({seconds:0}); return { names: Object.keys(abilities).sort(), result };" }), decision("end", "end_run", {})] });
    const result = await runHarness({ agentContext: staticGoalContext("Use available abilities"), config: { ...config(directory), abilitySet: "profile-default" }, secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    const context = model.requests[0]!.messages.map(messageText).join("\n");
    expect(context).toContain("readonly mine_down:");
    expect(context).not.toContain("readonly explore_and_return:");
    expect(context).not.toContain("readonly tunnel_for_blocks:");
    const events = await runEvents(directory);
    expect(events.find(event => event.type === "outer_call_finished" && event.toolCallId === "attempt")).toMatchObject({ outcome: "error" });
    expect(events.filter(event => event.type === "ability_call_started" && event.ability === "tunnel_for_blocks")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "ability_call_finished", ability: "wait", outcome: "succeeded" }));
    const registry = events.find(event => event.type === "registry_view")!;
    expect(registry.abilities).not.toContain("tunnel_for_blocks");
    expect(events.find(event => event.type === "outer_call_finished" && event.toolCallId === "wait")).toMatchObject({
      result: { result: { result: { names: registry.abilities } } },
    });
    expect(client.blockFind).not.toHaveBeenCalled();
  });

  it("rejects an unavailable P operator selection before starting any child action", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ profile: "loaded_world_state" });
    const result = await runHarness({ config: { ...config(directory), mode: "native", abilitySet: "profile-default" }, secrets: {},
      agentContext: staticGoalContext("Use available abilities"),
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      operator: { choose: async () => ({ toolName: "explore_and_return", input: {} }) }, decisionCycleLimit: 1 });
    expect(result).toMatchObject({ endReason: "internal_error" });
    const events = await runEvents(directory);
    expect(events).toContainEqual(expect.objectContaining({ type: "failure", message: expect.stringContaining("unavailable Ability explore_and_return") }));
    expect(events.filter(event => event.type === "ability_call_started" && event.source !== "turn_observation_assembler")).toEqual([]);
    expect(client.blockFind).not.toHaveBeenCalled();
  });

  it("closes the session without requesting a decision when the actual profile cannot be read", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    vi.mocked(client.runtimeInfo).mockImplementation(async () => {
      throw new Error("runtime info unavailable");
    });
    const model = new ScriptedLanguageModel({ responses: [decision("end", "end_run", {})] });
    const result = await runHarness({ config: config(directory), secrets: {}, agentContext: staticGoalContext("Use available abilities"),
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ status: "setup_failure", failure: { code: "RUNTIME_CONNECTION_FAILED", message: "runtime info unavailable" } });
    expect(model.requests).toEqual([]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("fails setup when the Bot to attach does not exist", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    vi.mocked(client.actorGet).mockResolvedValue(null);
    const model = new ScriptedLanguageModel({ responses: [decision("end", "end_run", {})] });
    const result = await runHarness({ config: config(directory), secrets: {}, agentContext: staticGoalContext("Attach"), existingBotId: "missing",
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ status: "setup_failure", failure: { code: "RUNTIME_CONNECTION_FAILED", message: expect.stringContaining("not available") } });
    expect(client.ensureBot).not.toHaveBeenCalled();
    expect(model.requests).toEqual([]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("asks the model again after an unusable response instead of ending the run", async () => {
    const directory = await temporaryDirectory(directories);
    const model = new ScriptedLanguageModel({ responses: [
      { message: { role: "assistant", content: "I will think about it first." } },
      decision("end", "end_run", {}),
    ] });
    const result = await runHarness({ config: { ...config(directory), mode: "native" }, secrets: {}, agentContext: staticGoalContext("Act"),
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(model.requests).toHaveLength(2);
    expect(messageText(model.requests[1]!.messages.at(-1)!)).toContain("did not include a structured tool call");
    const journal = await runEvents(directory);
    expect(journal).toContainEqual(expect.objectContaining({ type: "model_protocol_error", code: "missing_tool_call", willRetry: true }));
    expect(journal.filter(event => event.type === "committed_tool_cycle")).toHaveLength(1);
  });

  it("clears the model history after decisions that let no game time pass, and counts again from there", async () => {
    const directory = await temporaryDirectory(directories);
    const stalled = STALLED_DECISIONS_BEFORE_HISTORY_RESET;
    const model = new ScriptedLanguageModel({ responses: [
      ...Array.from({ length: stalled + 2 }, (_, index) => decision(`plan-${index}`, "update_plan", { items: [] })),
      decision("end", "end_run", {}),
    ] });
    let tick = 0;
    const client = fakeRuntimeClient();
    // Game time passes only after the first decision; every later decision leaves it where it was.
    client.observe.mockImplementation(async () => ({ observation_revision: 8, server_tick: client.observe.mock.calls.length > 1 ? tick = 40 : tick, game_time: tick }));
    await runHarness({ config: { ...config(directory), mode: "native" }, secrets: {}, agentContext: staticGoalContext("Act"),
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    const resets = (await runEvents(directory)).filter(event => event.type === "history_reset");
    expect(resets).toEqual([expect.objectContaining({ reason: "no_game_time_advanced", serverTick: 40, stalledDecisions: stalled, removedCycles: stalled + 1 })]);
    const lengths = model.requests.map(request => request.messages.length);
    expect(lengths[stalled + 1]).toBe(lengths[0]);
    expect(lengths[stalled + 2]).toBe(lengths[0]! + 3);
  });

  it("shortens an oversized Tool result for the model and keeps the whole output in the journal", async () => {
    const directory = await temporaryDirectory(directories);
    const model = new ScriptedLanguageModel({ responses: [
      decision("big", "run_code", { description: "Print a very long line", code: "console.log('HEAD' + 'x'.repeat(200000) + 'TAIL');" }),
      decision("end", "end_run", {}),
    ] });
    await runHarness({ config: config(directory), secrets: {}, agentContext: staticGoalContext("Act"),
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())), languageModel: model, modelLimits: model.limits });
    const shown = messageText(model.requests[1]!.messages.at(-2)!);
    expect(shown.length).toBeLessThan(50_000);
    expect(shown.startsWith("HEAD")).toBe(true);
    expect(shown.trimEnd().endsWith("TAIL")).toBe(true);
    expect(shown).toContain("[Tool result shortened to fit context; original output is in the run log.]");
    const finished = (await runEvents(directory)).find(event => event.type === "outer_call_finished" && event.toolCallId === "big");
    expect(JSON.stringify(finished).length).toBeGreaterThan(200_000);
  });

  it("presents initial hazards to the model without executing a rescue", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ air: 80, underwater: true, suffocating: true });
    const model = new ScriptedLanguageModel({ responses: [decision("end", "end_run", {})] });
    const result = await runHarness({ agentContext: staticGoalContext("Choose your own response"), config: config(directory), secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(model.requests).toHaveLength(1);
    const context = messageText(model.requests[0]!.messages.at(-1)!);
    // Initial hazards seeded at run start have no interrupted Tool result to
    // ride on, so the first Decision Context carries them in trigger.hazard_reasons.
    expect(preStepContext(context)).toMatchObject({ trigger: { hazard_reasons: ["suffocation", "low_air"] } });
    expect(context).not.toContain('"hazard_decision"');
    expect(context).not.toContain('"interrupted_actions"');
    expect(client.toolNames).not.toContain("goto");
    expect((await runEvents(directory)).some(e => String(e.type).startsWith("instinct_"))).toBe(false);
  });

  it("interrupts once, drains the old action, and lets the model choose the response", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ interruptAgentGotoWithLowAir: true });
    const hooks: Array<{ type: string; status?: string }> = [];
    const model = new ScriptedLanguageModel({ responses: [decision("move", "goto", { x: 8, z: 8 }), decision("end", "end_run", {})] });
    const result = await runHarness({ agentContext: staticGoalContext("Choose your own response"), config: { ...config(directory), mode: "native" }, secrets: {},
      onLifecycleEvent: async e => { hooks.push(e); },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(client.taskCancel).toHaveBeenCalledTimes(1);
    expect(client.toolNames.filter(n => n === "goto")).toEqual(["goto"]);
    expect(hooks.filter(e => e.type === "harness_action_ended").map(e => e.status)).toEqual(["interrupted", "completed"]);
    // The started body Ability commits as a uniform INTERRUPTED cycle whose text
    // carries the Ability's own outcome message; the hazard reason was absorbed
    // by the interrupted result and must not reappear in trigger.hazard_reasons.
    const committed = messageText(model.requests[1]!.messages.at(-2)!);
    expect(committed).toContain("Ability goto interrupted (low_air)");
    expect(committed).toContain("cancelled after neutral cleanup");
    const fresh = messageText(model.requests[1]!.messages.at(-1)!);
    expect(fresh).not.toContain("cancelled after neutral cleanup");
    expect(fresh).not.toContain('"low_air"');
    expect(preStepContext(fresh)).not.toHaveProperty("trigger");
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "model_call_discarded")).toHaveLength(0);
    expect(journal.filter(e => e.type === "committed_tool_cycle")).toHaveLength(2);
    expect(journal).toContainEqual(expect.objectContaining({ type: "outer_call_finished", outcome: "interrupted" }));
    expect(journal).toContainEqual(expect.objectContaining({ type: "hazard_action_interrupted", tool: "goto", toolCallId: "move" }));
    expect(journal).toContainEqual(expect.objectContaining({ type: "hazard_interruption", reasons: ["low_air"] }));
    expect(client.observe).toHaveBeenCalledTimes(2);
  });

  it("waits for a Runtime terminal after cancel ACK before pausing and deciding", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const events: string[] = [];
    let terminal!: (value: { success: false; message: string; interrupted: true }) => void;
    const taskResult = new Promise<{ success: false; message: string; interrupted: true }>(resolve => { terminal = resolve; });
    let ack!: () => void;
    const acked = new Promise<void>(resolve => { ack = resolve; });
    const start = vi.mocked(client.startToolCall).getMockImplementation()!;
    vi.mocked(client.startToolCall).mockImplementation((name, args) => {
      if (name !== "goto") return start(name, args);
      queueMicrotask(() => client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ in_lava: true }) }));
      return { taskId: 1000, result: taskResult };
    });
    vi.mocked(client.taskCancel).mockImplementation(async id => { events.push("ack"); ack(); return { task_id: id, cancelled: true }; });
    const model = new ScriptedLanguageModel({ responses: [decision("move", "goto", { x: 8, z: 8 }), decision("end", "end_run", {})] });
    const running = runHarness({ agentContext: staticGoalContext("Choose response"), config: { ...config(directory), mode: "native" }, secrets: {},
      onLifecycleEvent: async e => { events.push(e.type); },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    await acked;
    expect(model.requests).toHaveLength(1);
    expect(events).not.toContain("harness_action_ended");
    terminal({ success: false, interrupted: true, message: "old movement neutralized" });
    expect(await running).toMatchObject({ endReason: "external_stop" });
    expect(events.indexOf("harness_action_ended")).toBeGreaterThan(events.indexOf("ack"));
    const committed = messageText(model.requests[1]!.messages.at(-2)!);
    expect(committed).toContain("Ability goto interrupted (in_lava)");
    expect(committed).toContain("old movement neutralized");
    expect((await runEvents(directory)).filter(e => e.type === "model_call_discarded")).toHaveLength(0);
  });

  it("commits a queued-but-not-started Native Ability as INTERRUPTED without the raw rejection reason", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const hooks: Array<{ type: string; status?: string }> = [];
    const model = new ScriptedLanguageModel({ responses: [decision("move", "goto", { x: 8, z: 8 }), decision("end", "end_run", {})] });
    const result = await runHarness({ agentContext: staticGoalContext("Choose your own response"), config: { ...config(directory), mode: "native" }, secrets: {},
      onLifecycleEvent: async e => {
        hooks.push(e);
        // The hazard fires after the Tool call is accepted but before the body
        // Ability dispatches, so the queued call rejects with the raw abort
        // reason, which must not reach the Model Surface.
        if (e.type === "harness_action_started") {
          client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ on_fire: true }) });
        }
      },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    // The abort races dispatch: the queued call either never reached the
    // Runtime or settled as a typed INTERRUPTED task; either way no cancel ran.
    expect(client.taskCancel).not.toHaveBeenCalled();
    expect(hooks.filter(e => e.type === "harness_action_ended").map(e => e.status)).toEqual(["interrupted", "completed"]);
    const committed = messageText(model.requests[1]!.messages.at(-2)!);
    expect(committed).toContain("Ability goto interrupted (on_fire)");
    expect(committed).not.toContain("Hazard decision requested");
    expect(messageText(model.requests[1]!.messages.at(-1)!)).not.toContain("Hazard decision requested");
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "model_call_discarded")).toHaveLength(0);
    expect(journal.filter(e => e.type === "committed_tool_cycle")).toHaveLength(2);
    const interrupted = journal.find(e => e.type === "hazard_action_interrupted" && e.tool === "goto");
    expect(interrupted).toMatchObject({ toolCallId: "move" });
    expect(JSON.stringify(interrupted)).not.toContain("Hazard decision requested");
  });

  it("commits Native and Code Mode interruptions as structurally uniform cycles", async () => {
    const nativeDirectory = await temporaryDirectory(directories);
    const codeDirectory = await temporaryDirectory(directories);
    const nativeModel = new ScriptedLanguageModel({ responses: [decision("move", "goto", { x: 8, z: 8 }), decision("end", "end_run", {})] });
    const nativeRun = await runHarness({ agentContext: staticGoalContext("Choose your own response"), config: { ...config(nativeDirectory), mode: "native" }, secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient({ interruptAgentGotoWithLowAir: true }))),
      languageModel: nativeModel, modelLimits: nativeModel.limits });
    expect(nativeRun).toMatchObject({ endReason: "external_stop" });
    const codeClient = fakeRuntimeClient({ underwater: true });
    let hazardEmitted = false;
    const codeModel = new ScriptedLanguageModel({ responses: [
      decision("dive", "run_code", { description: "Move deeper", code: "console.log('deeper');\nwhile (true) { await new Promise(resolve => setTimeout(resolve, 5)); }" }),
      decision("end", "end_run", {}),
    ] });
    const codeRun = await runHarness({ agentContext: staticGoalContext("Choose your own response"), config: config(codeDirectory), secrets: {},
      onProgress: e => {
        if (!hazardEmitted && e.type === "programmatic_execution_started" && e.source === "agent") {
          hazardEmitted = true;
          setTimeout(() => codeClient.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ air: 60, underwater: true }) }), 300);
        }
      },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(codeClient)), languageModel: codeModel, modelLimits: codeModel.limits });
    expect(codeRun).toMatchObject({ endReason: "external_stop" });
    const cycleShape = (request: { messages: readonly Parameters<typeof messageText>[0][] }) =>
      request.messages.slice(-3, -1).map(message => ({ role: message.role, text: messageText(message) }));
    const nativeCycle = cycleShape(nativeModel.requests[1]!);
    const codeCycle = cycleShape(codeModel.requests[1]!);
    expect(nativeCycle.map(entry => entry.role)).toEqual(["assistant", "tool"]);
    expect(codeCycle.map(entry => entry.role)).toEqual(["assistant", "tool"]);
    expect(nativeCycle[1]!.text).toContain("interrupted (low_air)");
    expect(codeCycle[1]!.text).toContain("interrupted (low_air)");
  });

  it("commits started and not-yet-started Native interruptions as structurally uniform INTERRUPTED cycles", async () => {
    const cases = {
      // Started body Ability: the Runtime task is cancelled and settles its own
      // typed INTERRUPTED result ("cancelled after neutral cleanup").
      started: {
        run: async (directory: string) => {
          const model = new ScriptedLanguageModel({ responses: [decision("move", "goto", { x: 8, z: 8 }), decision("end", "end_run", {})] });
          await runHarness({ agentContext: staticGoalContext("Choose your own response"), config: { ...config(directory), mode: "native" }, secrets: {},
            createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient({ interruptAgentGotoWithLowAir: true }))),
            languageModel: model, modelLimits: model.limits });
          return model;
        },
        reason: "low_air",
      },
      // Queued-not-started: the hazard fires after the Tool call is accepted but
      // before the body Ability dispatches, so no outcome ever settled.
      queued: {
        run: async (directory: string) => {
          const client = fakeRuntimeClient();
          const model = new ScriptedLanguageModel({ responses: [decision("move", "goto", { x: 8, z: 8 }), decision("end", "end_run", {})] });
          await runHarness({ agentContext: staticGoalContext("Choose your own response"), config: { ...config(directory), mode: "native" }, secrets: {},
            onLifecycleEvent: async e => {
              if (e.type === "harness_action_started") {
                client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ on_fire: true }) });
              }
            },
            createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
          return model;
        },
        reason: "on_fire",
      },
    } as const;
    const interruptedResults: Array<{ shape: string; result: string }> = [];
    for (const [shape, entry] of Object.entries(cases)) {
      const model = await entry.run(await temporaryDirectory(directories));
      interruptedResults.push({ shape, result: messageText(model.requests[1]!.messages.at(-2)!) });
    }
    // Both shapes commit the same uniform INTERRUPTED envelope; only the
    // text differs, faithfully carrying each Ability's actual settled state.
    for (const { shape, result } of interruptedResults) {
      expect(result.startsWith(`Ability goto interrupted (${cases[shape as keyof typeof cases].reason}): `), shape).toBe(true);
    }
    expect(interruptedResults.map(({ result }) => result)).toEqual([
      expect.stringContaining("cancelled after neutral cleanup"),
      expect.stringContaining("no outcome settled before the interruption"),
    ]);
  });

  it("does not cancel the chosen response for repeated continuing hazards", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({ respond: async (_request, index, context) => {
      if (index === 0) {
        client.setBody({ air: 100, underwater: true });
        client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ air: 100, underwater: true, on_fire: true }) });
        await new Promise<void>((_resolve, reject) => {
          if (context.signal?.aborted) reject(context.signal.reason);
          else context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        });
      }
      if (index === 1) {
        for (let sequence = 2; sequence < 6; sequence++) client.emitOccurrence({ type: "body_state_changed", sequence, server_tick: sequence, data: bodyState({ air: 80, underwater: true, on_fire: true }) });
        return decision("respond", "surface", {});
      }
      return decision("end", "end_run", {});
    } });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: { ...config(directory), mode: "native" }, secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(model.requests).toHaveLength(3);
    expect(client.toolNames.filter(n => n === "goto")).toEqual(["goto"]);
    expect(client.taskCancel).not.toHaveBeenCalled();
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "hazard_detected")).toHaveLength(1);
    expect(journal.filter(e => e.type === "ability_call_started" && e.ability === "surface")).toEqual([
      expect.objectContaining({ source: "agent" }),
    ]);
    // The request-phase hazard discarded the first decision without an
    // interrupted Tool result, so the next context carries the reasons in
    // trigger.hazard_reasons; the chosen response then runs uninterrupted.
    expect(preStepContext(messageText(model.requests[1]!.messages.at(-1)!))).toMatchObject({
      trigger: { hazard_reasons: ["low_air", "on_fire"] },
    });
    expect(preStepContext(messageText(model.requests[2]!.messages.at(-1)!))).not.toHaveProperty("trigger");
  });

  it("surfaces a hazard arriving between cycles in trigger.hazard_reasons on the next Decision Context", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    let releaseSecondRequest!: () => void;
    const secondRequestGate = new Promise<void>((resolve) => { releaseSecondRequest = resolve; });
    const model = new ScriptedLanguageModel({ respond: async (_request, index) => {
      if (index === 1) await secondRequestGate;
      if (index === 0) return decision("wait", "wait", { seconds: 0 });
      if (index === 1) return decision("wait-again", "wait", { seconds: 0 });
      return decision("end", "end_run", {});
    } });
    let contexts = 0;
    const running = runHarness({ agentContext: staticGoalContext("Choose response"), config: { ...config(directory), mode: "native" }, secrets: {},
      onProgress: e => {
        if (e.type === "decision_context" && ++contexts === 2) {
          // The first cycle has committed and the next request is gated: no
          // action or request is in flight when the hazard arrives, so it
          // cannot interrupt anything and must ride the following trigger
          // field.
          client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ on_fire: true }) });
          // Let the between-cycle context reassembly publish the trigger
          // field before releasing the gated request that consumes it.
          setTimeout(() => releaseSecondRequest(), 50);
        }
      },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    const result = await running;
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(model.requests).toHaveLength(3);
    expect(preStepContext(messageText(model.requests[1]!.messages.at(-1)!))).toMatchObject({
      trigger: { hazard_reasons: ["on_fire"] },
    });
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "model_call_discarded")).toHaveLength(0);
    expect(journal.some(e => e.type === "hazard_action_interrupted")).toBe(false);
    expect(journal.filter(e => e.type === "committed_tool_cycle")).toHaveLength(3);
  });

  it("invalidates a provider backoff without retrying the old decision or acquiring extra observations", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    let attempts = 0;
    const provider = createOpenAI({ apiKey: "local", fetch: async () => {
      attempts++;
      if (attempts === 1) {
        setTimeout(() => client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ on_fire: true }) }), 30);
        return Response.json({ error: { message: "overloaded", type: "server_error" } }, { status: 503 });
      }
      return sseResponse(chatSse({ id: "new-decision", object: "chat.completion", created: 1, model: "test", choices: [{ index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "end", type: "function", function: { name: "update_plan", arguments: "{\"items\":[]}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: config(directory), secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: provider.chat("test"),
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 } });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(attempts).toBe(2);
    expect(client.observe).toHaveBeenCalledTimes(2);
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "model_call_discarded")).toHaveLength(1);
    expect(journal.filter(e => e.type === "model_attempt_started").map(e => e.attempt)).toEqual([1, 1]);
  });

  it("cancels a proactive summary for a new hazard without replacing history", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({ limits: { contextWindowTokens: 262144, maxOutputTokens: 65536 },
      respond: async (request, index, context) => {
        if (index < 2) return { ...decision("wait-" + index, "wait", { seconds: 0 }), usage: { inputTokens: index === 0 ? 80000 : 160000 } };
        if (request.tools === undefined && index === 2) {
          client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ suffocating: true }) });
          await new Promise<void>((_resolve, reject) => {
            if (context.signal?.aborted) reject(context.signal.reason);
            else context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
          });
        }
        if (request.tools === undefined) return { message: { role: "assistant", content: "Earlier waits completed." } };
        return decision("end", "end_run", {});
      } });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: { ...config(directory), mode: "native" }, secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(client.observe).toHaveBeenCalledTimes(4);
    const journal = await runEvents(directory);
    const cancelled = journal.find(event => event.type === "history_compaction_started")!;
    expect(journal.some(event => event.type === "history_compacted" && event.compactionId === cancelled.compactionId)).toBe(false);
    expect(preStepContext(messageText(model.requests.at(-1)!.messages.at(-1)!))).toMatchObject({ trigger: { hazard_reasons: ["suffocation"] } });
  });

  it("retains undelivered hazard causes and partial effects across an interrupted context assembly", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ interruptAgentGotoWithLowAir: true });
    let contextCount = 0;
    const model = new ScriptedLanguageModel({ responses: [decision("move", "goto", { x: 8, z: 8 }), decision("end", "end_run", {})] });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: { ...config(directory), mode: "native" }, secrets: {},
      onProgress: event => { if (event.type === "decision_context" && ++contextCount === 2) {
        client.emitOccurrence({ type: "body_state_changed", sequence: 3, server_tick: 3, data: bodyState({ air: 80, underwater: true, on_fire: true }) });
      } },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(model.requests).toHaveLength(2);
    // low_air rode on the committed INTERRUPTED cycle; on_fire arrived during the
    // interrupted context assembly with no Tool result to ride on, so it travels
    // in trigger.hazard_reasons on the reassembled context.
    const committed = messageText(model.requests[1]!.messages.at(-2)!);
    expect(committed).toContain("Ability goto interrupted (low_air)");
    expect(committed).toContain("cancelled after neutral cleanup");
    const presented = messageText(model.requests[1]!.messages.at(-1)!);
    expect(preStepContext(presented)).toMatchObject({ trigger: { hazard_reasons: ["on_fire"] } });
    expect(presented).not.toContain("cancelled after neutral cleanup");
    expect(presented).not.toContain('"low_air"');
  });

  it("retains partial effects when a model that received them is superseded before acting", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ interruptAgentGotoWithLowAir: true });
    const model = new ScriptedLanguageModel({ respond: async (request, index, context) => {
      if (index === 0) return decision("move", "goto", { x: 8, z: 8 });
      if (index === 1) {
        expect(messageText(request.messages.at(-2)!)).toContain("Ability goto interrupted (low_air)");
        expect(messageText(request.messages.at(-2)!)).toContain("cancelled after neutral cleanup");
        client.emitOccurrence({ type: "body_state_changed", sequence: 3, server_tick: 3,
          data: bodyState({ air: 80, underwater: true, on_fire: true }) });
        await new Promise<void>((_resolve, reject) => {
          if (context.signal?.aborted) reject(context.signal.reason);
          else context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        });
      }
      return decision("end", "end_run", {});
    } });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: { ...config(directory), mode: "native" }, secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(model.requests).toHaveLength(3);
    const lastCommitted = messageText(model.requests[2]!.messages.at(-2)!);
    expect(lastCommitted).toContain("Ability goto interrupted (low_air)");
    expect(lastCommitted).toContain("cancelled after neutral cleanup");
    const last = messageText(model.requests[2]!.messages.at(-1)!);
    expect(last).not.toContain("cancelled after neutral cleanup");
    expect(last).not.toContain('"low_air"');
    expect(preStepContext(last)).toMatchObject({ trigger: { hazard_reasons: ["on_fire"] } });
    expect(client.toolNames.filter(n => n === "goto")).toEqual(["goto"]);
  });

  it("retains all uncommitted partial effects across consecutive interrupted actions", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const start = vi.mocked(client.startToolCall).getMockImplementation()!;
    let moves = 0;
    let settle: ((result: { success: false; interrupted: true; message: string }) => void) | undefined;
    vi.mocked(client.startToolCall).mockImplementation((name, args) => {
      if (name !== "goto") return start(name, args);
      const move = ++moves;
      const result = new Promise<{ success: false; interrupted: true; message: string }>(resolve => { settle = resolve; });
      queueMicrotask(() => client.emitOccurrence({ type: "body_state_changed", sequence: move, server_tick: move,
        data: bodyState({ air: 80, underwater: true, on_fire: move === 2 }) }));
      return { taskId: 1000 + move, result };
    });
    vi.mocked(client.taskCancel).mockImplementation(async taskId => {
      settle?.({ success: false, interrupted: true, message: moves === 1 ? "first partial movement completed" : "second partial movement completed" });
      return { task_id: taskId, cancelled: true };
    });
    const model = new ScriptedLanguageModel({ responses: [
      decision("first", "goto", { x: 8, z: 8 }), decision("response", "goto", { x: 9, z: 9 }),
      decision("settled-response", "wait", { seconds: 0 }), decision("end", "end_run", {}),
    ] });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: { ...config(directory), mode: "native" }, secrets: {},
      onLifecycleEvent: async () => {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(client.taskCancel).toHaveBeenCalledTimes(2);
    // Both interrupted actions commit as uniform INTERRUPTED cycles, so their
    // outcomes no longer accumulate in the fresh context.
    const firstInterrupted = messageText(model.requests[1]!.messages.at(-2)!);
    expect(firstInterrupted).toContain("Ability goto interrupted (low_air)");
    expect(firstInterrupted).toContain("first partial movement completed");
    const secondInterrupted = messageText(model.requests[2]!.messages.at(-2)!);
    expect(secondInterrupted).toContain("Ability goto interrupted (on_fire)");
    expect(secondInterrupted).toContain("second partial movement completed");
    expect(secondInterrupted).not.toContain("low_air");
    expect(messageText(model.requests[2]!.messages.at(-1)!)).not.toContain("partial movement completed");
    const committedHistory = model.requests[3]!.messages.slice(0, -1).map(messageText).join("\n");
    expect(committedHistory).toContain("first partial movement completed");
    expect(committedHistory).toContain("second partial movement completed");
    expect(messageText(model.requests[3]!.messages.at(-1)!)).not.toContain("partial movement completed");
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "model_call_discarded")).toHaveLength(0);
    expect(journal.filter(e => e.type === "committed_tool_cycle")).toHaveLength(4);
  });

  it("ends the Harness when an interrupted Runtime task reports failed native cleanup", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ interruptAgentGotoWithLowAir: true });
    const start = vi.mocked(client.startToolCall).getMockImplementation()!;
    vi.mocked(client.startToolCall).mockImplementation((name, args) => {
      const task = start(name, args);
      return name === "goto" ? { ...task, result: task.result.then(result => ({ ...result,
        message: "task cancellation stop failed: native cleanup exception", data: { failure_type: "internal" } })) } : task;
    });
    const model = new ScriptedLanguageModel({ responses: [decision("move", "goto", { x: 8, z: 8 }), decision("unsafe-next-action", "goto", { x: 9, z: 9 })] });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: { ...config(directory), mode: "native" }, secrets: {},
      onLifecycleEvent: async () => {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "runtime_disconnected" });
    expect(model.requests).toHaveLength(1);
    expect(client.toolNames.filter(name => name === "goto")).toHaveLength(1);
    expect(await runEvents(directory)).toContainEqual(expect.objectContaining({ type: "failure", message: expect.stringContaining("native cleanup exception") }));
  });

  it("commits a Code Mode cycle interrupted mid-execution with the hazard reason and captured output", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient({ underwater: true });
    const hooks: Array<{ type: string; status?: string }> = [];
    const model = new ScriptedLanguageModel({ responses: [
      decision("dive", "run_code", { description: "Move deeper", code: "console.log('moving'); console.log('deeper');\nwhile (true) { await new Promise(resolve => setTimeout(resolve, 5)); }" }),
      decision("surface", "run_code", { description: "Surface for air", code: "const result = await abilities.surface({}); return result;" }),
      decision("end", "end_run", {}),
    ] });
    let hazardEmitted = false;
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: config(directory), secrets: {},
      onLifecycleEvent: async e => { hooks.push(e); },
      onProgress: e => {
        // Fire once the Programmatic Execution is running; the delay lets the
        // worker boot and the model's printed output reach the Harness first.
        if (!hazardEmitted && e.type === "programmatic_execution_started" && e.source === "agent") {
          hazardEmitted = true;
          setTimeout(() => client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ air: 60, underwater: true }) }), 300);
        }
      },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    expect(model.requests).toHaveLength(3);
    expect(hooks.filter(e => e.type === "harness_action_ended").map(e => e.status)).toEqual(["interrupted", "completed", "completed"]);
    // The committed tool result is protocol history (last message is the fresh context).
    const committed = messageText(model.requests[1]!.messages.at(-2)!);
    expect(committed).toContain("Programmatic Execution interrupted (low_air)");
    expect(committed).toContain("Captured output:");
    expect(committed).toContain("moving");
    expect(committed).toContain("deeper");
    expect(committed).not.toContain("on_fire");
    // The hazard reason was absorbed by the committed INTERRUPTED result, so
    // it does not reappear in trigger.hazard_reasons on the next context.
    const next = messageText(model.requests[1]!.messages.at(-1)!);
    expect(next).not.toContain('"low_air"');
    expect(preStepContext(next)).not.toHaveProperty("trigger");
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "model_call_discarded")).toHaveLength(0);
    expect(journal.filter(e => e.type === "committed_tool_cycle")).toHaveLength(3);
    expect(journal).toContainEqual(expect.objectContaining({ type: "outer_call_finished", outcome: "interrupted" }));
    expect(journal).toContainEqual(expect.objectContaining({ type: "hazard_action_interrupted", tool: "run_code", toolCallId: "dive" }));
    expect(journal).toContainEqual(expect.objectContaining({ type: "hazard_interruption", reasons: ["low_air"] }));
    expect(journal.every(e => e.version === 5)).toBe(true);
  });

  it("keeps a hazard fired after the abort out of the interrupted Code Mode result", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    let executionStarts = 0;
    const model = new ScriptedLanguageModel({ responses: [
      decision("first", "run_code", { description: "First move", code: "console.log('first progress');\nwhile (true) { await new Promise(resolve => setTimeout(resolve, 5)); }" }),
      decision("second", "run_code", { description: "Second move", code: "while (true) { await new Promise(resolve => setTimeout(resolve, 5)); }" }),
      decision("end", "end_run", {}),
    ] });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: config(directory), secrets: {},
      onProgress: e => {
        // Fire once the Programmatic Execution is running; the delay lets the
        // worker boot and the model's printed output reach the Harness first.
        if (e.type === "programmatic_execution_started" && e.source === "agent") {
          executionStarts += 1;
          const data = executionStarts === 1
            ? bodyState({ air: 80, underwater: true })
            : bodyState({ air: 80, underwater: true, on_fire: true });
          setTimeout(() => client.emitOccurrence({ type: "body_state_changed", sequence: executionStarts, server_tick: executionStarts, data }), 300);
        }
      },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    const firstCycle = messageText(model.requests[1]!.messages.at(-2)!);
    expect(firstCycle).toContain("Programmatic Execution interrupted (low_air)");
    expect(firstCycle).toContain("first progress");
    expect(firstCycle).not.toContain("on_fire");
    // on_fire arrived after the first abort, so the first snapshot cannot
    // carry it and the next context must not repeat it either: it interrupts
    // the second execution and rides only that committed INTERRUPTED result.
    const presented = messageText(model.requests[1]!.messages.at(-1)!);
    expect(preStepContext(presented)).not.toHaveProperty("trigger");
    const secondCycle = messageText(model.requests[2]!.messages.at(-2)!);
    expect(secondCycle).toContain("Programmatic Execution interrupted (on_fire)");
    expect(secondCycle).not.toContain("low_air");
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "model_call_discarded")).toHaveLength(0);
    expect(journal.filter(e => e.type === "committed_tool_cycle")).toHaveLength(3);
  });

  it("still discards a Code Mode cycle interrupted during the model request phase", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({ respond: async (_request, index, context) => {
      if (index === 0) {
        client.emitOccurrence({ type: "body_state_changed", sequence: 1, server_tick: 1, data: bodyState({ air: 80, underwater: true }) });
        await new Promise<void>((_resolve, reject) => {
          if (context.signal?.aborted) reject(context.signal.reason);
          else context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        });
      }
      return decision("end", "end_run", {});
    } });
    const result = await runHarness({ agentContext: staticGoalContext("Choose response"), config: config(directory), secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)), languageModel: model, modelLimits: model.limits });
    expect(result).toMatchObject({ endReason: "external_stop" });
    const journal = await runEvents(directory);
    expect(journal.filter(e => e.type === "model_call_discarded")).toHaveLength(1);
    expect(journal.some(e => e.type === "hazard_action_interrupted")).toBe(false);
    expect(journal.filter(e => e.type === "committed_tool_cycle")).toHaveLength(1);
    // The discarded request phase leaves the hazard reason without an
    // interrupted Tool result, so the next context carries it in
    // trigger.hazard_reasons.
    expect(preStepContext(messageText(model.requests[1]!.messages.at(-1)!))).toMatchObject({
      trigger: { hazard_reasons: ["low_air"] },
    });
  });

  it("rejects the legacy OpenAI-compatible model shape before Runtime setup", async () => {
    const directory = await temporaryDirectory(directories);
    const createRuntimeSession = vi.fn(async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())));

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: {
        ...config(directory),
        model: { baseUrl: "https://api.openai.com/v1", model: "gpt-test" },
      },
      secrets: { modelApiKey: "test" },
      createRuntimeSession,
    });

    expect(result).toEqual({
      status: "setup_failure",
      failure: expect.objectContaining({ code: "CONFIG_INVALID" }),
    });
    expect(createRuntimeSession).not.toHaveBeenCalled();
  });

  it("durably records external assertions for an operator run", async () => {
    const directory = await temporaryDirectory(directories);
    const result = await runHarness({
      agentContext: { revision: 0, assertions: [{ id: "assignment", text: "Use the exact operator task." }] },
      config: { ...config(directory), mode: "native" },
      secrets: { runtimeBearerToken: "runtime" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      operator: { choose: async () => ({ toolName: "wait", input: { seconds: 0 } }) },
      hazardDecisions: "disabled",
      decisionCycleLimit: 1,
    });

    expect(result).toMatchObject({ status: "completed", endReason: "tracer_complete" });
    const events = await runEvents(directory);
    expect(events).toContainEqual(expect.objectContaining({
      type: "run_started",
      agentContext: { revision: 0, assertions: [{ id: "assignment", text: "Use the exact operator task." }] },
    }));
  });

  it("runs an injected model without a duplicate provider credential", async () => {
    const directory = await temporaryDirectory(directories);
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [decision("end", "end_run", {})],
    });

    const result = await runHarness({
      agentContext: staticGoalContext("Use the injected model."),
      config: config(directory),
      secrets: { runtimeBearerToken: "runtime" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: model,
      modelLimits: model.limits,
      hazardDecisions: "disabled",
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
  });

  it.each([
    ["missing limits", { provider: "openai", model: "gpt-test" }],
    ["non-positive context limit", {
      provider: "openai", model: "gpt-test", limits: { contextWindowTokens: 0, maxOutputTokens: 1 },
    }],
    ["non-positive output limit", {
      provider: "openai", model: "gpt-test", limits: { contextWindowTokens: 8, maxOutputTokens: 0 },
    }],
    ["output limit equal to context limit", {
      provider: "openai", model: "gpt-test", limits: { contextWindowTokens: 8, maxOutputTokens: 8 },
    }],
  ])("rejects %s before Runtime setup", async (_case, model) => {
    const directory = await temporaryDirectory(directories);
    const createRuntimeSession = vi.fn(async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())));

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(directory), model },
      secrets: { modelApiKey: "test" },
      createRuntimeSession,
    });

    expect(result).toMatchObject({ status: "setup_failure", failure: { code: "CONFIG_INVALID" } });
    expect(createRuntimeSession).not.toHaveBeenCalled();
  });

  it("lets the AI SDK retry one transient OpenAI transport failure", async () => {
    const directory = await temporaryDirectory(directories);
    const transport = createOpenAiTestTransport([
      { error: { statusCode: 503, code: "service_unavailable", message: "temporarily unavailable" } },
      { toolCalls: [{ id: "finish", name: "update_plan", input: { items: [] } }] },
    ]);

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: transport.model,
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
      hazardDecisions: "disabled",
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(transport.requests).toHaveLength(2);
  });

  it("returns schema-invalid JSON as an ordinary Tool Result and recovers on the next turn", async () => {
    const directory = await temporaryDirectory(directories);
    const transport = createDeepSeekTestTransport([
      { toolCalls: [{ id: "invalid-wait", name: "wait", arguments: '{"seconds":"soon"}' }] },
      { toolCalls: [{ id: "finish", name: "update_plan", arguments: "{\"items\":[]}" }] },
    ]);

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: {
        ...config(directory),
        mode: "native",
        model: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
        },
      },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: transport.model,
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
      hazardDecisions: "disabled",
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "invalid-wait" }),
    ]));
    const toolMessage = (transport.requests[1]?.messages as readonly Readonly<Record<string, unknown>>[])
      .find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("wait input.seconds must be a finite number");
  });

  it("reports a provider failure after a second OpenAI-compatible overflow", async () => {
    const directory = await temporaryDirectory(directories);
    const transport = createOpenAiCompatibleTestTransport([
      { toolCalls: [{ id: "wait-once", name: "wait", input: { seconds: 0 } }] },
      { toolCalls: [{ id: "wait-twice", name: "wait", input: { seconds: 0 } }] },
      { error: { statusCode: 400, code: "context_length_exceeded", message: "maximum context length exceeded" } },
      { error: { statusCode: 400, code: "context_length_exceeded", message: "maximum context length exceeded" } },
    ], { name: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1" });
    const model = compatibleConfig(directory).model;

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...compatibleConfig(directory), mode: "native" },
      secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: transport.model,
      modelLimits: model.limits,
      hazardDecisions: "disabled",
    });

    expect(result).toMatchObject({ status: "ended", endReason: "model_transport_error" });
  });

  it.each([
    ["transport failure", {
      error: { statusCode: 503, code: "service_unavailable", message: "DeepSeek is unavailable" },
    }, "model_transport_error"],
  ] as const)("keeps DeepSeek %s in the common Harness classification", async (_case, fixture, endReason) => {
    const directory = await temporaryDirectory(directories);
    const transport = createDeepSeekTestTransport([fixture]);

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: {
        ...config(directory),
        mode: "native",
        model: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
        },
      },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: transport.model,
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
      hazardDecisions: "disabled",
    });

    expect(result).toMatchObject({ status: "ended", endReason });
  });
  it("resolves the configured Bot, renders the first Turn Observation, and ends by script", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [decision("end", "end_run", {})],
    });
    const contexts: Array<Extract<Parameters<NonNullable<Parameters<typeof runHarness>[0]["onProgress"]>>[0], {
      type: "decision_context";
    }>> = [];

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress: (event) => {
        if (event.type === "decision_context") contexts.push(event);
      },
    });

    if (result.status === "setup_failure") throw new Error(result.failure.message);
    expect(result).toMatchObject({
      status: "ended",
      endReason: "external_stop",
      ready: { username: "HarnessBot", lifecycle: "alive" },
    });
    expect(client.ensureBot).toHaveBeenCalledWith("HarnessBot");
    expect(client.blockRegion).toHaveBeenCalledWith(
      "minecraft:overworld",
      { x: -4, y: 60, z: -4 },
      { x: 4, y: 68, z: 4 },
    );
    expect(contexts).toHaveLength(1);
    const observation = contexts[0]!.sections.find((section) => section.title === "Turn Observation");
    expect(observation?.body).toContain("SELF\ndimension=minecraft:overworld");
    expect(observation?.body).toContain("PERCEIVED_BLOCKS");
    expect(observation?.body).toContain("PERCEIVED_ENTITIES");
    expect(observation?.body).not.toMatch(/velocity|fall_distance/u);
  });

  it.each([
    ["native", "observe_self", '{}'],
    ["code", "run_code", '{"description":"Explicitly observe current body state","code":"return await abilities.observe_self({});"}'],
  ] as const)("sends only the current automatic observation across three DeepSeek Tool Cycles in %s Mode", async (
    mode,
    tool,
    argumentsJson,
  ) => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const skillRoot = await temporaryDirectory(directories);
    const skillContent = '<turn_observation>Skill examples remain history.</turn_observation>\n{"turn_observation":"explicit guide content"}';
    await mkdir(join(skillRoot, "observation_guide"));
    await writeFile(join(skillRoot, "observation_guide", "SKILL.md"), [
      "---", "schema_version: 1", "name: observation_guide", "description: Explain explicit observations.", "---", skillContent,
    ].join("\n"));
    const contexts: Array<Record<string, unknown>> = [];
    const transport = createDeepSeekTestTransport([
      {
        reasoning: "I will complete the first Tool Cycle before ending the Harness Run.",
        toolCalls: [
          { id: "first", name: tool, arguments: argumentsJson },
          { id: "discarded", name: "update_plan", arguments: "{\"items\":[]}" },
        ],
      },
      { reasoning: "Keep the explicit observation and load the guide.",
        toolCalls: [{ id: "guide", name: "load_skill", arguments: '{"name":"observation_guide"}' }] },
      { toolCalls: [{ id: "finish", name: "update_plan", arguments: "{\"items\":[]}" }] },
    ]);

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: {
        ...config(directory),
        mode,
        model: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
        },
      },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: transport.model,
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
      projectSkillSnapshotBuilder: createProjectSkillSnapshotBuilder({ sourceRoot: skillRoot }),
      hazardDecisions: "disabled",
      onProgress: (event) => {
        if (event.type !== "decision_context") return;
        contexts.push(preStepContext(event.wireText));
        client.setBody({ air: 300 - event.cycle, underwater: false });
      },
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(transport.requests).toHaveLength(3);
    expect(new Set(contexts.map(context => context.turn_observation)).size).toBe(3);
    for (const [index, request] of transport.requests.entries()) {
      const messages = request.messages as readonly Readonly<{ role: string; content?: string }>[];
      const sentContexts = messages.filter(message => message.role === "user")
        .map(message => preStepContext(message.content!));
      expect(sentContexts).toHaveLength(index + 1);
      expect(sentContexts.filter(context => Object.hasOwn(context, "turn_observation"))).toEqual([contexts[index]]);
      expect(sentContexts.slice(0, -1)).toEqual(contexts.slice(0, index).map(({ turn_observation: _observation, ...history }) => history));
    }
    expect(transport.requests[0]).toMatchObject({ max_tokens: 512 });
    const continuationMessages = transport.requests[2]?.messages as readonly Readonly<Record<string, unknown>>[];
    const assistant = continuationMessages.find((message) => message.role === "assistant") as Readonly<{
      reasoning_content?: string;
      tool_calls?: readonly Readonly<{ id: string; function: Readonly<{ name: string; arguments: string }> }>[];
    }>;
    const retained = assistant.tool_calls?.find((call) => call.id === "first");
    expect(assistant.reasoning_content).toBe("I will complete the first Tool Cycle before ending the Harness Run.");
    expect(retained?.function.name).toBe(tool);
    expect(JSON.parse(retained!.function.arguments)).toEqual(JSON.parse(argumentsJson));
    expect(continuationMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "first" }),
      expect.objectContaining({ role: "assistant", reasoning_content: "Keep the explicit observation and load the guide.",
        tool_calls: [expect.objectContaining({ id: "guide", function: expect.objectContaining({ name: "load_skill" }) })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "guide" }),
    ]));
    const explicitObservation = continuationMessages.find(message => message.role === "tool" && message.tool_call_id === "first");
    expect(JSON.parse(String(explicitObservation?.content)).data.air).toBe("299/300");
    const guide = continuationMessages.find(message => message.role === "tool" && message.tool_call_id === "guide");
    expect(JSON.parse(String(guide?.content)).data.content).toBe(skillContent);
    expect(continuationMessages.at(-1)).toEqual(expect.objectContaining({
      role: "user",
      content: expect.stringContaining("minecraft_pre_step_context"),
    }));
    expect(JSON.stringify(transport.requests[2])).not.toContain("discarded");
    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.every((event) => event.version === 5)).toBe(true);
    expect(events.filter((event) => ["model_surface_message", "model_request", "model_response"].includes(
      event.type as string,
    ))).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ version: 5, type: "model_call_finished" }));
    expect(events.filter((event) => event.type === "committed_tool_cycle")).toEqual([
      expect.objectContaining({ version: 5, toolCallId: "first" }),
      expect.objectContaining({ version: 5, toolCallId: "guide" }),
      expect.objectContaining({ version: 5, toolCallId: "finish" }),
    ]);
    expect(events.filter((event) => event.type === "model_call_finished")).toEqual([
      expect.objectContaining({ usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }),
      expect.objectContaining({ usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }),
      expect.objectContaining({ usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }),
    ]);
    expect(events.filter(event => event.type === "observation").map(event => event.rendered))
      .toEqual(contexts.map(context => context.turn_observation));
    for (const type of ["model_call_finished", "committed_tool_cycle"]) {
      expect(events.filter(event => event.type === type).map(event =>
        preStepContext((event.decisionContext as { content: string }).content),
      )).toEqual(contexts);
    }
  });

  it.each([
    ["native", "wait", { seconds: 0 }],
    ["code", "run_code", {
      description: "Return one verified program result",
      code: "return { ok: true };",
    }],
  ] as const)("runs %s Mode through the configured OpenAI AI SDK model path", async (mode, tool, input) => {
    const directory = await temporaryDirectory(directories);
    const transport = createOpenAiTestTransport([
      { toolCalls: [{ id: "first", name: tool, input }] },
      { toolCalls: [{ id: "finish", name: "update_plan", input: { items: [] } }] },
    ]);

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(directory), mode },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: transport.model,
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
      hazardDecisions: "disabled",
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]).toMatchObject({
      model: "gpt-test",
      max_output_tokens: 512,
      store: false,
      tools: expect.arrayContaining([expect.objectContaining({ type: "function" })]),
    });
    expect(transport.requests[1]).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "first", name: tool }),
        expect.objectContaining({ type: "function_call_output", call_id: "first" }),
      ]),
    });
    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({
      type: "model_call_finished",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    }));
  });

  it.each([
    ["native", "wait", { seconds: 0 }],
    ["code", "run_code", {
      description: "Return one verified program result",
      code: "return { ok: true };",
    }],
  ] as const)("runs %s Mode through the configured OpenAI-compatible AI SDK model path", async (mode, tool, input) => {
    const directory = await temporaryDirectory(directories);
    const transport = createOpenAiCompatibleTestTransport([
      { toolCalls: [{ id: "first", name: tool, input }] },
      { toolCalls: [{ id: "finish", name: "update_plan", input: { items: [] } }] },
    ], { name: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "compatible-secret" });

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...compatibleConfig(directory), mode },
      secrets: { modelApiKey: "compatible-secret" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: transport.model,
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
      hazardDecisions: "disabled",
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(transport.urls).toEqual([
      "http://127.0.0.1:8000/v1/chat/completions",
      "http://127.0.0.1:8000/v1/chat/completions",
    ]);
    expect(transport.authorizationHeaders).toEqual(["Bearer compatible-secret", "Bearer compatible-secret"]);
    expect(transport.requests[0]).toMatchObject({
      model: "compatible-test",
      max_tokens: 512,
      tools: expect.arrayContaining([expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: tool,
          parameters: expect.objectContaining({ type: "object" }),
        }),
      })]),
    });
    expect(transport.requests[1]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "assistant", tool_calls: expect.arrayContaining([
          expect.objectContaining({ id: "first", function: expect.objectContaining({ name: tool }) }),
        ]) }),
        expect.objectContaining({ role: "tool", tool_call_id: "first" }),
      ]),
    });
    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({
      type: "model_call_finished",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    }));
  });

  it("propagates Harness Run cancellation to an unauthenticated OpenAI-compatible HTTP request", async () => {
    const directory = await temporaryDirectory(directories);
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let beginRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => { beginRequest = resolve; });
    const provider = createOpenAICompatible({
      name: "local-vllm",
      baseURL: "http://127.0.0.1:8000/v1",
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        beginRequest();
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      }),
    });

    const running = runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: compatibleConfig(directory),
      secrets: {},
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: provider.chatModel("compatible-test"),
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
      signal: controller.signal,
    });
    await requestStarted;
    controller.abort(new Error("test cancellation"));
    await running;

    expect(requestSignal?.aborted).toBe(true);
  });

  it("propagates Harness Run cancellation to the OpenAI AI SDK HTTP request", async () => {
    const directory = await temporaryDirectory(directories);
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let beginRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => { beginRequest = resolve; });
    const model = createOpenAI({
      apiKey: "test-key",
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        beginRequest();
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      }),
    }).chat("gpt-test");

    const running = runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: model,
      modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
      signal: controller.signal,
    });
    await requestStarted;
    controller.abort(new Error("test cancellation"));
    await running;

    expect(requestSignal?.aborted).toBe(true);
  });

  it("isolates Ability progress between concurrent Harness Runs", async () => {
    const leftDirectory = await temporaryDirectory(directories);
    const rightDirectory = await temporaryDirectory(directories);
    let releaseWaits!: () => void;
    const waitsReleased = new Promise<void>((resolve) => { releaseWaits = resolve; });
    let waitingRuns = 0;
    const wait = async () => {
      waitingRuns += 1;
      if (waitingRuns === 2) releaseWaits();
      await waitsReleased;
    };
    const abilityRoots = [new Set<string>(), new Set<string>()];
    const leftModel = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [decision("wait", "wait", { seconds: 0 }), decision("end", "end_run", {})],
    });
    const rightModel = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [
        decision("wait", "run_code", {
          description: "Wait once through the generated Ability SDK",
          code: "await abilities.wait({ seconds: 0 }); return { ok: true };",
        }),
        decision("end", "end_run", {}),
      ],
    });
    const run = async (
      index: number,
      directory: string,
      mode: "native" | "code",
      model: ScriptedLanguageModel,
    ) => await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(directory), mode },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: model,
      modelLimits: model.limits,
      hazardDecisions: "disabled",
      wait,
      onProgress: (event) => {
        if (event.type === "ability_call_started" && event.ability === "wait") {
          abilityRoots[index]!.add(event.rootId);
        }
      },
    });

    const [left, right] = await Promise.all([
      run(0, leftDirectory, "native", leftModel),
      run(1, rightDirectory, "code", rightModel),
    ]);

    expect(left).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(right).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect([...abilityRoots[0]!]).toHaveLength(1);
    expect([...abilityRoots[1]!]).toHaveLength(1);
    expect([...abilityRoots[0]!][0]).not.toBe([...abilityRoots[1]!][0]);
    expect(leftModel.requests[0]?.tools.map((tool) => tool.name)).toContain("wait");
    expect(leftModel.requests[0]?.tools.map((tool) => tool.name)).not.toContain("run_code");
    const codeContract = messageText(rightModel.requests[0]!.messages[0]!);
    expect(codeContract).toContain("readonly wait:");
    expect(codeContract).not.toContain("readonly run_code:");
  });

  it("continues with the retained first Tool call when the provider returned several", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [{
        ...decision("end", "end_run", {}),
        serialToolCallReduction: { received: 2, retained: "end" },
      }],
    });

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
  });

  it("publishes the model-visible run_code output to the live transcript seam", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [
        decision("code", "run_code", {
          description: "Print one query result",
          code: "console.log('query result'); return { ok: true };",
        }),
        decision("end", "end_run", {}),
      ],
    });
    let finished: Extract<Parameters<NonNullable<Parameters<typeof runHarness>[0]["onProgress"]>>[0], {
      type: "outer_call_finished";
    }> | undefined;

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress: (event) => {
        if (event.type === "outer_call_finished" && event.tool === "run_code") {
          finished = event;
        }
      },
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(finished).toMatchObject({
      outcome: "ok",
      result: {
        ok: true,
        result: { logs: ["query result\n"], result: { ok: true } },
        programmatic: {
          rootId: expect.any(String),
          executionId: expect.any(String),
          logs: [{ stream: "stdout", text: "query result\n" }],
        },
      },
      modelContent: 'query result\n{\n  "ok": true\n}',
    });
    expect((finished?.result as { result?: Record<string, unknown> }).result).not.toHaveProperty("rootId");

    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const recorded = events.find((event) => event.type === "outer_call_finished" && event.tool === "run_code");
    expect(recorded).toMatchObject({
      result: {
        ok: true,
        result: { logs: ["query result\n"], result: { ok: true } },
        programmatic: {
          rootId: expect.any(String),
          executionId: expect.any(String),
        },
      },
    });
    expect(recorded).not.toHaveProperty("modelContent");
  });

  it("projects Programmatic Execution progress before requiring an Ability name", async () => {
    const directory = await temporaryDirectory(directories);
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [
        decision("code", "run_code", {
          description: "Wait through one Programmatic Execution child",
          code: "return await abilities.wait({ seconds: 0 });",
        }),
        decision("end", "end_run", {}),
      ],
    });
    const progress: Array<Record<string, unknown>> = [];

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: model,
      modelLimits: model.limits,
      onProgress: (event) => { progress.push({ ...event }); },
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    const started = progress.find((event) => event.type === "programmatic_execution_started");
    expect(started).toBeDefined();
    const execution = progress.filter((event) => event.rootId === started?.rootId && (
      event.type === "programmatic_execution_started"
      || event.type === "ability_call_started"
      || event.type === "ability_call_finished"
      || event.type === "programmatic_execution_finished"
    ));
    expect(execution).toMatchObject([
      {
        type: "programmatic_execution_started",
        rootId: expect.any(String),
        executionId: expect.any(String),
        depth: 1,
      },
      {
        type: "ability_call_started",
        rootId: expect.any(String),
        executionId: expect.any(String),
        parentExecutionId: expect.any(String),
        ability: "wait",
        depth: 2,
      },
      {
        type: "ability_call_finished",
        rootId: expect.any(String),
        executionId: expect.any(String),
        ability: "wait",
      },
      {
        type: "programmatic_execution_finished",
        rootId: expect.any(String),
        executionId: expect.any(String),
        outcome: "succeeded",
      },
    ]);
    expect(execution[1]?.parentExecutionId).toBe(execution[0]?.executionId);
    expect(execution[3]?.executionId).toBe(execution[0]?.executionId);
  });

  it("exposes Skill and Plan controls beside run_code in Code Mode and records Skill trace", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [
        decision("load", "load_skill", { name: "smelt_craft" }),
        decision("end", "end_run", {}),
      ],
    });
    const contexts: number[] = [];
    let skillFinished: Record<string, unknown> | undefined;

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress: (event) => {
        if (event.type === "decision_context") contexts.push(event.cycle);
        if (event.type === "outer_call_finished" && event.tool === "load_skill") skillFinished = event;
      },
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "run_code", "load_skill", "update_plan",
    ]);
    expect(contexts).toEqual([1, 2]);
    expect(skillFinished).toMatchObject({
      result: {
        ok: true,
        result: { ok: true, data: { name: "smelt_craft", file: "SKILL.md" } },
        runtimeTrace: { project_skill: { name: "smelt_craft", file: "SKILL.md" } },
      },
      modelContent: expect.stringContaining('"name":"smelt_craft"'),
    });
    const runDirectories = await readdir(directory);
    const events = (await readFile(join(directory, runDirectories[0]!, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.find((event) => event.type === "outer_call_finished" && event.tool === "load_skill"))
      .toMatchObject({
      tool: "load_skill",
      outcome: "ok",
      result: {
        ok: true,
        result: { ok: true, data: { name: "smelt_craft", file: "SKILL.md" } },
        runtimeTrace: { project_skill: { name: "smelt_craft", file: "SKILL.md" } },
      },
    });
  });

  it("exposes Plan and Skill controls beside Abilities in Native Mode and replaces the Plan", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [
        decision("plan", "update_plan", {
          items: [{ id: "mine", content: "Mine three iron ore", status: "in_progress" }],
        }),
        decision("end", "end_run", {}),
      ],
    });
    let planFinished: Record<string, unknown> | undefined;

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(directory), mode: "native" },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress: (event) => {
        if (event.type === "outer_call_finished" && event.toolCallId === "plan") planFinished = event;
      },
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    const nativeTools = model.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(nativeTools).toContain("wait");
    expect(nativeTools.slice(-2)).toEqual(["load_skill", "update_plan"]);
    expect(nativeTools).not.toContain("run_code");
    expect(planFinished).toMatchObject({
      result: {
        ok: true,
        result: {
          revision: 1,
          items: [{ id: "mine", content: "Mine three iron ore", status: "in_progress" }],
        },
      },
      modelContent: JSON.stringify({
        revision: 1,
        items: [{ id: "mine", content: "Mine three iron ore", status: "in_progress" }],
      }),
    });
    const nextMessage = model.requests[1]?.messages.at(-1);
    const nextTurn = nextMessage === undefined ? "" : messageText(nextMessage);
    expect(nextTurn).toContain('"revision":1');
    expect(nextTurn).toContain('"id":"mine"');
  });

  it("records failed Control Tool cycles and follows each with fresh Turn Observation", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [
        decision("missing", "load_skill", { name: "missing_skill" }),
        decision("invalid", "update_plan", {
          items: [{ id: "later", content: "Unfocused work", status: "pending" }],
        }),
        decision("end", "end_run", {}),
      ],
    });
    const contexts: number[] = [];
    const finished: Array<{ tool: string; outcome: string; result?: unknown }> = [];

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress: (event) => {
        if (event.type === "decision_context") contexts.push(event.cycle);
        if (event.type === "outer_call_finished") finished.push({ tool: event.tool, outcome: event.outcome, result: event.result });
      },
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(finished.slice(0, 2)).toEqual([
      expect.objectContaining({
        tool: "load_skill",
        outcome: "error",
        result: expect.objectContaining({
          result: expect.objectContaining({
            data: { available_names: expect.arrayContaining(["smelt_craft"]) },
          }),
        }),
      }),
      expect.objectContaining({ tool: "update_plan", outcome: "error" }),
    ]);
    expect(contexts).toEqual([1, 2, 3]);
    expect(model.requests).toHaveLength(3);
  });

  it("shows the operator exactly the Decision Request the model is about to receive", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [
        decision("code", "run_code", {
          description: "Return one result",
          code: "return { ok: true };",
        }),
        decision("end", "end_run", {}),
      ],
    });
    type ContextEvent = Extract<Parameters<NonNullable<Parameters<typeof runHarness>[0]["onProgress"]>>[0], {
      type: "decision_context";
    }>;
    let contracts = 0;
    const contexts: Array<{ event: ContextEvent; modelCallsSoFar: number }> = [];

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress: (event) => {
        if (event.type === "operating_contract") contracts += 1;
        if (event.type === "decision_context") {
          contexts.push({ event, modelCallsSoFar: model.requests.length });
        }
      },
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(contracts).toBe(1);
    expect(contexts.map((entry) => entry.modelCallsSoFar)).toEqual([0, 1]);
    expect(contexts[0]!.event.wireText)
      .toBe(messageText(model.requests[0]!.messages.at(-1)!));
    expect(messageText(model.requests[1]!.messages.at(-1)!))
      .toContain(contexts[1]!.event.wireText);
    for (const entry of contexts) {
      const payload = JSON.parse(
        entry.event.wireText.match(/\n(\{.*\})\n<\/minecraft_pre_step_context>/su)?.[1] ?? "null",
      ) as { turn_observation: string };
      const observation = entry.event.sections.find((section) => section.title === "Turn Observation");
      expect(payload.turn_observation).toBe(observation!.body);
    }
  });

  it("projects navigation_policy as separate bounded user-role context in every Decision Request", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [decision("end", "end_run", {})],
    });

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    const contextMessage = model.requests[0]?.messages.at(-1);
    expect(contextMessage?.role).toBe("user");
    const rendered = contextMessage === undefined ? "" : messageText(contextMessage);
    const context = JSON.parse(
      rendered.match(/\n(\{.*\})\n<\/minecraft_pre_step_context>/su)?.[1] ?? "null",
    ) as {
      navigation_policy: Record<string, unknown>;
      turn_observation: string;
    };
    expect(context.navigation_policy).toEqual({
      action: "read",
      item_id_globs: ["minecraft:*dirt"],
      effective_item_count: 3,
      effective_item_sample: ["minecraft:dirt", "minecraft:coarse_dirt", "minecraft:rooted_dirt"],
      carried_matching_items: [{ item_id: "minecraft:dirt", count: 12 }],
    });
    expect(context.turn_observation).not.toContain("navigation_policy");
    expect(rendered).not.toMatch(/world_fact/u);
    expect(client.toolNames.filter((name) => name === "manage_scaffold_materials")).toEqual([
      "manage_scaffold_materials",
    ]);
  });


  it("retains every Turn Observation in the Harness Run Event Log", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new ScriptedLanguageModel({
      limits: { contextWindowTokens: 200_000 },
      responses: [
        decision("code", "run_code", {
          description: "Return one result",
          code: "return { ok: true };",
        }),
        decision("end", "end_run", {}),
      ],
    });

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    const runDirectories = await readdir(directory);
    expect(runDirectories).toHaveLength(1);
    const events = (await readFile(join(directory, runDirectories[0]!, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "observation")).toHaveLength(2);
  });






  it("keeps unmatched damage informational without preempting the current Model Request", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new OccurrenceThenDecisionModel(() => {
      client.emitOccurrence({
        type: "damage_received", sequence: 1, server_tick: 20, data: { amount: 1, health: 19, max_health: 20, damage_type: "minecraft:generic" },
      });
    }, decision("end", "end_run", {}));

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(directory), mode: "native" },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(model.requests).toHaveLength(1);
    const events = await runEvents(directory);
    expect(events).toContainEqual(expect.objectContaining({
      type: "runtime_occurrence",
      occurrence: expect.objectContaining({ type: "damage_received" }),
    }));
    expect(events.filter((event) => event.type === "hazard_detected")).toEqual([]);
  });



  it("does not preempt a Model Request for an ineligible normal body state change", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new OccurrenceThenDecisionModel(() => {
      client.emitOccurrence({
        type: "body_state_changed", sequence: 1, server_tick: 20,
        data: bodyState({ air: 300, underwater: false }),
      });
    }, decision("end", "end_run", {}));

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(model.requests).toHaveLength(1);
  });

  it("bounds and coalesces Runtime Occurrences carried into the next Turn", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new OccurrenceThenDecisionModel(() => {
      for (let sequence = 1; sequence <= 100; sequence += 1) {
        client.emitOccurrence({
          type: "actor_lifecycle_changed", sequence, server_tick: sequence,
          data: { lifecycle_state: sequence % 2 === 0 ? "alive" : "dead" },
        });
      }
    }, decision("wait", "wait", { seconds: 0 }), decision("end", "end_run", {}));

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(directory), mode: "native" },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    const nextMessage = model.requests[1]?.messages.at(-1);
    const nextTurn = nextMessage === undefined ? "" : messageText(nextMessage);
    const context = JSON.parse(nextTurn.match(/\n(\{.*\})\n<\/minecraft_pre_step_context>/su)?.[1] ?? "null") as {
      runtime_occurrences: Array<{ sequence: number }>;
    };
    expect(context.runtime_occurrences).toHaveLength(64);
    expect(context.runtime_occurrences[0]?.sequence).toBe(37);
    expect(context.runtime_occurrences.at(-1)?.sequence).toBe(100);
  });

  it("keeps hazard decisions disabled when explicitly requested", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new OccurrenceThenDecisionModel(() => {
      client.emitOccurrence({
        type: "damage_received", sequence: 1, server_tick: 20, data: { amount: 1, health: 19, max_health: 20, damage_type: "minecraft:generic" },
      });
    }, decision("wait", "wait", { seconds: 0 }), decision("end", "end_run", {}));

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(directory), mode: "native" },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      hazardDecisions: "disabled",
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
    expect(model.requests).toHaveLength(2);
    const runDirectories = await readdir(directory);
    const events = (await readFile(join(directory, runDirectories[0]!, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type.startsWith("hazard_"))).toEqual([]);
  });

  it("runs operator selections through the public Harness Run seam without model events", async () => {
    const directory = await temporaryDirectory(directories);
    const selections = [
      { toolName: "wait", input: { seconds: 0 } },
      { toolName: "wait", input: { seconds: 0 } },
    ];
    const choose = vi.fn<OperatorInteraction["choose"]>(async () => selections.shift()!);

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(directory), mode: "native" },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      operator: { choose },
      hazardDecisions: "disabled",
      decisionCycleLimit: 2,
    });

    expect(result).toMatchObject({ status: "completed", endReason: "tracer_complete" });
    expect(choose).toHaveBeenCalledTimes(2);
    expect(choose.mock.calls[0]?.[0]).toMatchObject({
      observation: expect.any(String),
      tools: expect.arrayContaining([expect.objectContaining({ name: "wait" })]),
    });
    const operatorToolNames = choose.mock.calls[0]?.[0].tools.map((tool) => tool.name) ?? [];
    for (const control of ["run_code", "load_skill", "update_plan", "end_run"]) {
      expect(operatorToolNames).not.toContain(control);
    }
    expect(choose.mock.calls[1]?.[0].previousResult).toEqual(expect.any(String));

    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({
      type: "operator_selection",
      provenance: "operator",
      tool: "wait",
      input: { seconds: 0 },
    }));
    expect(events.filter((event) => /^(model_|history_compaction|token_)/u.test(event.type as string))).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('"role":"assistant"');
    expect(events.filter((event) => event.type === "outer_call_started")).toHaveLength(2);
    expect(events.filter((event) => event.type === "outer_call_finished")).toHaveLength(2);
    // One observation before each selection.
    expect(events.filter((event) => event.type === "observation")).toHaveLength(2);
  });

  it("ends a pending operator choice on external stop or Runtime disconnect", async () => {
    const externalDirectory = await temporaryDirectory(directories);
    const externalStop = new AbortController();
    let selected!: () => void;
    const selectionStarted = new Promise<void>((resolve) => { selected = resolve; });
    const waitForAbort: OperatorInteraction["choose"] = async (_turn, options) => await new Promise((_, reject) => {
      selected();
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
    const externalRun = runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(externalDirectory), mode: "native" },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      operator: { choose: waitForAbort },
      signal: externalStop.signal,
    });
    await selectionStarted;
    externalStop.abort(new Error("operator interrupted"));
    await expect(externalRun).resolves.toMatchObject({ status: "ended", endReason: "external_stop" });

    const disconnectDirectory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    let disconnectSelected!: () => void;
    const disconnectSelectionStarted = new Promise<void>((resolve) => { disconnectSelected = resolve; });
    const disconnectRun = runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: { ...config(disconnectDirectory), mode: "native" },
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      operator: { choose: async (_turn, options) => await new Promise((_, reject) => {
        disconnectSelected();
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }) },
    });
    await disconnectSelectionStarted;
    client.emitDisconnect(new Error("Runtime socket closed"));
    await expect(disconnectRun).resolves.toMatchObject({ status: "ended", endReason: "runtime_disconnected" });
  });


  it("ends with runtime_disconnected when the Runtime SDK disconnects", async () => {
    const directory = await temporaryDirectory(directories);
    const client = fakeRuntimeClient();
    const model = new PreemptedModel(() => {
      client.emitDisconnect(new Error("Runtime socket closed"));
      client.emitDisconnect(new Error("Runtime socket error after close"));
    });

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
    });

    expect(result).toMatchObject({ status: "ended", endReason: "runtime_disconnected" });
  });

  it("treats an aborted in-flight Model request as an external stop", async () => {
    const directory = await temporaryDirectory(directories);
    const controller = new AbortController();
    const model = new PreemptedModel(() => { controller.abort(new Error("operator interrupted")); });

    const result = await runHarness({
      agentContext: staticGoalContext("Complete the Harness test."),
      config: config(directory),
      secrets: { modelApiKey: "test" },
      createRuntimeSession: async () => ownedRuntimeSession(new RuntimeAdapter(fakeRuntimeClient())),
      languageModel: model,
      modelLimits: model.limits,
      hazardDecisions: "disabled",
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: "ended", endReason: "external_stop" });
  });
});

class PreemptedModel extends ScriptedLanguageModel {
  public constructor(preempt: () => void, onAbort?: () => void) {
    super({ respond: async (_request, index, context) => {
      if (index === 1) return decision("end", "end_run", {});
      queueMicrotask(preempt);
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { onAbort?.(); reject(context.signal?.reason ?? new Error("preempted")); };
        if (context.signal?.aborted === true) abort();
        else context.signal?.addEventListener("abort", abort, { once: true });
      });
      throw new Error("preempted Model Request unexpectedly resumed");
    } });
  }
}

class OccurrenceThenDecisionModel extends ScriptedLanguageModel {
  public constructor(emit: () => void, ...decisions: ScriptedDecision[]) {
    super({ respond: (_request, index) => {
      if (index === 0) emit();
      const next = decisions[index];
      if (next === undefined) throw new Error("missing scripted decision");
      return next;
    } });
  }
}

function fakeRuntimeClient(options: Readonly<{
  profile?: "grounded_evidence" | "loaded_world_state";
  air?: number;
  underwater?: boolean;
  suffocating?: boolean;
  interruptAgentGotoWithLowAir?: boolean;
  gotoOutcomes?: readonly ("success" | "failed" | "interrupted" | "invalid")[];
  gotoGate?: Promise<void>;
  onGotoStarted?: (attempt: number) => void;
}> = {}) {
  const occurrenceListeners = new Set<(occurrence: Parameters<RuntimeSdkClient["onOccurrence"]>[0] extends (value: infer T) => void ? T : never) => void>();
  const disconnectListeners = new Set<(error: Error) => void>();
  let pendingGoto: ((value: { success: false; message: string; interrupted: true }) => void) | undefined;
  let air = options.air ?? 300;
  let underwater = options.underwater ?? false;
  let suffocating = options.suffocating ?? false;
  let gotoAttempt = 0;
  const toolNames: string[] = [];
  const client: RuntimeSdkClient & {
    emitOccurrence(occurrence: Parameters<RuntimeSdkClient["onOccurrence"]>[0] extends (value: infer T) => void ? T : never): void;
    emitDisconnect(error: Error): void;
    setBody(body: Readonly<{ air: number; underwater: boolean; suffocating?: boolean }>): void;
    listenerCounts(): Readonly<{ occurrences: number; disconnects: number }>;
    readonly toolNames: string[];
  } = {
    runtimeInfo: vi.fn(async () => ({ world_knowledge_profile: options.profile ?? "grounded_evidence" })),
    ensureBot: vi.fn(async () => ({
      uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d",
      name: "HarnessBot",
      lifecycle_state: "alive",
      observation_revision: 1,
    })),
    actorGet: vi.fn(),
    startToolCall: vi.fn((name) => {
      toolNames.push(name);
      if (name === "goto") gotoAttempt += 1;
      if (name === "goto" && gotoAttempt === 1 && options.interruptAgentGotoWithLowAir === true) {
        const result = new Promise<{ success: false; message: string; interrupted: true }>((resolve) => {
          pendingGoto = resolve;
        });
        queueMicrotask(() => client.emitOccurrence({
          type: "body_state_changed", sequence: 2, server_tick: 21,
          data: bodyState({ air: 80, underwater: true }),
        }));
        return { taskId: 41, result };
      }
      if (name === "goto") {
        options.onGotoStarted?.(gotoAttempt);
        const outcome = options.gotoOutcomes?.[gotoAttempt - 1] ?? "success";
        if (outcome === "success" && options.gotoGate !== undefined) {
          return {
            taskId: toolNames.length,
            result: options.gotoGate.then(() => {
              underwater = false;
              return runtimeToolResult(name, { air, underwater, suffocating });
            }),
          };
        }
        if (outcome === "success") underwater = false;
        if (outcome === "failed") {
          return {
            taskId: toolNames.length,
            result: Promise.resolve({ success: false, message: "surface route failed" }),
          };
        }
        if (outcome === "interrupted") {
          return {
            taskId: toolNames.length,
            result: Promise.resolve({ success: false, message: "surface route interrupted", interrupted: true }),
          };
        }
        if (outcome === "invalid") {
          return {
            taskId: toolNames.length,
            result: Promise.resolve({ success: true, message: "invalid goto result", data: {} }),
          };
        }
      }
      return {
        taskId: toolNames.length,
        result: Promise.resolve(runtimeToolResult(name, { air, underwater, suffocating })),
      };
    }),
    taskCancel: vi.fn(async (taskId) => {
      pendingGoto?.({ success: false, message: "cancelled after neutral cleanup", interrupted: true });
      pendingGoto = undefined;
      return { task_id: taskId, cancelled: true };
    }),
    observe: vi.fn(async () => ({ observation_revision: 8, server_tick: 0, game_time: 0 })),
    afterTicks: vi.fn(() => new Promise<{ server_tick: number }>(() => {})),
    blockGet: vi.fn(async () => ({ operation: "block.get", cells: [] })),
    blockFind: vi.fn(async () => ({ operation: "block.find", matches: [], has_more: false, complete: false })),
    blockRegion: vi.fn(async (_dimension, min, max) => ({
      operation: "block.region", dimension: "minecraft:overworld", min,
      size: { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 },
      palette: [{ state: "UNKNOWN" }], indices: [], complete: false,
    })),
    entityList: vi.fn(async () => ({ operation: "entity.list", tracks: [], has_more: false })),
    onOccurrence: vi.fn((listener) => {
      occurrenceListeners.add(listener);
      return () => occurrenceListeners.delete(listener);
    }),
    onDisconnect: vi.fn((listener) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    }),
    close: vi.fn(),
    emitOccurrence(occurrence) {
      for (const listener of occurrenceListeners) listener(occurrence);
    },
    emitDisconnect(error) {
      for (const listener of disconnectListeners) listener(error);
    },
    setBody(body) {
      air = body.air;
      underwater = body.underwater;
      suffocating = body.suffocating ?? suffocating;
    },
    listenerCounts() {
      return { occurrences: occurrenceListeners.size, disconnects: disconnectListeners.size };
    },
    toolNames,
  };
  return client;
}

async function runEvents(directory: string): Promise<Record<string, unknown>[]> {
  const runDirectory = join(directory, (await readdir(directory))[0]!);
  return (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function preStepContext(content: string): Record<string, unknown> {
  return JSON.parse(content.match(/\n(\{.*\})\n<\/minecraft_pre_step_context>/su)?.[1] ?? "null");
}

function runtimeToolResult(name: string, options: Readonly<{ air?: number; underwater?: boolean; suffocating?: boolean }>) {
  if (name === "get_self_status") {
    return {
      success: true,
      message: "body status",
      data: {
        entity_id: 1,
        name: "HarnessBot",
        game_mode: "survival",
        dimension: "minecraft:overworld",
        position: { x: 0.5, y: 64, z: 0.5 },
        feet: { x: 0, y: 64, z: 0 },
        facing: "north",
        hp: 20,
        max_hp: 20,
        hunger: 20,
        raw_inventory: [],
        air: `${options.air ?? 300}/300`,
        on_ground: true,
        in_water: options.underwater ?? false,
        underwater: options.underwater ?? false,
        in_lava: false,
        on_fire: false,
        suffocating: options.suffocating ?? false,
        intersecting_blocks: [],
        velocity: { x: 0, y: 0, z: 0 },
        fall_distance: 0,
        equipment: {},
        backpack_slots: { used: 0, total: 41 },
        active_effects: [],
      },
    };
  }
  if (name === "inspect_gui") {
    return {
      success: true,
      message: "inventory",
      data: {
        menu_type: null, own_inventory: true, slots: [],
        cursor: { item_id: null, count: 0 }, data_values: [],
      },
    };
  }
  if (name === "goto") {
    return {
      success: true,
      message: "arrived",
      data: { position: { x: 0.5, y: 66, z: 0.5 }, ground_y: 66 },
    };
  }
  if (name === "manage_scaffold_materials") {
    return {
      success: true,
      message: "current Scaffold Material consumption policy",
      data: {
        action: "read",
        item_id_globs: ["minecraft:*dirt"],
        effective_item_count: 3,
        effective_item_sample: ["minecraft:dirt", "minecraft:coarse_dirt", "minecraft:rooted_dirt"],
        carried_matching_items: [{ item_id: "minecraft:dirt", count: 12 }],
      },
    };
  }
  return { success: true, message: `${name} complete`, data: {} };
}

function bodyState(overrides: Readonly<Partial<{
  health: number;
  max_health: number;
  air: number;
  max_air: number;
  underwater: boolean;
  in_lava: boolean;
  on_fire: boolean;
  suffocating: boolean;
  intersecting_blocks: readonly Readonly<{ x: number; y: number; z: number }>[];
}>> = {}) {
  return {
    health: 20,
    max_health: 20,
    air: 300,
    max_air: 300,
    underwater: false,
    in_lava: false,
    on_fire: false,
    suffocating: false,
    intersecting_blocks: [],
    ...overrides,
  };
}

function decision(id: string, name: string, input: Record<string, unknown>): ScriptedDecision {
  return { message: {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: name, input }],
  } };
}

function config(directory: string) {
  return {
    mode: "code",
    runtime: { url: "ws://127.0.0.1:8765/rpc" },
    bot: { username: "HarnessBot" },
    model: {
      provider: "openai",
      model: "test-model",
      limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
    },
    artifacts: { directory },
    data: { directory },
  };
}

function compatibleConfig(directory: string) {
  return {
    ...config(directory),
    model: {
      provider: "openai-compatible" as const,
      name: "local-vllm",
      model: "compatible-test",
      baseUrl: "http://127.0.0.1:8000/v1",
      protocol: "chat-completions" as const,
      limits: { contextWindowTokens: 262144, maxOutputTokens: 4 },
    },
  };
}

async function temporaryDirectory(directories: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mc-agent-harness-"));
  directories.push(directory);
  return directory;
}
