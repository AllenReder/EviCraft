import { runScenarioHarness as runHarness } from "./shared.js";
import type { BlockPosition } from "@evicraft/runtime-sdk";

import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, hasField, lastAbilityResult, borrowedScenarioRuntimeSession, observedPositions,
  runtimeInventoryCount, samePosition, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig,
  type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL =
  "Collect two remembered diamond-ore blocks through verified interaction poses.";

async function runInteractionAndCollection(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest } = context;
  let requests = 0;
  let wireProbePassed = false;
  const started: Array<Extract<HarnessProgressEvent, { type: "ability_call_started" }>> = [];
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  let orePositions: readonly BlockPosition[] = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (requests > 1) return scriptedScenarioEnd();
      assertInitialObservation(request, manifest);
      const tools = await client.toolList();
      const wire = JSON.stringify(tools);
      if (wire.includes("_regex") || !wire.includes("block_id_glob")
          || !wire.includes("item_id_glob")) {
        throw new Error(`Runtime Tool wire did not expose Glob-only selectors: ${wire}`);
      }
      const status = await client.toolCall("get_self_status", {});
      const dimension = String(status.data?.dimension);
      const globMatches = await client.blockFind(dimension, "minecraft:*_ore");
      if (globMatches.matches.filter((match) =>
        canonicalBlockId(match.block_state) === "minecraft:diamond_ore").length !== 2) {
        throw new Error(`Glob wire probe did not match both remembered ores: ${JSON.stringify(globMatches)}`);
      }
      wireProbePassed = true;
      const storageFixture = manifest.fixtures.storage;
      const storage = storageFixture?.position;
      orePositions = observedPositions(request, "minecraft:diamond_ore");
      if (storageFixture === undefined || storage === undefined
          || storageFixture.blockId !== "minecraft:chest" || orePositions.length !== 2) {
        throw new Error("interaction-and-collection fixtures were absent from fresh observation");
      }
      const revealPose = { x: storage.x - 1, y: manifest.sharedSpawn.y, z: storage.z - 1 };
      return scriptedToolDecision("run-interaction-collection", "run_code", {
        description: "Collect two evidence-backed diamond ores through registered Ability peers",
        code: [
          `const revealed = await abilities.goto(${JSON.stringify(revealPose)});`,
          "if (!revealed.ok) return { revealed };",
          `const observed = await abilities.observe_block(${JSON.stringify(storage)});`,
          `const reset = await abilities.goto(${JSON.stringify(manifest.sharedSpawn)});`,
          "if (!observed.ok || !reset.ok) return { revealed, observed, reset };",
          `const opened = await abilities.goto_and_activate_block({ position: ${JSON.stringify(storage)} });`,
          "if (!opened.ok) return { revealed, observed, reset, opened };",
          "const moved = await abilities.transfer_item({ item_id: 'minecraft:diamond_pickaxe', count: 1, source: 'menu_storage', target: 'player_inventory' });",
          "const closed = await abilities.close_menu({});",
          "if (!moved.ok || !closed.ok) return { revealed, observed, reset, opened, moved, closed };",
          "const equipped = await abilities.equip_item({ item_id: 'minecraft:diamond_pickaxe' });",
          `const returned = await abilities.goto(${JSON.stringify(manifest.sharedSpawn)});`,
          "if (!equipped.ok || !returned.ok) return { revealed, observed, reset, opened, moved, closed, equipped, returned };",
          "const collected = await abilities.collect_blocks({ block_id_glob: 'minecraft:diamond_ore', count: 2 });",
          "return { revealed, observed, reset, opened, moved, closed, equipped, returned, collected };",
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
  const collected = lastAbilityResult(finished, "collect_blocks");
  const activated = lastAbilityResult(finished, "goto_and_activate_block");
  const observedStorage = lastAbilityResult(finished, "observe_block", (candidate) =>
    candidate.ok === true && candidate.data?.cells?.some((cell: any) =>
      cell.state === "KNOWN_BLOCK" && canonicalBlockId(cell.block_state) === "minecraft:chest"
      && samePosition(cell.position, manifest.fixtures.storage!.position)));
  if (orePositions.length !== 2) {
    throw new Error(`fresh interaction/collection did not reach its scenario: ${JSON.stringify({ result, requests, orePositions })}`);
  }
  const physical = await client.blockGet("minecraft:overworld", [...orePositions]);
  const diamonds = await runtimeInventoryCount(client, "minecraft:diamond");
  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 2
      || !wireProbePassed || observedStorage?.ok !== true || activated?.ok !== true
      || activated.data?.outcome !== "menu_opened"
      || !samePosition(activated.data?.position, manifest.fixtures.storage!.position)
      || collected?.ok !== true || collected.data?.requested_blocks !== 2
      || collected.data?.completed_blocks !== 2 || collected.data?.broken_blocks !== 2
      || collected.data?.collected_items?.["minecraft:diamond"] !== 2
      || collected.data?.unresolved_observed_drops?.length !== 0
      || diamonds !== 2 || physical.cells.some((cell) => cell.state !== "KNOWN_AIR")
      || !started.some((event) => event.ability === "goto_block_interaction_pose")
      || started.filter((event) => event.ability === "activate_block").length !== 2
      || !started.some((event) => event.ability === "collect_items")
      || !started.some((event) => event.ability === "find_known_blocks"
        && hasField(event.input, "block_id_glob"))) {
    throw new Error(`fresh interaction/collection conformance failed: ${JSON.stringify({
      result, requests, wireProbePassed, observedStorage, activated, collected, diamonds, physical, started,
    })}`);
  }
}

export const interactionAndCollectionScenario = {
  id: "interaction-and-collection" as const,
  run: runInteractionAndCollection,
};
