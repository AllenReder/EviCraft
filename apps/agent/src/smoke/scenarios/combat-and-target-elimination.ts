import { runScenarioHarness as runHarness } from "./shared.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, lastAbilityResult, borrowedScenarioRuntimeSession, record, scriptedScenarioEnd, scriptedToolDecision,
  settleFixtureEntities, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL = "Defeat the one observed zombie through verified combat.";
const TARGET_ENTITY_ID = "minecraft:zombie";

async function runCombatAndTargetElimination(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest } = context;
  const setup = manifest.combat;
  if (setup === undefined) throw new Error("combat scenario omitted combat setup");

  let requests = 0;
  let targetUuid: string | undefined;
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (requests > 1) return scriptedScenarioEnd();
      assertInitialObservation(request, manifest);
      const tracks = await client.entityList({ entityIdGlob: TARGET_ENTITY_ID });
      const target = tracks.tracks.find((track) =>
        track.entity_id === TARGET_ENTITY_ID
          && Math.floor(track.position.x) === setup.zombiePosition.x
          && Math.floor(track.position.y) === setup.zombiePosition.y
          && Math.floor(track.position.z) === setup.zombiePosition.z);
      if (target === undefined) {
        throw new Error(`combat fixture target was not visible at its sealed position: ${JSON.stringify(tracks)}`);
      }
      targetUuid = target.uuid;
      return scriptedToolDecision("run-combat", "run_code", {
        description: "Observe the fixed zombie and defeat that observed entity",
        code: [
          `const observed = await abilities.observe_entities({ entity_id_glob: ${JSON.stringify(TARGET_ENTITY_ID)} });`,
          "if (!observed.ok || observed.data.tracks.length !== 1) return { observed };",
          "const target = observed.data.tracks[0];",
          "const attack = await abilities.attack({ uuids: [target.uuid] });",
          "return { observed, attack };",
        ].join("\n"),
      });
    },
  });
  await settleFixtureEntities(client, TARGET_ENTITY_ID, [setup.zombiePosition]);
  const result = await runHarness({
    agentContext: staticGoalContext(HARNESS_RUN_GOAL),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) { if (event.type === "ability_call_finished") finished.push(event); },
  });
  const observed = lastAbilityResult(finished, "observe_entities");
  const attack = lastAbilityResult(finished, "attack");
  const defeated = Array.isArray(attack?.data?.defeated_uuids) ? attack.data.defeated_uuids : [];
  const combatByEntity = record(attack?.data?.combat_by_entity);
  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 2
      || targetUuid === undefined || attack?.ok !== true || !defeated.includes(targetUuid)
      || JSON.stringify(attack.data?.requested_uuids) !== JSON.stringify([targetUuid])
      || record(combatByEntity[targetUuid]).status !== "defeated"
      || Number(attack.data?.strikes) < 1) {
    throw new Error(`fresh combat conformance failed: ${JSON.stringify({
      result, requests, targetUuid, observed, attack,
    })}`);
  }
}

export const combatAndTargetEliminationScenario = {
  id: "combat-and-target-elimination" as const,
  run: runCombatAndTargetElimination,
};
