import { runScenarioHarness as runHarness } from "./shared.js";
import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, lastAbilityResult, borrowedScenarioRuntimeSession, record,
  runtimeInventoryCount, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig,
  type ScenarioRunContext,
} from "./shared.js";

async function runMultiRoomFurnaceWorkflow(context: ScenarioRunContext): Promise<void> {
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
      const storage = manifest.fixtures.storage?.position;
      const furnace = manifest.fixtures.furnace?.position;
      if (storage === undefined || furnace === undefined) {
        throw new Error("multi-room furnace scenario omitted its fixtures");
      }
      const storagePose = { x: storage.x - 1, y: storage.y, z: storage.z };
      const furnacePose = { x: furnace.x - 1, y: furnace.y, z: furnace.z };
      return scriptedToolDecision("run-multi-room-furnace", "run_code", {
        description: "Collect input in the south room, traverse the doorway, and process it in the north room",
        code: [
          `const reachedStorage = await abilities.goto({ ...${JSON.stringify(storagePose)}, route_mutation_permissions: [] });`,
          "if (!reachedStorage.ok) return { reachedStorage };",
          "let storageEvidence;",
          "for (let attempt = 0; attempt < 20; attempt += 1) {",
          `  storageEvidence = await abilities.observe_block(${JSON.stringify(storage)});`,
          "  if (storageEvidence.ok && storageEvidence.data?.cells?.some((cell) => cell.state === 'KNOWN_BLOCK')) break;",
          "  await abilities.wait({ seconds: 0.1 });",
          "}",
          "if (!storageEvidence?.ok || !storageEvidence.data?.cells?.some((cell) => cell.state === 'KNOWN_BLOCK')) return { reachedStorage, storageEvidence };",
          `const opened = await abilities.goto_and_activate_block({ position: ${JSON.stringify(storage)} });`,
          "if (!opened.ok) return { reachedStorage, storageEvidence, opened };",
          "const input = await abilities.transfer_item({ item_id: 'minecraft:raw_iron', count: 2, source: 'menu_storage', target: 'player_inventory' });",
          "const fuel = await abilities.transfer_item({ item_id: 'minecraft:coal', count: 2, source: 'menu_storage', target: 'player_inventory' });",
          "const closed = await abilities.close_menu({});",
          "if (!input.ok || !fuel.ok || !closed.ok) return { reachedStorage, storageEvidence, opened, input, fuel, closed };",
          `const reachedFurnace = await abilities.goto({ ...${JSON.stringify(furnacePose)}, route_mutation_permissions: [] });`,
          "if (!reachedFurnace.ok) return { reachedStorage, storageEvidence, opened, input, fuel, closed, reachedFurnace };",
          "let furnaceEvidence;",
          "for (let attempt = 0; attempt < 20; attempt += 1) {",
          `  furnaceEvidence = await abilities.observe_block(${JSON.stringify(furnace)});`,
          "  if (furnaceEvidence.ok && furnaceEvidence.data?.cells?.some((cell) => cell.state === 'KNOWN_BLOCK')) break;",
          "  await abilities.wait({ seconds: 0.1 });",
          "}",
          "if (!furnaceEvidence?.ok || !furnaceEvidence.data?.cells?.some((cell) => cell.state === 'KNOWN_BLOCK')) return { reachedStorage, storageEvidence, opened, input, fuel, closed, reachedFurnace, furnaceEvidence };",
          `const smelted = await abilities.smelt_at_furnace({ input_item: 'minecraft:raw_iron', count: 2, fuel_item: 'minecraft:coal', fuel_count: 2, position: ${JSON.stringify(furnace)} });`,
          "return { reachedStorage, storageEvidence, opened, input, fuel, closed, reachedFurnace, furnaceEvidence, smelted };"
        ].join("\n"),
      });
    },
  });

  const result = await runHarness({
    agentContext: staticGoalContext("Collect raw iron in the south room, then smelt it in the north-room furnace."),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) {
      timeline.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });

  const storage = manifest.fixtures.storage!.position;
  const furnace = manifest.fixtures.furnace!.position;
  const smelted = lastAbilityResult(finished, "smelt_at_furnace");
  const observedStorage = finished.findLast((event) => event.ability === "observe_block"
    && isObservedBlock(event.result, "minecraft:chest", storage));
  const observedFurnace = finished.findLast((event) => event.ability === "observe_block"
    && isObservedBlock(event.result, "minecraft:furnace", furnace));
  const directGotos = timeline.filter((event): event is Extract<HarnessProgressEvent,
    { type: "ability_call_started" }> => event.type === "ability_call_started"
      && event.source === "agent" && event.ability === "goto" && event.depth === 2);
  const ingots = await runtimeInventoryCount(client, "minecraft:iron_ingot");
  const menu = await client.toolCall("inspect_gui", {});
  const finalStatus = await client.toolCall("get_self_status", {});
  const finalPosition = finalStatus.data?.position as { x?: unknown; z?: unknown } | undefined;

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 2
      || directGotos.length !== 2
      || directGotos.some((event) => JSON.stringify(record(event.input).route_mutation_permissions) !== "[]")
      || observedStorage === undefined || observedFurnace === undefined
      || smelted?.ok !== true || smelted.data?.inserted_input !== 2
      || smelted.data?.processed_input !== 2
      || smelted.data?.collected_output?.item_id !== "minecraft:iron_ingot"
      || smelted.data?.collected_output?.count !== 2
      || smelted.data?.remaining_input !== 0 || ingots !== 2
      || menu.success !== true || menu.data?.own_inventory !== true
      || Math.hypot(Number(finalPosition?.x) - (furnace.x + 0.5),
        Number(finalPosition?.z) - (furnace.z + 0.5)) > 4) {
    throw new Error(`fresh multi-room furnace conformance failed: ${JSON.stringify({
      result, requests, directGotos, observedStorage, observedFurnace, smelted,
      ingots, menu, finalStatus,
    })}`);
  }
}

function isObservedBlock(
  result: unknown,
  blockId: string,
  position: { x: number; y: number; z: number },
): boolean {
  if (!isRecord(result) || result.ok !== true || !isRecord(result.data)
      || !Array.isArray(result.data.cells)) {
    return false;
  }
  return result.data.cells.some((cell) => isRecord(cell)
    && cell.state === "KNOWN_BLOCK" && typeof cell.block_state === "string"
    && canonicalBlockId(cell.block_state) === blockId && isSamePosition(cell.position, position));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSamePosition(
  value: unknown,
  position: { x: number; y: number; z: number },
): boolean {
  return isRecord(value) && value.x === position.x && value.y === position.y && value.z === position.z;
}

export const multiRoomFurnaceWorkflowScenario = {
  id: "multi-room-furnace-workflow" as const,
  run: runMultiRoomFurnaceWorkflow,
};
