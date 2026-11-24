import { runScenarioHarness as runHarness } from "./shared.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, intervene, lastAbilityResult, borrowedScenarioRuntimeSession,
  runtimeInventoryCount, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

const ITEM_ID = "minecraft:cobblestone";

async function runDropObserveAndRecollect(context: ScenarioRunContext): Promise<void> {
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
        await intervene(context, "prepare exact drop inventory",
          `item replace entity bot hotbar.0 with ${ITEM_ID} 8`);
        phase = "drive";
        return scriptedToolDecision("settle-drop-inventory", "run_code", {
          description: "Wait for the prepared drop inventory to settle",
          code: "return await abilities.wait({ seconds: 1 });",
        });
      }
      if (phase === "end") return scriptedScenarioEnd();
      phase = "end";
      return scriptedToolDecision("run-drop-recollect", "run_code", {
        description: "Drop, leave, re-observe, and recollect the exact produced ItemEntity UUIDs",
        code: [
          `const dropped = await abilities.drop_items({ item_id: ${JSON.stringify(ITEM_ID)}, count: 3 });`,
          "if (!dropped.ok || dropped.data.dropped_entity_uuids.length === 0) return { dropped };",
          "const left = await abilities.goto({ x: 4, y: 101, z: 0, route_mutation_permissions: [] });",
          "if (!left.ok) return { dropped, left };",
          `const observed = await abilities.observe_entities({ item_id_glob: ${JSON.stringify(ITEM_ID)} });`,
          "if (!observed.ok) return { dropped, left, observed };",
          "const collected = await abilities.collect_items({ uuids: dropped.data.dropped_entity_uuids, radius: 8 });",
          "const inventory = await abilities.observe_inventory({});",
          "return { dropped, left, observed, collected, inventory };",
        ].join("\n"),
      });
    },
  });

  const result = await runHarness({
    agentContext: staticGoalContext("Drop three cobblestone, observe the dropped items, and recollect their exact UUIDs."),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });

  const dropped = lastAbilityResult(finished, "drop_items");
  const observed = lastAbilityResult(finished, "observe_entities", (candidate) =>
    candidate.ok === true && candidate.data?.tracks?.some((track: any) => track.item_id === ITEM_ID));
  const collected = lastAbilityResult(finished, "collect_items");
  const uuids = dropped?.data?.dropped_entity_uuids as string[] | undefined;
  const exactCollection = started.find((event) => event.ability === "collect_items"
    && Array.isArray((event.input as any).uuids));
  const matchingTracks = Array.isArray(observed?.data?.tracks) && Array.isArray(uuids)
    ? observed.data.tracks.filter((track: any) => uuids.includes(track.uuid))
    : [];
  const remaining = await runtimeInventoryCount(client, ITEM_ID);

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 3
      || dropped?.ok !== true
      || dropped.data?.dropped !== 3 || dropped.data?.remaining_in_inventory !== 5
      || !Array.isArray(uuids) || uuids.length === 0
      || matchingTracks.length !== uuids.length
      || matchingTracks.some((track: any) => track.item_id !== ITEM_ID || track.item_count !== 3)
      || collected?.ok !== true || collected.data?.selection !== "uuids"
      || collected.data?.collected_entities !== uuids.length
      || collected.data?.collected_items !== 3 || collected.data?.skipped_entities !== 0
      || JSON.stringify((exactCollection?.input as any)?.uuids) !== JSON.stringify(uuids)
      || remaining !== 8) {
    throw new Error(`fresh drop-observe-recollect conformance failed: ${JSON.stringify({
      result, requests, dropped, observed, collected, exactCollection, matchingTracks, remaining,
    })}`);
  }
}

export const dropObserveAndRecollectScenario = {
  id: "drop-observe-and-recollect" as const,
  run: runDropObserveAndRecollect,
};
