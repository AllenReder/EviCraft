import { runScenarioHarness as runHarness } from "./shared.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, intervene, borrowedScenarioRuntimeSession, runtimeInventoryCount,
  samePosition, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, waitForLogText,
  type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL =
  "Recover from one changed remembered diamond-ore target and collect the remaining candidate.";
const TARGET_CHANGED_RECEIPT = "ABILITY_CONFORMANCE_STALE_TARGET_CHANGED";

async function runStaleTargetRecovery(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  let requests = 0;
  let phase: "prepare" | "stage" | "recover" | "end" = "prepare";
  const timeline: HarnessProgressEvent[] = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      const staleTarget = manifest.fixtures.stale_target?.position;
      const remainingTarget = manifest.fixtures.remaining_target?.position;
      if (staleTarget === undefined || remainingTarget === undefined) {
        throw new Error("stale-target scenario omitted one of its exact ore fixtures");
      }
      if (phase === "prepare") {
        assertInitialObservation(request, manifest);
        await intervene(context, "prepare an exact harvesting implement",
          "item replace entity bot hotbar.0 with minecraft:diamond_pickaxe 1");
        phase = "stage";
        return scriptedToolDecision("settle-stale-target-implement", "run_code", {
          description: "Wait for the prepared harvesting inventory to settle",
          code: "return await abilities.wait({ seconds: 1 });",
        });
      }
      if (phase === "stage") {
        phase = "recover";
        return scriptedToolDecision("stage-outside-stale-target-vision", "run_code", {
          description: "Retain remembered ore evidence while leaving both targets outside direct perception",
          code: "return await abilities.goto({ x: -10, y: 101, z: 0, route_mutation_permissions: [] });",
        });
      }
      if (phase === "end") return scriptedScenarioEnd();

      await intervene(context, "remove the nearer remembered ore",
        `setblock ${staleTarget.x} ${staleTarget.y} ${staleTarget.z} minecraft:air`);
      await intervene(context, "confirm the stale target world change",
        `say ${TARGET_CHANGED_RECEIPT}`);
      await waitForLogText(`${artifactsDirectory}/server.log`, TARGET_CHANGED_RECEIPT);
      phase = "end";
      return scriptedToolDecision("run-stale-target-recovery", "run_code", {
        description: "Use structured changed-target progress to requery and collect the surviving ore",
        code: [
          `const stale = await abilities.collect_blocks({ positions: [${JSON.stringify(staleTarget)}] });`,
          "if (stale.ok || stale.data.skipped_positions?.[0]?.failure_type !== 'changed') return { stale };",
          "const refreshed = await abilities.find_known_blocks({ block_id_glob: 'minecraft:diamond_ore' });",
          "if (!refreshed.ok) return { stale, refreshed };",
          "const recovered = await abilities.collect_blocks({ block_id_glob: 'minecraft:diamond_ore', count: 1 });",
          "return { stale, refreshed, recovered };",
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
    onProgress(event) { timeline.push(event); },
  });

  const staleTarget = manifest.fixtures.stale_target?.position;
  const remainingTarget = manifest.fixtures.remaining_target?.position;
  if (staleTarget === undefined || remainingTarget === undefined) {
    throw new Error("stale-target scenario omitted one of its exact ore fixtures");
  }
  const collectStarts = timeline.filter((event): event is Extract<HarnessProgressEvent,
    { type: "ability_call_started" }> => event.type === "ability_call_started"
      && event.ability === "collect_blocks");
  const collectFinishes = timeline.filter((event): event is Extract<HarnessProgressEvent,
    { type: "ability_call_finished" }> => event.type === "ability_call_finished"
      && event.ability === "collect_blocks");
  const stale = collectFinishes[0]?.result as any;
  const recovered = collectFinishes[1]?.result as any;
  const firstFinishedAt = timeline.indexOf(collectFinishes[0]!);
  const explicitRefreshAt = timeline.findIndex((event, index) => index > firstFinishedAt
    && event.type === "ability_call_started" && event.ability === "find_known_blocks"
    && event.parentExecutionId === collectStarts[0]?.parentExecutionId);
  const secondStartedAt = timeline.indexOf(collectStarts[1]!);
  const staleBreakAttempts = timeline.filter((event) => event.type === "ability_call_started"
    && event.ability === "goto_and_break_block"
    && samePosition((event.input as any).position, staleTarget)).length;
  const physical = await client.blockGet("minecraft:overworld", [staleTarget, remainingTarget]);
  const diamonds = await runtimeInventoryCount(client, "minecraft:diamond");

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 4
      || collectStarts.length !== 2 || collectFinishes.length !== 2
      || stale?.ok !== false || stale.data?.completed_blocks !== 0
      || stale.data?.skipped_positions?.length !== 1
      || stale.data.skipped_positions[0]?.failure_type !== "changed"
      || !samePosition(stale.data.skipped_positions[0]?.position, staleTarget)
      || recovered?.ok !== true || recovered.data?.completed_blocks !== 1
      || recovered.data?.broken_blocks !== 1
      || recovered.data?.collected_items?.["minecraft:diamond"] !== 1
      || recovered.data?.unresolved_observed_drops?.length !== 0
      || !recovered.data?.completed_positions?.some((position: any) =>
        samePosition(position, remainingTarget))
      || explicitRefreshAt <= firstFinishedAt || explicitRefreshAt >= secondStartedAt
      || staleBreakAttempts > 1 || physical.cells.some((cell) => cell.state !== "KNOWN_AIR")
      || diamonds !== 1) {
    throw new Error(`fresh stale-target recovery conformance failed: ${JSON.stringify({
      result, requests, stale, recovered, explicitRefreshAt, firstFinishedAt, secondStartedAt,
      staleBreakAttempts, physical, diamonds, collectStarts,
    })}`);
  }
}

export const staleTargetRecoveryScenario = {
  id: "stale-target-recovery" as const,
  run: runStaleTargetRecovery,
};
