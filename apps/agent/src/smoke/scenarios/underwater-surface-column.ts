import { setTimeout as delay } from "node:timers/promises";

import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, intervene, lastAbilityResult, borrowedScenarioRuntimeSession,
  scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, waitForLogText, ensureScenarioBot, runScenarioHarness,
  type ScenarioRunContext,
} from "./shared.js";

const TELEPORT_RECEIPT = "ABILITY_CONFORMANCE_UNDERWATER_READY";

async function runUnderwaterSurfaceColumn(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  let requests = 0;
  const started: Array<Extract<HarnessProgressEvent, { type: "ability_call_started" }>> = [];
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (requests > 2) return scriptedScenarioEnd();
      if (requests === 1) {
        assertInitialObservation(request, manifest);
        return scriptedToolDecision("wait-for-underwater-hazard", "run_code", {
          description: "Remain underwater until a low-air decision interrupts the bounded wait",
          code: "await abilities.wait({ seconds: 60 }); return { waitCompleted: true };",
        });
      }
      if (!JSON.stringify(request.messages).includes("low_air")) throw new Error("low-air interruption did not reach the model");
      return scriptedToolDecision("run-underwater-surface", "run_code", {
        description: "Observe the underwater body, ascend through the registered surface Composite, and verify breathable air",
        code: [
          "const before = await abilities.observe_self({});",
          "if (!before.ok || !before.data.underwater) return { before };",
          "const surfaced = await abilities.surface({});",
          "const after = await abilities.observe_self({});",
          "return { before, surfaced, after };",
        ].join("\n"),
      });
    },
  });

  await ensureScenarioBot(client);
  await intervene(context, "move Runtime Bot to the sealed water-column floor", "tp bot 0.5 101 0.5");
  await intervene(context, "confirm underwater fixture placement", `say ${TELEPORT_RECEIPT}`);
  await waitForLogText(`${artifactsDirectory}/server.log`, TELEPORT_RECEIPT);
  const deadline = Date.now() + 5_000;
  let underwater = false;
  do {
    const status = await client.toolCall("get_self_status", {});
    underwater = status.success === true && status.data?.underwater === true;
    if (!underwater) await delay(50);
  } while (!underwater && Date.now() < deadline);
  if (!underwater) throw new Error("water-column fixture did not settle underwater");
  const result = await runScenarioHarness({
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    hazardDecisions: "enabled",
    languageModel: model,
    modelLimits: model.limits,
    agentContext: staticGoalContext("Ascend from the sealed water-column floor until body evidence confirms breathable air."),
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });

  const surfaced = lastAbilityResult(finished, "surface");
  const selfResults = finished.filter((event) => event.source === "agent"
    && event.ability === "observe_self").map((event) => event.result as any);
  const before = selfResults[0];
  const after = selfResults.at(-1);
  const gotoCalls = started.filter((event) => event.source === "agent" && event.ability === "goto");
  const mutations = new Set(["break_block", "place_block", "use_item_on_block"]);
  const finalStatus = await client.toolCall("get_self_status", {});
  const finalAir = parseAir(String(finalStatus.data?.air));
  const initialAir = parseAir(String(before?.data?.air));
  const finalFeet = finalStatus.data?.feet as { y?: unknown } | undefined;

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 3
      || before?.ok !== true || before.data?.underwater !== true
      || surfaced?.ok !== true || Number(surfaced.data?.ascent_steps) < 1
      || after?.ok !== true || after.data?.underwater !== false
      || gotoCalls.length !== surfaced.data?.ascent_steps
      || started.some((event) => event.source === "agent" && mutations.has(event.ability))
      || started.some((event) => event.source === "harness")
      || finalStatus.success !== true || finalStatus.data?.underwater !== false
      || Number(finalFeet?.y) < 105
      || finalAir.current <= initialAir.current || finalAir.maximum !== initialAir.maximum) {
    throw new Error(`fresh underwater surface conformance failed: ${JSON.stringify({
      result, requests, before, surfaced, after, gotoCalls, finalStatus, initialAir, finalAir,
    })}`);
  }
}

function parseAir(value: string): { current: number; maximum: number } {
  const match = /^(\d+)\/(\d+)/u.exec(value);
  return match === null
    ? { current: -1, maximum: -2 }
    : { current: Number(match[1]), maximum: Number(match[2]) };
}

export const underwaterSurfaceColumnScenario = {
  id: "underwater-surface-column" as const,
  run: runUnderwaterSurfaceColumn,
};
