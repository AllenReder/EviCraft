import { runScenarioHarness as runHarness } from "./shared.js";
import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, intervene, lastAbilityResult, borrowedScenarioRuntimeSession,
  samePosition, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

type TunnelExpectation = Readonly<{
  id: "tunnel-frontier-early-stop" | "tunnel-bounded-not-found";
  blockIdGlob: string;
  expectedTarget?: Readonly<{ blockId: string; position: { x: number; y: number; z: number } }>;
}>;

const MAX_LENGTH = 4;

async function runTunnelBranch(
  context: ScenarioRunContext,
  expectation: TunnelExpectation,
): Promise<void> {
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
        await intervene(context, "prepare tunnel harvesting implement",
          "item replace entity bot hotbar.0 with minecraft:diamond_pickaxe 1");
        phase = "drive";
        return scriptedToolDecision(`settle-${expectation.id}-inventory`, "run_code", {
          description: "Wait for the prepared tunnel inventory to settle",
          code: "return await abilities.wait({ seconds: 1 });",
        });
      }
      if (phase === "end") return scriptedScenarioEnd();
      phase = "end";
      return scriptedToolDecision(`run-${expectation.id}`, "run_code", {
        description: "Exercise the bounded tunnel geometry through its public Composite Ability",
        code: [
          `const tunneled = await abilities.tunnel_for_blocks({ block_id_glob: ${JSON.stringify(expectation.blockIdGlob)}, direction: 'east', max_length: ${MAX_LENGTH} });`,
          "return { tunneled };",
        ].join("\n"),
      });
    },
  });

  const result = await runHarness({
    agentContext: staticGoalContext(`Tunnel eastward up to ${MAX_LENGTH} blocks to find the requested ${expectation.blockIdGlob} target.`),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });

  const tunneled = lastAbilityResult(finished, "tunnel_for_blocks");
  const expectedBroken = [];
  for (let x = 1; x <= MAX_LENGTH; x += 1) {
    expectedBroken.push({ x, y: 102, z: 0 }, { x, y: 101, z: 0 });
  }
  const inspectedPositions = expectation.expectedTarget === undefined
    ? expectedBroken
    : [...expectedBroken, expectation.expectedTarget.position];
  const physical = await client.blockGet("minecraft:overworld", inspectedPositions);
  const cleared = physical.cells.slice(0, expectedBroken.length);
  const targetCell = expectation.expectedTarget === undefined
    ? undefined
    : physical.cells.find((cell) => samePosition(cell.position, expectation.expectedTarget!.position));
  const agentCalls = started.filter((event) => event.source === "agent");
  const findCalls = agentCalls.filter((event) => event.ability === "find_known_blocks");
  const breakCalls = agentCalls.filter((event) => event.ability === "break_block");
  const gotoCalls = agentCalls.filter((event) => event.ability === "goto");
  const frontierCalls = agentCalls.filter((event) => event.ability === "observe_blocks");
  const commonPasses = result.status === "ended" && result.endReason === "external_stop"
    && requests === 3 && tunneled?.data?.completed_length === MAX_LENGTH
    && JSON.stringify(tunneled?.data?.broken) === JSON.stringify(expectedBroken)
    && cleared.every((cell) => cell.state === "KNOWN_AIR")
    && findCalls.length === 1 && breakCalls.length === expectedBroken.length
    && gotoCalls.length === MAX_LENGTH && frontierCalls.length === MAX_LENGTH + 1;
  const branchPasses = expectation.expectedTarget === undefined
    ? tunneled?.ok === true && tunneled.data?.found === false && tunneled.data?.target === undefined
    : tunneled?.ok === true && tunneled.data?.found === true
      && samePosition(tunneled.data?.target?.position, expectation.expectedTarget.position)
      && canonicalBlockId(tunneled.data?.target?.block_state) === expectation.expectedTarget.blockId
      && targetCell?.state === "KNOWN_BLOCK"
      && canonicalBlockId(targetCell.block_state) === expectation.expectedTarget.blockId;

  if (!commonPasses || !branchPasses) {
    throw new Error(`fresh ${expectation.id} conformance failed: ${JSON.stringify({
      result, requests, tunneled, expectedBroken, physical,
      findCalls: findCalls.length, breakCalls: breakCalls.length,
      gotoCalls: gotoCalls.length, frontierCalls: frontierCalls.length,
    })}`);
  }
}

export const tunnelFrontierEarlyStopScenario = {
  id: "tunnel-frontier-early-stop" as const,
  run: (context: ScenarioRunContext) => runTunnelBranch(context, {
    id: "tunnel-frontier-early-stop",
    blockIdGlob: "minecraft:iron_ore",
    expectedTarget: {
      blockId: "minecraft:iron_ore",
      position: { x: 4, y: 101, z: 1 },
    },
  }),
};

export const tunnelBoundedNotFoundScenario = {
  id: "tunnel-bounded-not-found" as const,
  run: (context: ScenarioRunContext) => runTunnelBranch(context, {
    id: "tunnel-bounded-not-found",
    blockIdGlob: "minecraft:emerald_ore",
  }),
};
