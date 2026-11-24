import { runScenarioHarness as runHarness } from "./shared.js";
import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  freshPreStepContext, intervene, lastAbilityResult, borrowedScenarioRuntimeSession, observedPositions, record,
  scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, stringField, type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL =
  "Set a bounded Scaffold Material policy and enter the remembered safe bed.";

async function runSleepingAndScaffoldPolicy(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  let requests = 0;
  let initialPolicyVerified = false;
  let updatedPolicyVerified = false;
  let overworldReturnVerified = false;
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const configuredGlobs = ["minecraft:dirt", "minecraft:stone"];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      const preStep = freshPreStepContext(request);
      if (requests === 1) {
        const observation = stringField(preStep, "turn_observation");
        const spawn = manifest.sharedSpawn;
        if (!observation.includes(`feet=${spawn.x},${spawn.y},${spawn.z}`)) {
          throw new Error("sleeping Scenario did not start at its shared spawn");
        }
        const policy = record(preStep.navigation_policy);
        initialPolicyVerified = policy.action === "read"
          && Array.isArray(policy.item_id_globs) && policy.item_id_globs.length > 0
          && policy.effective_item_count === 23;
        return scriptedToolDecision("set-scaffold-policy", "manage_scaffold_materials", {
          action: "set", item_id_globs: configuredGlobs,
        });
      }
      if (requests === 2) {
        const policy = record(preStep.navigation_policy);
        updatedPolicyVerified = JSON.stringify(policy.item_id_globs) === JSON.stringify(configuredGlobs)
          && policy.effective_item_count === 2;
        await intervene(context, "move Runtime Bot to the sealed Nether bed",
          "execute in minecraft:the_nether run tp bot 0.5 101 -1.5 0 0");
        return scriptedToolDecision("wait-for-nether-observation", "wait", { seconds: 1 });
      }
      if (requests === 3) {
        const netherFoot = manifest.fixtures.nether_bed_foot;
        if (netherFoot === undefined || netherFoot.dimension !== "minecraft:the_nether") {
          throw new Error("sleeping safety scenario omitted its sealed Nether bed fixture");
        }
        return scriptedToolDecision("refuse-destructive-nether-bed", "sleep_in_bed", {
          position: netherFoot.position,
        });
      }
      if (requests === 4) {
        await intervene(context, "return Runtime Bot to the sealed Overworld bed",
          `execute in minecraft:overworld run tp bot ${manifest.sharedSpawn.x + 0.5} ${manifest.sharedSpawn.y} ${manifest.sharedSpawn.z + 0.5} 0 0`);
        return scriptedToolDecision("wait-for-overworld-observation", "wait", { seconds: 1 });
      }
      if (requests === 5) {
        const observation = stringField(preStep, "turn_observation");
        const bedFoot = manifest.fixtures.bed_foot;
        if (bedFoot === undefined) throw new Error("sleeping scenario omitted its safe bed fixture");
        overworldReturnVerified = observation.includes("dimension=minecraft:overworld")
          && observedPositions(request, "minecraft:red_bed")
            .some((position) => position.x === bedFoot.position.x
              && position.y === bedFoot.position.y && position.z === bedFoot.position.z);
        return scriptedToolDecision("sleep-in-fresh-bed", "sleep_in_bed", { position: bedFoot.position });
      }
      return scriptedScenarioEnd();
    },
  });
  const result = await runHarness({
    agentContext: staticGoalContext(HARNESS_RUN_GOAL),
    config: { ...smokeHarnessConfig(runtimeUrl, artifactsDirectory), mode: "native" },
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) { if (event.type === "ability_call_finished") finished.push(event); },
  });
  const policy = lastAbilityResult(finished, "manage_scaffold_materials", (candidate) =>
    candidate.data?.action === "set");
  const refused = lastAbilityResult(finished, "sleep_in_bed", (candidate) => candidate.ok === false);
  const slept = lastAbilityResult(finished, "sleep_in_bed", (candidate) => candidate.ok === true);
  const bedPositions = Object.values(manifest.fixtures)
    .filter((fixture) => fixture.blockId === "minecraft:red_bed"
      && (fixture.dimension === undefined || fixture.dimension === "minecraft:overworld"))
    .map((fixture) => fixture.position);
  const bedEvidence = await client.blockGet("minecraft:overworld", bedPositions);
  const netherBedPositions = Object.values(manifest.fixtures)
    .filter((fixture) => fixture.blockId === "minecraft:red_bed"
      && fixture.dimension === "minecraft:the_nether")
    .map((fixture) => fixture.position);
  const netherBedEvidence = await client.blockGet("minecraft:the_nether", netherBedPositions);
  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 6
      || !initialPolicyVerified || !updatedPolicyVerified || !overworldReturnVerified
      || policy?.ok !== true || JSON.stringify(policy.data?.item_id_globs) !== JSON.stringify(configuredGlobs)
      || refused?.ok !== false || refused.data?.attempted_candidates?.length !== 1
      || refused.data?.attempted_candidates?.[0]?.enter_bed?.data?.failure_type
        !== "bed_not_usable_in_dimension"
      || slept?.ok !== true || slept.data?.attempted_candidates?.length !== 1
      || slept.data?.attempted_candidates?.[0]?.enter_bed?.data?.sleeping !== true
      || bedEvidence.cells.some((cell) => cell.state !== "KNOWN_BLOCK"
        || canonicalBlockId(cell.block_state) !== "minecraft:red_bed")
      || netherBedEvidence.cells.some((cell) => cell.state !== "KNOWN_BLOCK"
        || canonicalBlockId(cell.block_state) !== "minecraft:red_bed")) {
    throw new Error(`fresh sleeping/scaffold conformance failed: ${JSON.stringify({
      result, requests, initialPolicyVerified, updatedPolicyVerified, overworldReturnVerified,
      policy, refused, slept, bedEvidence, netherBedEvidence,
    })}`);
  }
}

export const sleepingAndScaffoldPolicyScenario = {
  id: "sleeping-and-scaffold-policy" as const,
  run: runSleepingAndScaffoldPolicy,
};
