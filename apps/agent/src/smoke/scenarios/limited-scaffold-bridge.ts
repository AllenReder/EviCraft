import { runScenarioHarness as runHarness } from "./shared.js";
import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, assertScenarioOracle, intervene, lastAbilityResult, borrowedScenarioRuntimeSession,
  runtimeInventoryCount, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL =
  "Cross the sealed trench using only the four prepared cobblestone Scaffold Materials.";
const SCAFFOLD_ITEM = "minecraft:cobblestone";
const WITNESS_ITEM = "minecraft:stone";

async function runLimitedScaffoldBridge(context: ScenarioRunContext): Promise<void> {
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  await assertBridgeFixture(context, "before");
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
        await intervene(context, "prepare exact bridge material budget",
          `item replace entity bot hotbar.0 with ${SCAFFOLD_ITEM} 4`);
        await intervene(context, "prepare unauthorized block witness",
          `item replace entity bot hotbar.1 with ${WITNESS_ITEM} 16`);
        phase = "drive";
        return scriptedToolDecision("settle-limited-bridge-inventory", "run_code", {
          description: "Wait for the prepared bridge inventory to settle",
          code: "return await abilities.wait({ seconds: 1 });",
        });
      }
      if (phase === "end") return scriptedScenarioEnd();
      phase = "end";
      const goal = manifest.fixtures.goal_support?.position;
      if (goal === undefined) throw new Error("limited bridge scenario omitted its goal support");
      return scriptedToolDecision("run-limited-scaffold-bridge", "run_code", {
        description: "Authorize only cobblestone scaffolding and cross the sealed trench",
        code: [
          `const policy = await abilities.manage_scaffold_materials({ action: 'set', item_id_globs: [${JSON.stringify(SCAFFOLD_ITEM)}] });`,
          "if (!policy.ok || policy.data.carried_matching_items?.[0]?.count !== 4) return { policy };",
          `const crossed = await abilities.goto({ x: ${goal.x}, y: ${goal.y + 1}, z: ${goal.z}, route_mutation_permissions: ['PLACE'] });`,
          "const afterPolicy = await abilities.manage_scaffold_materials({});",
          "return { policy, crossed, afterPolicy };",
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
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });

  const crossed: unknown = lastAbilityResult(finished, "goto");
  const policyResults = finished
    .filter((event) => event.source === "agent"
      && event.ability === "manage_scaffold_materials")
    .map((event) => event.result);
  const initialPolicyIsCorrect = isExpectedScaffoldPolicy(policyResults[0], 4);
  const finalPolicyIsEmpty = isExpectedScaffoldPolicy(policyResults[1], 0);
  let finalX: number | undefined;
  if (crossed !== null && typeof crossed === "object" && !Array.isArray(crossed)
      && "ok" in crossed && crossed.ok === true
      && "data" in crossed && crossed.data !== null && typeof crossed.data === "object"
      && !Array.isArray(crossed.data) && "position" in crossed.data) {
    const x = (crossed.data.position as { x?: unknown } | null)?.x;
    if (typeof x === "number") finalX = x;
  }
  const trenchPositions = [6, 7, 8, 9].map((x) => ({ x, y: 99, z: 0 }));
  const trench = await client.blockGet("minecraft:overworld", trenchPositions);
  const placedCells = trench.cells.filter((cell) => cell.state === "KNOWN_BLOCK");
  const remainingScaffold = await runtimeInventoryCount(client, SCAFFOLD_ITEM);
  const remainingWitness = await runtimeInventoryCount(client, WITNESS_ITEM);
  await assertBridgeFixture(context, "after");
  const gotoStart = started.find((event) => event.ability === "goto"
    && event.input !== null && typeof event.input === "object" && !Array.isArray(event.input)
    && "route_mutation_permissions" in event.input
    && Array.isArray(event.input.route_mutation_permissions)
    && event.input.route_mutation_permissions.join(",") === "PLACE");

  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 3
      || !initialPolicyIsCorrect || !finalPolicyIsEmpty || finalX === undefined || finalX < 9.5
      || gotoStart === undefined
      || placedCells.length !== 4
      || placedCells.some((cell) => canonicalBlockId(cell.block_state) !== SCAFFOLD_ITEM)
      || new Set(placedCells.map((cell) => cell.position.x)).size !== 4
      || remainingScaffold !== 0 || remainingWitness !== 16) {
    throw new Error(`fresh limited-scaffold bridge conformance failed: ${JSON.stringify({
      result, requests, crossed, policyResults, gotoStart, placedCells,
      remainingScaffold, remainingWitness,
    })}`);
  }
  process.stdout.write(`${JSON.stringify({
    event: "ability_conformance_bridge_verified",
    fixture: manifest.structureFixture,
    crossed,
    placed_cells: placedCells.map(cell => ({ position: cell.position, block_state: cell.block_state })),
    remaining_scaffold: remainingScaffold,
    remaining_witness: remainingWitness,
    geometry_verified_before_and_after: true,
  })}\n`);
}

/** Test-owned geometry, independent of the Agent's knowledge and route choice. */
async function assertBridgeFixture(context: ScenarioRunContext, phase: "before" | "after"): Promise<void> {
  const check = async (label: string, positions: ReadonlyArray<{ x: number; y: number; z: number }>, block: string) => {
    const predicate = "execute" + positions.map(({ x, y, z }) => ` if block ${x} ${y} ${z} ${block}`).join("");
    await assertScenarioOracle(context, `bridge ${phase}: ${label}`, predicate);
  };
  const column = (x: number, z: number, bottom: number, top: number) =>
    Array.from({ length: top - bottom + 1 }, (_, index) => ({ x, y: bottom + index, z }));
  const gap = [6, 7, 8, 9];
  // V2 left natural leaves directly under its four nominal holes. Check the
  // whole V3 shaft, not just the model-visible top cells or a fixed wait.
  for (const x of gap) {
    await check(`clear shaft x=${x}`, column(x, 0, 86, phase === "before" ? 99 : 98), "minecraft:air");
    for (const z of [-1, 1]) {
      await check(`sealed side x=${x},z=${z}`, column(x, z, 85, 98), "minecraft:bedrock");
    }
  }
  for (const x of [5, 10]) await check(`sealed end x=${x}`, column(x, 0, 85, 98), "minecraft:bedrock");
  await check("sealed floor", gap.map(x => ({ x, y: 85, z: 0 })), "minecraft:bedrock");
  await check("low ceiling", [5, ...gap, 10].map(x => ({ x, y: 102, z: 0 })), "minecraft:bedrock");
}

function isExpectedScaffoldPolicy(value: unknown, expectedCount: number): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || !("ok" in value) || value.ok !== true
      || !("data" in value) || value.data === null || typeof value.data !== "object"
      || Array.isArray(value.data)) {
    return false;
  }
  const data = value.data;
  if (!("item_id_globs" in data) || !("carried_matching_items" in data)) return false;
  const itemIds = data.item_id_globs;
  const carriedItems = data.carried_matching_items;
  if (!Array.isArray(itemIds) || itemIds.length !== 1 || itemIds[0] !== SCAFFOLD_ITEM
      || !Array.isArray(carriedItems)) {
    return false;
  }
  if (expectedCount === 0) return carriedItems.length === 0;
  return carriedItems.length === 1 && carriedItems[0] !== null
    && typeof carriedItems[0] === "object" && "count" in carriedItems[0]
    && carriedItems[0].count === expectedCount;
}


export const limitedScaffoldBridgeScenario = {
  id: "limited-scaffold-bridge" as const,
  run: runLimitedScaffoldBridge,
};
