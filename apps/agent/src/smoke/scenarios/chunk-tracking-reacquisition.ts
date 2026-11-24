import { runScenarioHarness as runHarness } from "./shared.js";
import { setTimeout as delay } from "node:timers/promises";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext } from "../../harness/run-harness.js";
import {
  assertInitialObservation, borrowedScenarioRuntimeSession, freshPreStepContext, intervene, record,
  scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

const TAG = "mcagent_chunk_reacquisition";
async function runChunkTrackingReacquisition(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  let requests = 0;
  let uuid: string | undefined;
  let sawKnown = false;
  const model = new ScriptedLanguageModel({ limits: { contextWindowTokens: 200_000 }, respond: async (request: ScriptedModelCall) => {
    requests += 1;
    if (requests === 1) {
      assertInitialObservation(request, manifest);
      const externalAssertions = record(freshPreStepContext(request).external_assertions);
      const [goal] = Array.isArray(externalAssertions.assertions) ? externalAssertions.assertions : [];
      if (record(goal).id !== "goal"
          || record(goal).text !== "Preserve one sheep UUID while it leaves and re-enters Bot tracking range.") {
        throw new Error("chunk reacquisition scenario omitted its task-specific external assertion");
      }
      await intervene(context, "spawn the tracked sheep",
        `summon minecraft:sheep 2.5 101 0.5 {NoAI:1b,PersistenceRequired:1b,Tags:["${TAG}"]}`);
      const visible = await waitForTrack(client, undefined, "VISIBLE");
      uuid = visible.uuid;
      return scriptedToolDecision("wait-chunk-exit", "run_code", { code: "return await abilities.wait({ seconds: 0.1 });", description: "Settle tracked entity evidence" });
    }
    if (requests === 2) {
      await intervene(context, "force-load the remote tracking chunk", "forceload add 200 0");
      await intervene(context, "move the Runtime Bot outside sheep tracking range", "tp bot 200.5 101 0.5");
      const known = await waitForTrack(client, uuid, "KNOWN");
      sawKnown = known.state === "KNOWN";
      await intervene(context, "return the Runtime Bot to the same tracked sheep", "tp bot 0.5 101 0.5");
      const visibleAgain = await waitForTrack(client, uuid, "VISIBLE");
      if (visibleAgain.uuid !== uuid) throw new Error("chunk reacquisition changed entity UUID");
      return scriptedToolDecision("verify-chunk-reacquisition", "run_code", { code: "return await abilities.observe_entities({ entity_id_glob: 'minecraft:sheep' });", description: "Verify the reacquired sheep through the public Ability" });
    }
    return scriptedScenarioEnd();
  }});
  const result = await runHarness({
    agentContext: staticGoalContext("Preserve one sheep UUID while it leaves and re-enters Bot tracking range."),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model,
    modelLimits: model.limits,
    hazardDecisions: "disabled",
  });
  await intervene(context, "clean the remote forced chunk", "forceload remove 200 0");
  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 3 || uuid === undefined || !sawKnown) {
    throw new Error(`fresh chunk tracking reacquisition failed: ${JSON.stringify({ result, requests, uuid, sawKnown })}`);
  }
}

async function waitForTrack(client: ScenarioRunContext["client"], uuid: string | undefined, state: "VISIBLE" | "KNOWN") {
  const deadline = Date.now() + 15_000;
  do {
    await client.observe();
    const tracks = (await client.entityList({ dimension: "minecraft:overworld", entityIdGlob: "minecraft:sheep" })).tracks;
    const track = tracks.find((candidate) => (uuid === undefined || candidate.uuid === uuid) && candidate.state === state);
    if (track !== undefined) return track;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`tracked sheep did not become ${state}`);
}

export const chunkTrackingReacquisitionScenario = { id: "chunk-tracking-reacquisition" as const, run: runChunkTrackingReacquisition };
