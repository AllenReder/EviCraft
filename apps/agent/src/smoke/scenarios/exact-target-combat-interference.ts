import { runScenarioHarness as runHarness } from "./shared.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, lastAbilityResult, borrowedScenarioRuntimeSession, record,
  scriptedScenarioEnd, scriptedToolDecision, settleFixtureEntities, smokeHarnessConfig, assertScenarioOracle,
  type ScenarioRunContext,
} from "./shared.js";

const ENTITY_ID = "minecraft:zombie";

async function runExactTargetCombatInterference(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  const setup = manifest.combat;
  if (setup?.distractorZombiePosition === undefined) {
    throw new Error("exact-target combat scenario omitted its distractor setup");
  }
  let requests = 0;
  let targetUuid: string | undefined;
  let distractorUuid: string | undefined;
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (requests > 1) return scriptedScenarioEnd();
      assertInitialObservation(request, manifest);
      const tracks = await client.entityList({ entityIdGlob: ENTITY_ID });
      const target = trackAt(tracks.tracks, setup.zombiePosition);
      const distractor = trackAt(tracks.tracks, setup.distractorZombiePosition!);
      if (target === undefined || distractor === undefined || target.uuid === distractor.uuid) {
        throw new Error(`combat interference fixtures were not distinct: ${JSON.stringify(tracks)}`);
      }
      targetUuid = target.uuid;
      distractorUuid = distractor.uuid;
      return scriptedToolDecision("run-exact-target-combat", "run_code", {
        description: "Attack only the sealed target UUID while preserving the same-type distractor",
        code: [
          `const observed = await abilities.observe_entities({ entity_id_glob: ${JSON.stringify(ENTITY_ID)} });`,
          "if (!observed.ok || observed.data.tracks.length !== 2) return { observed };",
          `const attack = await abilities.attack({ uuids: [${JSON.stringify(targetUuid)}] });`,
          "return { observed, attack };",
        ].join("\n"),
      });
    },
  });

  await settleFixtureEntities(client, ENTITY_ID, [setup.zombiePosition, setup.distractorZombiePosition]);
  const result = await runHarness({
    agentContext: staticGoalContext("Defeat the observed target zombie without harming the same-type distractor."),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) { if (event.type === "ability_call_finished") finished.push(event); },
  });

  const observed = lastAbilityResult(finished, "observe_entities", (candidate) =>
    candidate.ok === true && Array.isArray(candidate.data?.tracks)
      && candidate.data.tracks.some((track: any) => track.uuid === targetUuid)
      && candidate.data.tracks.some((track: any) => track.uuid === distractorUuid));
  const attack = lastAbilityResult(finished, "attack");
  const defeated = Array.isArray(attack?.data?.defeated_uuids) ? attack.data.defeated_uuids : [];
  const combatByEntity = record(attack?.data?.combat_by_entity);
  await assertScenarioOracle(context, "target zombie is absent", entityOracleCommand("unless", setup.zombiePosition));
  await assertScenarioOracle(context, "distractor zombie remains", entityOracleCommand("if", setup.distractorZombiePosition));

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 2
      || targetUuid === undefined || distractorUuid === undefined
      || observed?.ok !== true || observed.data?.tracks?.length !== 2
      || attack?.ok !== true || !defeated.includes(targetUuid) || defeated.includes(distractorUuid)
      || JSON.stringify(attack.data?.requested_uuids) !== JSON.stringify([targetUuid])
      || record(combatByEntity[targetUuid]).status !== "defeated"
      || Object.hasOwn(combatByEntity, distractorUuid)
      || Number(attack.data?.strikes) < 1) {
    throw new Error(`fresh exact-target combat conformance failed: ${JSON.stringify({
      result, requests, targetUuid, distractorUuid, observed, attack,
    })}`);
  }
}

function trackAt(
  tracks: readonly any[],
  position: { x: number; y: number; z: number },
) {
  return tracks.find((track) => track.entity_id === ENTITY_ID
    && Math.floor(track.position.x) === position.x
    && Math.floor(track.position.y) === position.y
    && Math.floor(track.position.z) === position.z);
}

function entityOracleCommand(
  condition: "if" | "unless",
  position: { x: number; y: number; z: number },
) {
  return `execute positioned ${position.x + 0.5} ${position.y} ${position.z + 0.5} ${condition} entity @e[type=minecraft:zombie,distance=..0.9]`;
}

export const exactTargetCombatInterferenceScenario = {
  id: "exact-target-combat-interference" as const,
  run: runExactTargetCombatInterference,
};
