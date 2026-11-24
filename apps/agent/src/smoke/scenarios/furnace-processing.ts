import { runScenarioHarness as runHarness } from "./shared.js";
import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, lastAbilityResult, borrowedScenarioRuntimeSession, record, runtimeInventoryCount,
  samePosition, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL = "Process two raw iron in the clean ordinary furnace and collect the output.";

async function runFurnaceProcessing(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest } = context;
  let requests = 0;
  const timeline: HarnessProgressEvent[] = [];
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (requests > 1) return scriptedScenarioEnd();
      assertInitialObservation(request, manifest);
      const storageFixture = manifest.fixtures.storage;
      const furnaceFixture = manifest.fixtures.furnace;
      const storage = storageFixture?.position;
      const furnace = furnaceFixture?.position;
      if (storageFixture === undefined || furnaceFixture === undefined
          || storage === undefined || furnace === undefined
          || storageFixture.blockId !== "minecraft:chest"
          || furnaceFixture.blockId !== "minecraft:furnace") {
        throw new Error("furnace-processing fixtures were absent from fresh observation");
      }
      const revealPose = { x: storage.x - 1, y: manifest.sharedSpawn.y, z: manifest.sharedSpawn.z };
      return scriptedToolDecision("run-furnace-processing", "run_code", {
        description: "Smelt two raw iron using existing and caller-authorized fuel",
        code: [
          `const revealed = await abilities.goto(${JSON.stringify(revealPose)});`,
          "if (!revealed.ok) return { revealed };",
          `const storageEvidence = await abilities.observe_block(${JSON.stringify(storage)});`,
          `const furnaceEvidence = await abilities.observe_block(${JSON.stringify(furnace)});`,
          "if (!storageEvidence.ok || !furnaceEvidence.ok) return { revealed, storageEvidence, furnaceEvidence };",
          `const opened = await abilities.goto_and_activate_block({ position: ${JSON.stringify(storage)} });`,
          "if (!opened.ok) return { revealed, storageEvidence, furnaceEvidence, opened };",
          "const input = await abilities.transfer_item({ item_id: 'minecraft:raw_iron', count: 2, source: 'menu_storage', target: 'player_inventory' });",
          "const fuel = await abilities.transfer_item({ item_id: 'minecraft:coal', count: 2, source: 'menu_storage', target: 'player_inventory' });",
          "const closed = await abilities.close_menu({});",
          "if (!input.ok || !fuel.ok || !closed.ok) return { revealed, storageEvidence, furnaceEvidence, opened, input, fuel, closed };",
          `const smelted = await abilities.smelt_at_furnace({ input_item: 'minecraft:raw_iron', count: 2, fuel_item: 'minecraft:coal', fuel_count: 2, position: ${JSON.stringify(furnace)} });`,
          "return { revealed, storageEvidence, furnaceEvidence, opened, input, fuel, closed, smelted };",
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
    onProgress(event) { timeline.push(event); if (event.type === "ability_call_finished") finished.push(event); },
  });
  const smelted = lastAbilityResult(finished, "smelt_at_furnace");
  const programmaticStarted = timeline.find((event): event is Extract<HarnessProgressEvent,
    { type: "programmatic_execution_started" }> => event.type === "programmatic_execution_started");
  const programmaticFinished = timeline.find((event): event is Extract<HarnessProgressEvent,
    { type: "programmatic_execution_finished" }> => event.type === "programmatic_execution_finished");
  const smeltCall = timeline.find((event): event is Extract<HarnessProgressEvent,
    { type: "ability_call_started" }> => event.type === "ability_call_started" && event.ability === "smelt_at_furnace");
  const directProgrammaticCalls = timeline.filter((event): event is Extract<HarnessProgressEvent,
    { type: "ability_call_started" }> => event.type === "ability_call_started"
      && event.rootId === programmaticStarted?.rootId && event.depth === 2);
  const programmaticTreeIsValid = programmaticStarted !== undefined
    && programmaticFinished?.rootId === programmaticStarted.rootId
    && programmaticFinished.executionId === programmaticStarted.executionId
    && programmaticFinished.outcome === "succeeded" && directProgrammaticCalls.length > 0
    && directProgrammaticCalls.every((event) => event.parentExecutionId === programmaticStarted.executionId)
    && smeltCall?.parentExecutionId === programmaticStarted.executionId;
  const smeltStartedAt = timeline.indexOf(smeltCall!);
  const fuelTransfers = timeline.filter((event): event is Extract<HarnessProgressEvent,
    { type: "ability_call_started" }> => event.type === "ability_call_started"
      && event.ability === "transfer_item" && event.parentExecutionId === smeltCall?.executionId
      && record(event.input).target === "menu_fuel");
  const firstFuelTransferAt = timeline.indexOf(fuelTransfers[0]!);
  const existingFuelWasObservedFirst = smeltStartedAt >= 0 && firstFuelTransferAt > smeltStartedAt
    && timeline.slice(smeltStartedAt, firstFuelTransferAt).some((event) =>
      event.type === "ability_call_started" && event.ability === "wait"
      && event.parentExecutionId === smeltCall?.executionId);
  const observedStorage = lastAbilityResult(finished, "observe_block", (candidate) =>
    candidate.ok === true && candidate.data?.cells?.some((cell: any) =>
      cell.state === "KNOWN_BLOCK" && canonicalBlockId(cell.block_state) === "minecraft:chest"
      && samePosition(cell.position, manifest.fixtures.storage!.position)));
  const observedFurnace = lastAbilityResult(finished, "observe_block", (candidate) =>
    candidate.ok === true && candidate.data?.cells?.some((cell: any) =>
      cell.state === "KNOWN_BLOCK" && canonicalBlockId(cell.block_state) === "minecraft:furnace"
      && samePosition(cell.position, manifest.fixtures.furnace!.position)));
  const ingots = await runtimeInventoryCount(client, "minecraft:iron_ingot");
  const menu = await client.toolCall("inspect_gui", {});
  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 2
      || observedStorage?.ok !== true || observedFurnace?.ok !== true || smelted?.ok !== true
      || smelted.data?.inserted_input !== 2 || smelted.data?.processed_input !== 2
      || smelted.data?.collected_output?.item_id !== "minecraft:iron_ingot"
      || smelted.data?.collected_output?.count !== 2 || smelted.data?.inserted_fuel !== 1
      || smelted.data?.remaining_fuel_budget !== 1 || smelted.data?.remaining_input !== 0
      || fuelTransfers.length !== 1 || record(fuelTransfers[0]?.input).count !== 1
      || !existingFuelWasObservedFirst || !programmaticTreeIsValid
      || ingots !== 2 || menu.success !== true || menu.data?.own_inventory !== true) {
    throw new Error(`fresh furnace conformance failed: ${JSON.stringify({
      result, requests, observedStorage, observedFurnace, smelted, fuelTransfers,
      existingFuelWasObservedFirst, programmaticTreeIsValid, directProgrammaticCalls,
      programmaticStarted, programmaticFinished, ingots, menu,
    })}`);
  }
}

export const furnaceProcessingScenario = {
  id: "furnace-processing" as const,
  run: runFurnaceProcessing,
};
