import { runScenarioHarness as runHarness } from "./shared.js";
import { setTimeout as delay } from "node:timers/promises";

import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, intervene, lastAbilityResult, borrowedScenarioRuntimeSession, record,
  samePosition, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

const NETHER_TARGET = { x: 4, y: 101, z: 0 } as const;

async function runCrossDimensionTaskSwitch(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  const netherFixture = manifest.fixtures.nether_target;
  if (netherFixture?.dimension !== "minecraft:the_nether") {
    throw new Error("cross-dimension scenario omitted its Nether fixture");
  }
  let requests = 0;
  let phase: "prepare" | "switch" | "end" = "prepare";
  let switchIntervention: Promise<void> | undefined;
  const started: Array<Extract<HarnessProgressEvent, { type: "ability_call_started" }>> = [];
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (phase === "prepare") {
        assertInitialObservation(request, manifest);
        switchIntervention = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            void intervene(context, "teleport the Runtime Bot to the sealed Nether target area",
              "execute in minecraft:the_nether run tp bot 0.5 101 0.5")
              .then(resolve, reject);
          }, 300);
        });
        phase = "switch";
        return scriptedToolDecision("run-cross-dimension-switch", "run_code", {
          description: "Start a long Overworld navigation, then continue with a fresh Nether task after the test-owned teleport",
          code: [
            "const overworld = await abilities.goto({ x: 80, y: 101, z: 0, route_mutation_permissions: [] });",
            "const status = await abilities.observe_self({});",
            "if (!status.ok || status.data.dimension !== 'minecraft:the_nether') return { overworld, status };",
            `const target = await abilities.observe_block(${JSON.stringify(NETHER_TARGET)});`,
            `const nether = await abilities.goto({ x: ${NETHER_TARGET.x}, y: ${NETHER_TARGET.y}, z: ${NETHER_TARGET.z}, route_mutation_permissions: [] });`,
            "return { overworld, status, target, nether };",
          ].join("\n"),
        });
      }
      if (phase === "end") return scriptedScenarioEnd();
      phase = "end";
      await delay(50);
      return scriptedToolDecision("continue-cross-dimension-switch", "run_code", {
        description: "Continue the task after the dimension switch",
        code: "return await abilities.wait({ seconds: 0.1 });",
      });
    },
  });

  const result = await runHarness({
    agentContext: staticGoalContext("Resume after a dimension switch and navigate to the observed Nether gold-block target."),
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model, modelLimits: model.limits, hazardDecisions: "disabled",
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });
  await switchIntervention;
  const status = await client.toolCall("get_self_status", {});
  const netherGoto = lastAbilityResult(finished, "goto", (candidate) => candidate.ok === true
    && Number(candidate.data?.position?.x) >= NETHER_TARGET.x - 0.75);
  const netherObservation = finished.find((event) => event.ability === "observe_block"
    && (event.result as any)?.ok === true && (event.result as any).data?.cells?.some((cell: any) =>
      cell.dimension === "minecraft:the_nether" && samePosition(cell.position, NETHER_TARGET)));
  const overworldGoto = started.find((event) => event.ability === "goto"
    && record(event.input).x === 80);
  const finalFeet = status.data?.feet as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const netherBlock = await client.blockGet("minecraft:the_nether", [NETHER_TARGET]);

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests < 2
      || overworldGoto === undefined || netherObservation === undefined
      || status.success !== true || status.data?.dimension !== "minecraft:the_nether"
      || finalFeet === undefined || Number(finalFeet.x) < NETHER_TARGET.x - 1
      || netherGoto?.ok !== true || netherBlock.cells[0]?.state !== "KNOWN_BLOCK"
      || netherBlock.cells[0]?.block_state !== "minecraft:gold_block") {
    throw new Error(`fresh cross-dimension task switch conformance failed: ${JSON.stringify({
      result, requests, overworldGoto, netherObservation, netherGoto, status, netherBlock,
    })}`);
  }
}

export const crossDimensionTaskSwitchScenario = {
  id: "cross-dimension-task-switch" as const,
  run: runCrossDimensionTaskSwitch,
};
