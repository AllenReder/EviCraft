import { describe, expect, it, vi } from "vitest";
import { foodConsumptionAndRecoveryScenario } from "../src/smoke/scenarios/food-consumption-and-recovery.js";
import type { ScenarioRunContext } from "../src/smoke/scenarios/shared.js";

const drive = vi.hoisted(() => ({ respond: undefined as undefined | (() => Promise<unknown>) }));
vi.mock("../src/harness/testing/scripted-language-model.js", () => ({
  ScriptedLanguageModel: class { limits = {}; constructor(options: { respond(): Promise<unknown> }) { drive.respond = options.respond; } },
}));
vi.mock("../src/harness/run-harness.js", () => ({
  staticGoalContext: (text: string) => text,
}));
vi.mock("../src/smoke/scenarios/shared.js", () => ({
  assertInitialObservation: () => {}, intervene: async () => {}, borrowedScenarioRuntimeSession: () => {},
  smokeHarnessConfig: () => ({}), scriptedToolDecision: () => ({}), scriptedScenarioEnd: () => ({}),
  runScenarioHarness: async () => { for (let step = 0; step < 70; step++) { try { await drive.respond!(); } catch { break; } } return { status: "ended", endReason: "model_transport_error" }; },
  lastAbilityResult: () => undefined, runtimeInventoryCount: async () => 0,
}));

describe("food conformance fixture preparation", () => {
  it("fails with actual body evidence after a bounded number of unchanged hunger observations", async () => {
    const toolCall = vi.fn(async () => ({ success: true, data: { hunger: 20, active_effects: [{ effect_id: "minecraft:hunger", duration_ticks: 599 }] } }));
    const context = { client: { toolCall }, manifest: {}, artifactsDirectory: "/unused", runtimeUrl: "unused", bearerToken: "unused" } as unknown as ScenarioRunContext;
    await expect(foodConsumptionAndRecoveryScenario.run(context)).rejects.toThrow('food fixture preparation did not reach 8 within 30000ms/60 observations');
    expect(toolCall).toHaveBeenCalledTimes(60);
  });
});
