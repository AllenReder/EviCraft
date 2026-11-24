import { runScenarioHarness as runHarness } from "./shared.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, lastAbilityResult, borrowedScenarioRuntimeSession, intervene,
  runtimeInventoryCount, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL = "Eat the prepared bread and verify the player's recovery state.";
const FOOD_ITEM = "minecraft:bread";
const INITIAL_FOOD_LEVEL = 8;
const FOOD_PREPARATION_TIMEOUT_MS = 30_000;
const MAX_FOOD_PREPARATION_OBSERVATIONS = 60;

async function runFoodConsumptionAndRecovery(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  let preparedFoodLevel = 20;
  let requests = 0;
  let preparationDeadline = 0;
  let preparationObservations = 0;
  let preparationFailure: Error | undefined;
  let phase: "start" | "lowering" | "drive" | "end" = "start";
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const started: Array<Extract<HarnessProgressEvent, { type: "ability_call_started" }>> = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (phase === "start") {
        assertInitialObservation(request, manifest);
        await intervene(context, "lower food level through a temporary Hunger effect",
          "effect give bot minecraft:hunger 30 63 true");
        preparationDeadline = Date.now() + FOOD_PREPARATION_TIMEOUT_MS;
        phase = "lowering";
        return codeWaitDecision("wait-for-lower-food-level", 0.5);
      }
      if (phase === "lowering") {
        const status = await client.toolCall("get_self_status", {});
        preparedFoodLevel = Number(status.data?.hunger);
        preparationObservations += 1;
        if (!status.success || !Number.isFinite(preparedFoodLevel)
            || preparedFoodLevel > INITIAL_FOOD_LEVEL && (Date.now() >= preparationDeadline
              || preparationObservations >= MAX_FOOD_PREPARATION_OBSERVATIONS)) {
          preparationFailure = new Error(`food fixture preparation did not reach ${INITIAL_FOOD_LEVEL} within ${FOOD_PREPARATION_TIMEOUT_MS}ms/${MAX_FOOD_PREPARATION_OBSERVATIONS} observations: ${JSON.stringify(status)}`);
          throw preparationFailure;
        }
        if (preparedFoodLevel > INITIAL_FOOD_LEVEL) {
          return codeWaitDecision(`wait-for-food-level-${requests}`, 0.5);
        }
        await intervene(context, "stop the temporary Hunger effect",
          "effect clear bot minecraft:hunger");
        if (preparedFoodLevel !== INITIAL_FOOD_LEVEL) {
          throw new Error(`could not prepare exact food level ${INITIAL_FOOD_LEVEL}: ${preparedFoodLevel}`);
        }
        await intervene(context, "prepare food conformance state",
          `item replace entity bot hotbar.0 with ${FOOD_ITEM} 1`);
        phase = "drive";
        return codeWaitDecision("observe-prepared-food-state", 1);
      }
      if (phase === "end") return scriptedScenarioEnd();
      phase = "end";
      return scriptedToolDecision("run-food", "run_code", {
        description: "Consume the prepared food and verify the resulting player state",
        code: [
          `const before = await abilities.observe_inventory({});`,
          `const selfBefore = await abilities.observe_self({});`,
          "if (!before.ok || !selfBefore.ok) return { before, selfBefore };",
          `const eaten = await abilities.eat({ item_id: ${JSON.stringify(FOOD_ITEM)} });`,
          `const selfAfter = await abilities.observe_self({});`,
          `const after = await abilities.observe_inventory({});`,
          "return { before, selfBefore, eaten, selfAfter, after };",
        ].join("\n"),
      });
    },
  });
  const result = await runHarness({
    agentContext: staticGoalContext(HARNESS_RUN_GOAL),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });
  if (preparationFailure !== undefined) throw preparationFailure;
  const eaten = lastAbilityResult(finished, "eat");
  const remaining = await runtimeInventoryCount(client, FOOD_ITEM);
  const finalStatus = await client.toolCall("get_self_status", {});
  if (result.status !== "ended" || result.endReason !== "external_stop" || requests < 4
      || eaten?.ok !== true
      || Number(eaten.data?.hunger) <= INITIAL_FOOD_LEVEL
      || started.filter((event) => event.source === "agent"
        && event.ability === "observe_inventory").length !== 2
      || started.filter((event) => event.source === "agent"
        && event.ability === "observe_self").length !== 2
      || remaining !== 0 || finalStatus.success !== true
      || Number(finalStatus.data?.hunger) !== Number(eaten.data?.hunger)) {
    throw new Error(`fresh food conformance failed: ${JSON.stringify({
      result, requests, eaten, started, remaining, finalStatus,
    })}`);
  }
}

function codeWaitDecision(id: string, seconds: number) {
  return scriptedToolDecision(id, "run_code", {
    description: "Wait for the prepared food state to settle",
    code: `return await abilities.wait({ seconds: ${seconds} });`,
  });
}

export const foodConsumptionAndRecoveryScenario = {
  id: "food-consumption-and-recovery" as const,
  run: runFoodConsumptionAndRecovery,
};
