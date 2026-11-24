import { runScenarioHarness as runHarness } from "./shared.js";
import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, intervene, lastAbilityResult, borrowedScenarioRuntimeSession,
  runtimeInventoryCount, samePosition, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig,
  type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL =
  "Place the prepared cobblestone at the exact distant target through one verified approach and retry.";
const PLACED_ITEM = "minecraft:cobblestone";

async function runPlacementApproachAndRetry(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  let requests = 0;
  let phase: "prepare" | "drive" | "end" = "prepare";
  const started: Array<Extract<HarnessProgressEvent, { type: "ability_call_started" }>> = [];
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (phase === "prepare") {
        assertInitialObservation(request, manifest);
        await intervene(context, "prepare one exact placement item",
          `item replace entity bot hotbar.0 with ${PLACED_ITEM} 1`);
        phase = "drive";
        return scriptedToolDecision("settle-placement-item", "run_code", {
          description: "Wait for the prepared placement inventory to reach embodied observation",
          code: "return await abilities.wait({ seconds: 1 });",
        });
      }
      if (phase === "end") return scriptedScenarioEnd();
      phase = "end";
      const target = manifest.fixtures.placement_support?.position;
      if (target === undefined) throw new Error("placement scenario omitted its support fixture");
      const placementTarget = { x: target.x, y: target.y + 1, z: target.z };
      return scriptedToolDecision("run-placement-approach", "run_code", {
        description: "Place one exact block after the composite establishes a reachable placement pose",
        code: [
          `const placed = await abilities.goto_and_place_block({ item_id: ${JSON.stringify(PLACED_ITEM)}, position: ${JSON.stringify(placementTarget)} });`,
          "return { placed };",
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

  const support = manifest.fixtures.placement_support?.position;
  if (support === undefined) throw new Error("placement scenario omitted its support fixture");
  const target = { x: support.x, y: support.y + 1, z: support.z };
  const placed = lastAbilityResult(finished, "goto_and_place_block");
  const physical = await client.blockGet("minecraft:overworld", [support, target]);
  const supportCell = physical.cells.find((cell) => samePosition(cell.position, support));
  const targetCell = physical.cells.find((cell) => samePosition(cell.position, target));
  const remaining = await runtimeInventoryCount(client, PLACED_ITEM);
  const placementCalls = started
    .filter((event) => event.ability === "place_block"
      || event.ability === "goto_block_placement_pose")
    .map((event) => event.ability);

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 3
      || placed?.ok !== true || placed.data?.initial?.ok !== false
      || placed.data?.initial?.data?.failure_type !== "out_of_reach"
      || placed.data?.approach?.ok !== true || placed.data?.retry?.ok !== true
      || placementCalls.join(",") !== "place_block,goto_block_placement_pose,place_block"
      || targetCell?.state !== "KNOWN_BLOCK"
      || canonicalBlockId(targetCell.block_state) !== PLACED_ITEM
      || supportCell?.state !== "KNOWN_BLOCK"
      || canonicalBlockId(supportCell.block_state) !== "minecraft:polished_andesite"
      || remaining !== 0) {
    throw new Error(`fresh placement approach conformance failed: ${JSON.stringify({
      result, requests, placed, placementCalls, physical, remaining,
    })}`);
  }
}

export const placementApproachAndRetryScenario = {
  id: "placement-approach-and-retry" as const,
  run: runPlacementApproachAndRetry,
};
