import { ScriptedLanguageModel, type ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import {
  assertInitialObservation, lastAbilityResult, borrowedScenarioRuntimeSession, observedPositions,
  intervene, record, scriptedScenarioEnd, scriptedToolDecision, smokeHarnessConfig, assertScenarioOracle,
  ensureScenarioBot, runScenarioHarness, type ScenarioRunContext,
} from "./shared.js";

const HARNESS_RUN_GOAL = "Explore the nearby surface and return to the exact starting Feet Cell.";
const PICKAXE_WITNESS_NAME = "exploration durability witness";
const PICKAXE_WITNESS_DAMAGE = 17;
type RuntimeToolResult = Awaited<ReturnType<ScenarioRunContext["client"]["toolCall"]>>;
type RawTool = Readonly<{
  slot: number | undefined;
  item: unknown;
  damage: unknown;
  maxDamage: unknown;
  customName: unknown;
}>;

type ExcursionScenarioOptions = Readonly<{
  maxOutboundDisplacement?: number;
  requireBranchRecovery?: boolean;
}>;

export async function runExploreAndReturnSurface(context: ScenarioRunContext): Promise<void> {
  await runExplorationExcursionScenario(context);
}

export async function runExplorationExcursionScenario(
  context: ScenarioRunContext,
  options: ExcursionScenarioOptions = {},
): Promise<void> {
  const maxOutboundDisplacement = options.maxOutboundDisplacement ?? 12;
  const { client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server } = context;
  let requests = 0;
  let initialInventory: RuntimeToolResult | undefined;
  let initialStatus: RuntimeToolResult | undefined;
  let initialScaffold: RuntimeToolResult | undefined;
  const started: Array<Extract<HarnessProgressEvent, { type: "ability_call_started" }>> = [];
  const finished: Array<Extract<HarnessProgressEvent, { type: "ability_call_finished" }>> = [];
  const model = new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000 },
    respond: async (request: ScriptedModelCall) => {
      requests += 1;
      if (requests > 1) return scriptedScenarioEnd();
      assertInitialObservation(request, manifest);
      if (observedPositions(request, "minecraft:emerald_block").length !== 0) {
        throw new Error("surface hidden marker leaked into initial Agent observation");
      }
      return scriptedToolDecision("run-explore-surface", "run_code", {
        description: "Run the fixed-seed non-destructive Exploration Excursion",
        code: `return await abilities.explore_and_return({ max_outbound_displacement: ${maxOutboundDisplacement}, return_to_start: true, route_seed: 5 });`,
      });
    },
  });
  await ensureScenarioBot(client);
  await intervene(context, "seed non-destructive exploration inventory",
    "item replace entity bot inventory.9 with minecraft:dirt 8");
  await intervene(context, "seed an unused durability probe tool",
    "item replace entity bot hotbar.0 with minecraft:iron_pickaxe[minecraft:damage=17,minecraft:custom_name='{\"text\":\"exploration durability witness\"}'] 1");
  await client.toolCall("manage_scaffold_materials", { action: "set", item_id_globs: ["minecraft:dirt"] });
  initialInventory = await client.toolCall("observe_inventory", {});
  initialStatus = await client.toolCall("get_self_status", {});
  initialScaffold = await client.toolCall("manage_scaffold_materials", {});
  const tool = selectedRawTool(initialStatus);
  if (tool.item !== "minecraft:iron_pickaxe" || tool.customName !== PICKAXE_WITNESS_NAME
      || tool.damage !== PICKAXE_WITNESS_DAMAGE || Number(tool.maxDamage) < PICKAXE_WITNESS_DAMAGE + 1
      || !Number.isInteger(tool.slot) || scaffoldStackCount(initialScaffold) !== 8) {
    throw new Error(`could not establish the durability/scaffold witness: ${JSON.stringify({ tool, initialScaffold })}`);
  }
  const result = await runScenarioHarness({
    config: smokeHarnessConfig(runtimeUrl, artifactsDirectory),
    secrets: { modelApiKey: "smoke-script", runtimeBearerToken: bearerToken },
    createRuntimeSession: async () => borrowedScenarioRuntimeSession(client),
    hazardDecisions: "disabled",
    languageModel: model,
    modelLimits: model.limits,
    agentContext: staticGoalContext(HARNESS_RUN_GOAL),
    onProgress(event) {
      if (event.type === "ability_call_started") started.push(event);
      if (event.type === "ability_call_finished") finished.push(event);
    },
  });
  const exploration = lastAbilityResult(finished, "explore_and_return");
  const finalStatus = await client.toolCall("get_self_status", {});
  const finalInventory = await client.toolCall("observe_inventory", {});
  const finalScaffold = await client.toolCall("manage_scaffold_materials", {});
  await assertFixtureStates(context, manifest.fixtures);
  const gotoCalls = started.filter((event) => event.ability === "goto");
  const routeTargets = gotoCalls.map((event) => {
    const input = record(event.input);
    return `${String(input.x)},${String(input.y)},${String(input.z)}`;
  });
  const outboundTargets = routeTargets.slice(0, -1);
  const distinctOutboundTargets = new Set(outboundTargets);
  const revisitedOutboundTarget = outboundTargets.some(
    (target, index) => outboundTargets.indexOf(target) < index,
  );
  const branchRecoveryObserved = options.requireBranchRecovery !== true
    || distinctOutboundTargets.size >= 3 && revisitedOutboundTarget;
  const markerObserved = finished.some((event) => event.ability === "observe_blocks"
    && record(event.result).ok === true
    && regionContains(record(record(event.result).data), manifest.fixtures.hidden_marker!.position));
  const inventoryUnchanged = sameJson(initialInventory?.data, finalInventory.data);
  const initialTool = selectedRawTool(initialStatus);
  const finalTool = rawWitnessTool(finalStatus);
  const durabilityUnchanged = sameJson(toolFacts(initialTool), toolFacts(finalTool));
  const scaffoldUnchanged = scaffoldStackCount(initialScaffold) === 8
    && scaffoldStackCount(finalScaffold) === 8;
  const finalFeet = record(finalStatus.data).feet as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const mutationAbilities = new Set(["break_block", "place_block", "use_item_on_block", "manage_scaffold_materials"]);
  if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 2
      || exploration?.ok !== true
      || exploration.data?.route_seed !== 5
      || exploration.data?.outbound_displacement <= 0
      || exploration.data?.start_feet?.x !== manifest.sharedSpawn.x
      || exploration.data?.start_feet?.y !== manifest.sharedSpawn.y
      || exploration.data?.start_feet?.z !== manifest.sharedSpawn.z
      || finalStatus.success !== true
      || finalFeet?.x !== manifest.sharedSpawn.x
      || finalFeet?.y !== manifest.sharedSpawn.y
      || finalFeet?.z !== manifest.sharedSpawn.z
      || !markerObserved || !inventoryUnchanged || !durabilityUnchanged || !scaffoldUnchanged
      || !branchRecoveryObserved
      || started.some((event) => event.source === "agent" && mutationAbilities.has(event.ability))
      || gotoCalls.length < 2
      || gotoCalls.some((event) => JSON.stringify(record(event.input).route_mutation_permissions)
        !== JSON.stringify(["OPEN"]))) {
    throw new Error(`fresh explore-and-return surface conformance failed: ${JSON.stringify({
      result, requests, exploration, finalStatus, initialTool, finalTool, markerObserved,
      initialScaffold, finalScaffold, inventoryUnchanged,
      durabilityUnchanged, scaffoldUnchanged, branchRecoveryObserved, gotoCalls,
    })}`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectedRawTool(result: RuntimeToolResult | undefined): RawTool {
  const selectedSlot = record(result?.data).selected_hotbar_slot;
  if (!Number.isInteger(selectedSlot)) return emptyRawTool();
  const item = rawToolAtSlot(result, selectedSlot);
  if (item.customName !== PICKAXE_WITNESS_NAME) return emptyRawTool();
  return {
    slot: item.slot,
    item: item.item,
    damage: item.damage,
    maxDamage: item.maxDamage,
    customName: item.customName,
  };
}

function rawWitnessTool(result: RuntimeToolResult | undefined): RawTool {
  const matches = rawInventory(result)
    .filter((entry) => entry.customName === PICKAXE_WITNESS_NAME);
  if (matches.length !== 1) return emptyRawTool();
  const item = matches[0]!;
  return {
    slot: item.slot,
    item: item.item,
    damage: item.damage,
    maxDamage: item.maxDamage,
    customName: item.customName,
  };
}

function rawToolAtSlot(result: RuntimeToolResult | undefined, slot: unknown): RawTool {
  if (!Number.isInteger(slot)) return emptyRawTool();
  const item = rawInventory(result).find((entry) => entry.slot === slot);
  return item === undefined ? emptyRawTool() : item;
}

function rawInventory(result: RuntimeToolResult | undefined): readonly RawTool[] {
  const entries = record(result?.data).raw_inventory;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const item = record(entry);
    return {
      slot: item.slot,
      item: item.item,
      damage: item.damage,
      maxDamage: item.max_damage,
      customName: item.custom_name,
    };
  });
}

function toolFacts(tool: RawTool) {
  return {
    item: tool.item,
    damage: tool.damage,
    maxDamage: tool.maxDamage,
    customName: tool.customName,
  };
}

function emptyRawTool(): RawTool {
  return { slot: undefined, item: undefined, damage: undefined, maxDamage: undefined, customName: undefined };
}

function scaffoldStackCount(result: RuntimeToolResult | undefined): number {
  const entries = record(result?.data).carried_matching_items;
  if (!Array.isArray(entries)) return 0;
  return entries
    .filter((entry) => record(entry).item_id === "minecraft:dirt")
    .reduce((total, entry) => total + Number(record(entry).count), 0);
}

async function assertFixtureStates(
  context: Pick<ScenarioRunContext, "oracle" | "artifactsDirectory">,
  fixtures: ScenarioRunContext["manifest"]["fixtures"],
): Promise<void> {
  for (const [name, fixture] of Object.entries(fixtures)) {
    if (fixture.dimension !== undefined && fixture.dimension !== "minecraft:overworld") continue;
    await assertScenarioOracle(context, `fixture ${name} remains intact`, [
      "execute if block", String(fixture.position.x), String(fixture.position.y), String(fixture.position.z), fixture.blockId,
    ].join(" "));
  }
}

function regionContains(data: Record<string, any>, position: { x: number; y: number; z: number }): boolean {
  const min = record(data.min);
  const size = record(data.size);
  const palette = data.palette;
  const indices = data.indices;
  if (!Array.isArray(palette) || !Array.isArray(indices)) return false;
  const dx = position.x - Number(min.x);
  const dy = position.y - Number(min.y);
  const dz = position.z - Number(min.z);
  if (dx < 0 || dy < 0 || dz < 0 || dx >= Number(size.x)
      || dy >= Number(size.y) || dz >= Number(size.z)) return false;
  const index = dx + Number(size.x) * (dy + Number(size.y) * dz);
  const entry = record(palette[Number(indices[index])]);
  return entry.state === "KNOWN_BLOCK"
    && String(entry.block_state).startsWith("minecraft:emerald_block");
}

export const exploreAndReturnSurfaceScenario = {
  id: "explore-and-return-surface" as const,
  run: runExploreAndReturnSurface,
};
