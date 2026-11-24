import { runScenarioHarness as runHarness } from "./shared.js";
import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, intervene, lastAbilityResult, borrowedScenarioRuntimeSession,
  samePosition, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

const DEPTH = 4;

async function runStaircaseDescentAndReturn(context: ScenarioRunContext): Promise<void> {
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
        await intervene(context, "prepare staircase mining implement",
          "item replace entity bot hotbar.0 with minecraft:diamond_pickaxe 1");
        phase = "drive";
        return scriptedToolDecision("settle-staircase-tool", "run_code", {
          description: "Wait for the staircase mining implement to settle",
          code: "return await abilities.wait({ seconds: 1 });",
        });
      }
      if (phase === "end") return scriptedScenarioEnd();
      phase = "end";
      const marker = manifest.fixtures.bottom_marker?.position;
      if (marker === undefined) throw new Error("staircase scenario omitted its bottom marker");
      return scriptedToolDecision("run-staircase-descent", "run_code", {
        description: "Excavate the supported staircase, observe its bottom marker, and walk back to start",
        code: [
          `const descended = await abilities.mine_down({ depth: ${DEPTH}, direction: 'east' });`,
          "if (!descended.ok) return { descended };",
          `const marker = await abilities.observe_block(${JSON.stringify(marker)});`,
          "if (!marker.ok) return { descended, marker };",
          `const returned = await abilities.goto({ x: ${manifest.sharedSpawn.x}, y: ${manifest.sharedSpawn.y}, z: ${manifest.sharedSpawn.z}, route_mutation_permissions: [] });`,
          "return { descended, marker, returned };",
        ].join("\n"),
      });
    },
  });

  const result = await runHarness({
    agentContext: staticGoalContext("Excavate the supported staircase, observe its bottom marker, and return to the start."),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });

  const descended = lastAbilityResult(finished, "mine_down");
  const returned = lastAbilityResult(finished, "goto", (candidate) => candidate.ok === true
    && Number(candidate.data?.position?.y) >= manifest.sharedSpawn.y);
  const marker = manifest.fixtures.bottom_marker!.position;
  const expectedBroken = [];
  const supports = [];
  for (let step = 1; step <= DEPTH; step += 1) {
    const destination = { x: step, y: 101 - step, z: 0 };
    expectedBroken.push(
      { ...destination, y: destination.y + 2 },
      { ...destination, y: destination.y + 1 },
      destination,
    );
    supports.push({ ...destination, y: destination.y - 1 });
  }
  const physical = await client.blockGet("minecraft:overworld", [...expectedBroken, ...supports, marker]);
  const cleared = physical.cells.slice(0, expectedBroken.length);
  const supportCells = physical.cells.slice(expectedBroken.length, expectedBroken.length + supports.length);
  const markerCell = physical.cells.at(-1);
  const finalStatus = await client.toolCall("get_self_status", {});
  const finalFeet = finalStatus.data?.feet as { x: number; y: number; z: number } | undefined;
  const agentBreaks = started.filter((event) => event.source === "agent"
    && event.ability === "break_block");

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 3
      || descended?.ok !== true || descended.data?.completed_depth !== DEPTH
      || JSON.stringify(descended.data?.broken) !== JSON.stringify(expectedBroken)
      || returned?.ok !== true || finalStatus.success !== true
      || finalFeet === undefined || !samePosition(finalFeet, manifest.sharedSpawn)
      || agentBreaks.length !== expectedBroken.length
      || cleared.some((cell) => cell.state !== "KNOWN_AIR")
      || supportCells.some((cell) => cell.state !== "KNOWN_BLOCK"
        || canonicalBlockId(cell.block_state) !== "minecraft:stone")
      || markerCell?.state !== "KNOWN_BLOCK"
      || canonicalBlockId(markerCell.block_state) !== "minecraft:emerald_block") {
    throw new Error(`fresh staircase descent conformance failed: ${JSON.stringify({
      result, requests, descended, returned, finalStatus, expectedBroken,
      agentBreaks: agentBreaks.length, physical,
    })}`);
  }
}

export const staircaseDescentAndReturnScenario = {
  id: "staircase-descent-and-return" as const,
  run: runStaircaseDescentAndReturn,
};
