import { runScenarioHarness as runHarness } from "./shared.js";
import {
  ScriptedLanguageModel,
  type ScriptedModelCall,
} from "../../harness/testing/scripted-language-model.js";
import {
  staticGoalContext,
  type HarnessProgressEvent,
} from "../../harness/run-harness.js";
import {
  assertInitialObservation,
  intervene,
  lastAbilityResult,
  borrowedScenarioRuntimeSession,
  record,
  samePosition,
  scriptedScenarioEnd, scriptedToolDecision,
  smokeHarnessConfig,
  type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL =
  "Escape the sealed obstructed spawn and verify a usable pose.";

async function runSuffocationEscape(
  context: ScenarioRunContext,
): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } =
    context;
  const spawn = manifest.sharedSpawn;
  const head = { ...spawn, y: spawn.y + 1 };

  let requests = 0;
  let setupPending = true;
  let cancellations = 0;
  const started: Array<
    Extract<HarnessProgressEvent, { type: "ability_call_started" }>
  > = [];
  const finished: Array<
    Extract<HarnessProgressEvent, { type: "ability_call_finished" }>
  > = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall, _index, modelContext) => {
      requests += 1;
      if (setupPending) {
        setupPending = false;
        assertInitialObservation(request, manifest);
        // Seal the surroundings while the eye can still see them, so the Bot knows them as
        // stone; once the head cell is stone the eye sees nothing and memory goes stale.
        for (const [label, position] of [
          ["north feet", { ...spawn, z: spawn.z - 1 }],
          ["east feet", { ...spawn, x: spawn.x + 1 }],
          ["south feet", { ...spawn, z: spawn.z + 1 }],
          ["west feet", { ...spawn, x: spawn.x - 1 }],
          ["north head", { ...head, z: head.z - 1 }],
          ["east head", { ...head, x: head.x + 1 }],
          ["south head", { ...head, z: head.z + 1 }],
          ["west head", { ...head, x: head.x - 1 }],
          ["feet", spawn],
          ["head", head],
        ] as const) {
          await intervene(context,
            `prepare suffocation ${label} obstruction`,
            `setblock ${position.x} ${position.y} ${position.z} minecraft:stone`,
          );
        }
        await intervene(context,
          "embed the Runtime Bot in the prepared head obstruction",
          `tp bot ${spawn.x + 0.5} ${spawn.y} ${spawn.z + 0.5}`,
        );
        const deadline = Date.now() + 5_000;
        let status = await client.toolCall("get_self_status", {});
        while (Date.now() < deadline && status.data?.suffocating !== true) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          status = await client.toolCall("get_self_status", {});
        }
        if (status.data?.suffocating !== true) {
          throw new Error(`suffocation setup did not settle at shared spawn: ${JSON.stringify(status)}`);
        }
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            cancellations += 1;
            reject(modelContext.signal?.reason ?? new Error("Suffocation hazard preempted model"));
          };
          if (modelContext.signal?.aborted === true) abort();
          else modelContext.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (requests === 2) {
        if (!JSON.stringify(request.messages).includes("suffocation")) throw new Error("next decision lacks suffocation context");
        return scriptedToolDecision("model-chosen-suffocation-escape", "suffocation_escape", {});
      }
      return scriptedScenarioEnd();
    },
  });
  const result = await runHarness({
    agentContext: staticGoalContext(HARNESS_RUN_GOAL),
    config: {
      ...smokeHarnessConfig(runtimeUrl, artifactsDirectory),
      mode: "native",
    },
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    languageModel: model,
    modelLimits: model.limits,
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });
  const escape = lastAbilityResult(finished, "suffocation_escape");
  const runDirectory = (await readdir(artifactsDirectory, { withFileTypes: true }))
    .find((entry) => entry.isDirectory())?.name;
  const events = runDirectory === undefined ? [] : (await readFile(
    join(artifactsDirectory, runDirectory, "events.jsonl"), "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const finalStatus = await client.toolCall("get_self_status", {});
  const headEvidence = await client.blockGet("minecraft:overworld", [head]);
  const broken = Array.isArray(escape?.data?.broken_blocks)
    ? escape.data.broken_blocks
    : [];
  const finalFeet = record(finalStatus.data).feet;
  if (
    result.status !== "ended" ||
    result.endReason !== "external_stop" ||
    requests !== 3 ||
    cancellations !== 1 ||
    events.filter((event) => event.type === "hazard_detected"
      && Array.isArray(event.reasons) && event.reasons.includes("suffocation")).length !== 1
    || started.some((event) => event.source === "harness") ||
    escape?.ok !== true ||
    escape.data?.escape_method !== "fallback" ||
    !samePosition(escape.data?.final_feet, finalFeet) ||
    !broken.some((position: typeof head) => samePosition(position, head)) ||
    finalStatus.success !== true ||
    finalStatus.data?.suffocating !== false ||
    headEvidence.cells[0]?.state !== "KNOWN_AIR" ||
    started.filter((event) => event.ability === "break_block").length < 1 ||
    started.some((event) => event.ability === "collect_items")
  ) {
    throw new Error(
      `fresh suffocation escape conformance failed: ${JSON.stringify({
        result,
        requests,
        cancellations,
        escape,
        finalStatus,
        headEvidence,
        started,
      })}`,
    );
  }
}

export const suffocationEscapeScenario = {
  id: "suffocation-escape" as const,
  run: runSuffocationEscape,
};
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
