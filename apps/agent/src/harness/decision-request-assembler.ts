import type { RuntimeBodyState } from "@evicraft/runtime-sdk";
import type { AbilityExecutionContext, AbilityRuntime } from "./ability-runtime.js";
import { canonicalBlockId } from "./canonical-registry-id.js";
import type { ToolMode } from "./config.js";
import { isSemanticMenuKind } from "./semantic-menu.js";
import { textMessage, type ModelMessage } from "./model-surface-message.js";
import { unavailableToolsForMenu } from "./menu-tool-availability.js";
import { programmaticCodeContract } from "./programmatic-code-contract.js";
import {
  normalizeTurnObservation,
  projectObserveSelfResult,
  renderTurnObservation,
  type ItemSummary,
  type ObserveSelfResult,
  type ObserveSelfSuccessData,
  type TurnObservation,
} from "./turn-observation.js";

export interface DecisionRequestSection {
  readonly title: string;
  readonly summary?: string;
  readonly body: string;
}

export interface OperatingContractProjection {
  readonly message: ModelMessage;
  readonly wireText: string;
  readonly sections: readonly DecisionRequestSection[];
}

export interface DecisionContextProjection {
  readonly message: ModelMessage;
  readonly historyMessage: ModelMessage;
  readonly wireText: string;
  readonly sections: readonly DecisionRequestSection[];
}

/**
 * Hazard reasons that have no committed INTERRUPTED Tool result to ride on
 * (initial hazard at run start, hazard arriving between cycles, or a hazard
 * that discarded the model request phase). Reasons absorbed by a committed
 * INTERRUPTED result must not reappear here.
 */
export interface DecisionContextTrigger {
  readonly hazard_reasons: readonly string[];
}

export function operatingContract(input: Readonly<{
  mode: ToolMode;
  runtime: AbilityRuntime;
  projectSkills: readonly Readonly<{ name: string; description: string }> [];
  /** The run exposes capture_view. */
  vision: boolean;
}>): OperatingContractProjection {
  const modeRules = input.mode === "code"
    ? programmaticCodeContract.renderSystemPromptContribution(input.runtime.typescriptSdk())
    : "Native Mode is fixed for this Harness Run. Call exactly one exposed Tool.";
  const projectSkillRules = "Each Skill's description says when it applies. Before starting work that matches a description, call load_skill with that exact name; the loaded body is not repeated later, so reload it after a long gap. If none applies, continue without loading.";
  const projectSkillCatalog = JSON.stringify(input.projectSkills);
  const harnessRules = [
    modeRules,
    ...(input.vision ? [VISION_RULE] : []),
    "Assertions supplied in pre-step context are not World Facts.",
  ].join("\n");
  const wireText = `<project_skills>\n${projectSkillRules}\n${projectSkillCatalog}\n</project_skills>`
    + `\n<harness_contract>\n${harnessRules}\n</harness_contract>`;
  const sections: readonly DecisionRequestSection[] = [
    {
      title: "Project Skills",
      body: `${projectSkillRules}\n${input.projectSkills.length === 0 ? "none" : JSON.stringify(input.projectSkills, null, 2)}`,
    },
    {
      title: "Harness Contract",
      ...(input.mode === "code" ? {
        summary: `Generated Code SDK · ${input.runtime.names.length} abilities · ${modeRules.split("\n").length} lines`,
      } : {}),
      body: harnessRules,
    },
  ];
  return { message: textMessage("system", wireText), wireText, sections };
}

const VISION_RULE = "capture_view shows what the Bot currently sees as a first-person image, which the text observation does not. Use it when seeing the surroundings would help a decision.";

export function decisionContext(input: Readonly<{
  cycle: number;
  agentContext: Readonly<{
    revision: 0;
    assertions: readonly Readonly<{ readonly id: string; readonly text: string }> [];
  }>;
  agentPlan: Readonly<{ revision: number; items: readonly unknown[] }>;
  navigationPolicy: Record<string, unknown>;
  runtimeOccurrences: readonly Readonly<Record<string, unknown>>[];
  renderedObservation: string;
  trigger?: DecisionContextTrigger;
}>): DecisionContextProjection {
  const historicalContext = {
    external_assertions: input.agentContext,
    agent_plan: input.agentPlan,
    navigation_policy: input.navigationPolicy,
    runtime_occurrences: input.runtimeOccurrences,
    ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
  };
  const render = (context: Record<string, unknown>) =>
    `<minecraft_pre_step_context source="fresh">\n${JSON.stringify(context)}\n</minecraft_pre_step_context>`;
  const wireText = render({ ...historicalContext, turn_observation: input.renderedObservation });
  const sections: readonly DecisionRequestSection[] = [
    { title: "External Assertions", body: JSON.stringify(input.agentContext, null, 2) },
    { title: "Agent Plan", body: JSON.stringify(input.agentPlan, null, 2) },
    { title: "Navigation Policy", body: JSON.stringify(input.navigationPolicy, null, 2) },
    {
      title: "Turn Trigger Context",
      body: input.trigger === undefined && input.runtimeOccurrences.length === 0
        ? "none" : JSON.stringify({
          runtime_occurrences: input.runtimeOccurrences,
          ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
        }, null, 2),
    },
    { title: "Turn Observation", body: input.renderedObservation },
  ];
  return {
    message: textMessage("user", wireText),
    historyMessage: textMessage("user", render(historicalContext)),
    wireText,
    sections,
  };
}

export async function assembleFreshObservation(
  runtime: AbilityRuntime,
  context: AbilityExecutionContext,
): Promise<Readonly<{
  self: ObserveSelfResult;
  hazardBody: RuntimeBodyState;
  observation: TurnObservation;
  rendered: string;
  navigationPolicy: Record<string, unknown>;
}>> {
  const [selfResult, inventoryResult, menuResult, blocksResult, entitiesResult, policyResult] = await Promise.all([
    runtime.dispatch("observe_self", {}, context),
    runtime.dispatch("observe_inventory", {}, context),
    runtime.dispatch("observe_menu", {}, context),
    runtime.dispatch("observe_blocks", { radius: 4 }, context),
    runtime.dispatch("observe_entities", {}, context),
    runtime.dispatch("manage_scaffold_materials", {}, context),
  ]);
  const selfData = canonicalData(selfResult, "observe_self") as ObserveSelfSuccessData;
  const inventoryData = optionalCanonicalData(inventoryResult);
  const menuData = optionalCanonicalData(menuResult);
  const blocksData = optionalCanonicalData(blocksResult);
  const entitiesData = optionalCanonicalData(entitiesResult);
  const navigationPolicy = canonicalData(policyResult, "manage_scaffold_materials");
  const self = projectObserveSelfResult(selfData);
  const inventoryItems = inventoryData === undefined || !Array.isArray(inventoryData.items)
    ? [] : inventoryData.items.map(itemSummaryFromRuntime);
  const menuProjection = menuData === undefined
    ? { kind: "unavailable" as const, error: "INTERNAL_ERROR" as const }
    : semanticMenuObservation(menuData);
  const perceivedBlocks = blocksData === undefined ? [] : blockRegionProjection(blocksData);
  const perceivedEntities = entitiesData === undefined ? [] : entityTrackProjection(entitiesData);
  const observation = normalizeTurnObservation({
    self: {
      dimension: self.dimension,
      feet: self.feet,
      facing: self.facing,
      health: self.health,
      maxHealth: self.max_health,
      food: self.food,
      airSeconds: self.air / 20,
      maxAirSeconds: self.max_air / 20,
      onGround: self.on_ground,
      inWater: self.in_water,
      underwater: self.underwater,
      inLava: self.in_lava,
      onFire: self.on_fire,
      mainHand: equipmentItem(self.main_hand),
      activeEffects: self.active_effects.map((effect) => ({
        effectId: effect.effect_id,
        amplifier: effect.amplifier,
        remainingSeconds: effect.duration_ticks / 20,
      })),
    },
    inventory: inventoryData !== undefined ? {
      location: "player_inventory",
      items: inventoryItems,
    } : {
      location: "player_inventory", items: [], unavailableError: "INTERNAL_ERROR",
    },
    menu: menuProjection,
    perceivedBlocks: blocksData === undefined
      ? { blocks: [], truncated: false, unavailableError: "INTERNAL_ERROR" }
      : { blocks: perceivedBlocks, truncated: blocksData.complete !== true, provenance: {
        consistency: "independent_reads", dimension: blocksData.dimension,
        min: blocksData.min, size: blocksData.size,
        evidence: Array.isArray(blocksData.palette) ? blocksData.palette.map((entry) => {
          const value = objectOrEmpty(entry);
          return { state: value.state, source: value.source, observed_tick: value.observed_tick,
            observation_revision: value.observation_revision };
        }) : [],
      } },
    perceivedEntities: entitiesData === undefined
      ? { entities: [], truncated: false, unavailableError: "INTERNAL_ERROR" }
      : { entities: perceivedEntities, truncated: entitiesData.has_more === true, provenance: {
        consistency: "independent_reads", scope: "bounded_current_dimension_tracks",
        evidence: Array.isArray(entitiesData.tracks) ? entitiesData.tracks.map((entry) => {
          const value = objectOrEmpty(entry);
          return { id: value.uuid, dimension: value.dimension, source: value.source,
            observed_tick: value.observed_tick, observation_revision: value.observation_revision };
        }) : [],
      } },
    unavailableTools: menuData !== undefined && isSemanticMenuKind(menuData.menu_type)
      ? unavailableToolsForMenu(menuData.menu_type, new Set(runtime.names))
      : [],
  });
  const rendered = renderTurnObservation(observation);
  return { self, observation, rendered, navigationPolicy, hazardBody: {
    health: self.health, max_health: self.max_health, air: self.air, max_air: self.max_air,
    underwater: self.underwater, in_lava: self.in_lava, on_fire: self.on_fire,
    suffocating: selfData.suffocating, intersecting_blocks: selfData.intersecting_blocks,
  } };
}

function canonicalData(value: unknown, ability: string): Record<string, unknown> {
  const result = objectOrEmpty(value);
  if (result.ok !== true) {
    throw new Error(`${ability} failed: ${typeof result.message === "string" ? result.message : "Runtime failure"}`);
  }
  return objectOrEmpty(result.data);
}

function optionalCanonicalData(value: unknown): Record<string, unknown> | undefined {
  const result = objectOrEmpty(value);
  return result.ok === true ? objectOrEmpty(result.data) : undefined;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function vector(value: unknown, integer: boolean): { x: number; y: number; z: number } {
  const item = objectOrEmpty(value);
  const output = {
    x: requiredNumber(item.x, "vector.x"),
    y: requiredNumber(item.y, "vector.y"),
    z: requiredNumber(item.z, "vector.z"),
  };
  if (integer && !Object.values(output).every(Number.isSafeInteger)) throw new Error("feet must be integers");
  return output;
}

function itemSummaryFromRuntime(value: unknown): ItemSummary {
  const item = objectOrEmpty(value);
  return {
    itemId: requiredText(item.item_id, "item_id"),
    count: requiredNumber(item.count, "count"),
  };
}

function blockRegionProjection(data: Record<string, unknown>): Array<{ blockId: string; position: { x: number; y: number; z: number } }> {
  const min = vector(data.min, true);
  const size = vector(data.size, true);
  const palette = Array.isArray(data.palette) ? data.palette.map(objectOrEmpty) : [];
  const indices = Array.isArray(data.indices) ? data.indices : [];
  const blocks: Array<{ blockId: string; position: { x: number; y: number; z: number } }> = [];
  indices.forEach((paletteIndex, index) => {
    if (!Number.isSafeInteger(paletteIndex)) return;
    const entry = palette[Number(paletteIndex)];
    if (entry?.state !== "KNOWN_BLOCK" || typeof entry.block_state !== "string") return;
    const x = index % size.x;
    const y = Math.floor(index / size.x) % size.y;
    const z = Math.floor(index / (size.x * size.y));
    blocks.push({ blockId: canonicalBlockId(entry.block_state), position: { x: min.x + x, y: min.y + y, z: min.z + z } });
  });
  return blocks;
}

function entityTrackProjection(data: Record<string, unknown>): Array<{
  id: string; entityType: string; position: { x: number; y: number; z: number };
  trackState: "VISIBLE" | "RECENT"; ageSeconds: number; item?: { itemId: string; count: number };
}> {
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  return tracks.map((value) => {
    const track = objectOrEmpty(value);
    return {
      id: requiredText(track.uuid, "entity.uuid"),
      entityType: requiredText(track.entity_id, "entity.entity_id"),
      position: vector(track.position, false),
      trackState: track.state === "VISIBLE" ? "VISIBLE" as const : "RECENT" as const,
      ageSeconds: 0,
      ...(typeof track.item_id === "string" ? {
        item: { itemId: track.item_id, count: typeof track.item_count === "number" ? track.item_count : 1 },
      } : {}),
    };
  });
}

function equipmentItem(item: ObserveSelfResult["main_hand"]): ItemSummary | null {
  if (item === null) return null;
  return {
    itemId: item.item_id,
    count: item.count,
    ...(item.max_damage <= 0 ? {} : {
      durability: { remaining: item.max_damage - item.damage, maximum: item.max_damage },
    }),
  };
}

function semanticMenuObservation(menu: Record<string, unknown>): TurnObservation["menu"] {
  switch (menu.menu_type) {
    case "none": return { kind: "none" };
    case "unsupported": return { kind: "unsupported" };
    case "crafting_table": return { kind: "crafting_table", surface: "3x3" };
    case "storage": return {
      kind: "storage",
      totalSlots: requiredNumber(menu.total_slots, "menu.total_slots"),
      occupiedSlots: requiredNumber(menu.occupied_slots, "menu.occupied_slots"),
      emptySlots: requiredNumber(menu.empty_slots, "menu.empty_slots"),
    };
    case "furnace": return {
      kind: "furnace",
      input: menuItem(menu.input), fuel: menuItem(menu.fuel), output: menuItem(menu.output),
      burning: menu.burning === true,
      cookProgressSeconds: requiredNumber(menu.cook_progress_seconds, "menu.cook_progress_seconds"),
      cookTotalSeconds: requiredNumber(menu.cook_total_seconds, "menu.cook_total_seconds"),
    };
    default: return { kind: "unsupported" };
  }
}

function menuItem(value: unknown): ItemSummary | null {
  if (value === null || value === undefined) return null;
  return itemSummaryFromRuntime(value);
}
