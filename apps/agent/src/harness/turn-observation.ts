import { canonicalBlockId } from "./canonical-registry-id.js";
import { airSupply, observeSelfOutput } from "./abilities/built-in/observe_self.js";
import type { InferToolSchema } from "./tool-schema.js";

export interface ItemSummary {
  readonly itemId: string;
  readonly count: number;
  readonly durability?: Readonly<{ remaining: number; maximum: number }>;
}

export interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const ABILITY_ERROR_CODES = Object.freeze([
  "INVALID_INPUT", "ACTOR_UNAVAILABLE", "EVIDENCE_UNAVAILABLE", "INTERRUPTED", "INTERNAL_ERROR",
  "MENU_OPEN", "MENU_REQUIRED", "INCOMPATIBLE_MENU", "MENU_CHANGED",
  "MENU_CLOSE_FAILED", "TARGET_NOT_FOUND", "TARGET_LOST", "TARGET_CHANGED", "TARGET_OCCUPIED",
  "UNREACHABLE", "NO_EFFECT", "ITEM_NOT_FOUND", "INSUFFICIENT_ITEMS",
  "INVENTORY_FULL", "DESTINATION_FULL", "ITEM_NOT_ACCEPTED", "WORKBENCH_REQUIRED",
  "SKILL_NOT_FOUND", "REFERENCE_NOT_FOUND", "CONTENT_TOO_LARGE",
] as const);

export type AbilityErrorCode = typeof ABILITY_ERROR_CODES[number];

export function isAbilityErrorCode(value: unknown): value is AbilityErrorCode {
  return typeof value === "string" && (ABILITY_ERROR_CODES as readonly string[]).includes(value);
}

export interface TurnObservationInput {
  readonly self: Readonly<{
    dimension: string;
    feet: BlockPosition;
    facing: "north" | "east" | "south" | "west";
    health: number;
    maxHealth: number;
    food: number;
    airSeconds: number;
    maxAirSeconds: number;
    onGround: boolean;
    inWater: boolean;
    underwater: boolean;
    inLava: boolean;
    onFire: boolean;
    mainHand: ItemSummary | null;
    activeEffects?: readonly Readonly<{
      effectId: string;
      amplifier: number;
      remainingSeconds: number;
    }>[];
  }>;
  readonly inventory: Readonly<{
    location: "player_inventory";
    items: readonly ItemSummary[];
    unavailableError?: AbilityErrorCode;
  }>;
  readonly menu:
    | Readonly<{ kind: "none" }>
    | Readonly<{ kind: "storage"; totalSlots: number; occupiedSlots: number; emptySlots: number }>
    | Readonly<{ kind: "crafting_table"; surface: "3x3" }>
    | Readonly<{
      kind: "furnace";
      input: ItemSummary | null;
      fuel: ItemSummary | null;
      output: ItemSummary | null;
      burning: boolean;
      cookProgressSeconds: number;
      cookTotalSeconds: number;
    }>
    | Readonly<{ kind: "unsupported" }>
    | Readonly<{ kind: "unavailable"; error: AbilityErrorCode }>;
  readonly perceivedBlocks: Readonly<{
    blocks: readonly Readonly<{ blockId: string; position: BlockPosition }>[];
    truncated: boolean;
    provenance?: Readonly<Record<string, unknown>>;
    unavailableError?: AbilityErrorCode;
  }>;
  readonly perceivedEntities: Readonly<{
    entities: readonly Readonly<{
      id: string;
      entityType: string;
      position: Readonly<{ x: number; y: number; z: number }>;
      trackState: "VISIBLE" | "RECENT";
      ageSeconds: number;
      item?: Readonly<{ itemId: string; count: number }>;
    }>[];
    truncated: boolean;
    provenance?: Readonly<Record<string, unknown>>;
    unavailableError?: AbilityErrorCode;
  }>;
  readonly unavailableTools: readonly Readonly<{
    error: AbilityErrorCode;
    tools: readonly string[];
  }>[];
}

export type TurnObservation = Omit<TurnObservationInput, "perceivedBlocks" | "perceivedEntities"> & Readonly<{
  perceivedBlocks: Readonly<{
    truncated: boolean;
    provenance?: Readonly<Record<string, unknown>>;
    groups: readonly Readonly<{
      blockId: string;
      count: number;
      positions: readonly BlockPosition[];
    }>[];
    unavailableError?: AbilityErrorCode;
  }>;
  perceivedEntities: Readonly<{
    truncated: boolean;
    provenance?: Readonly<Record<string, unknown>>;
    groups: readonly Readonly<{
      entityType: string;
      itemId?: string;
      count: number;
      samples: readonly Readonly<{
        id: string;
        position: Readonly<{ x: number; y: number; z: number }>;
        trackState: "VISIBLE" | "RECENT";
        ageSeconds?: number;
        itemCount?: number;
      }>[];
    }>[];
    unavailableError?: AbilityErrorCode;
  }>;
}>;

const WORK_BLOCK_IDS = new Set([
  "minecraft:crafting_table",
  "minecraft:furnace",
  "minecraft:blast_furnace",
  "minecraft:smoker",
  "minecraft:stonecutter",
  "minecraft:smithing_table",
  "minecraft:anvil",
  "minecraft:chipped_anvil",
  "minecraft:damaged_anvil",
  "minecraft:grindstone",
  "minecraft:enchanting_table",
  "minecraft:brewing_stand",
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:barrel",
  "minecraft:ender_chest",
  "minecraft:loom",
  "minecraft:cartography_table",
  "minecraft:fletching_table",
]);

const RESOURCE_BLOCK_IDS = new Set([
  "minecraft:oak_log", "minecraft:oak_wood", "minecraft:stripped_oak_log", "minecraft:stripped_oak_wood",
  "minecraft:spruce_log", "minecraft:spruce_wood", "minecraft:stripped_spruce_log", "minecraft:stripped_spruce_wood",
  "minecraft:birch_log", "minecraft:birch_wood", "minecraft:stripped_birch_log", "minecraft:stripped_birch_wood",
  "minecraft:jungle_log", "minecraft:jungle_wood", "minecraft:stripped_jungle_log", "minecraft:stripped_jungle_wood",
  "minecraft:acacia_log", "minecraft:acacia_wood", "minecraft:stripped_acacia_log", "minecraft:stripped_acacia_wood",
  "minecraft:dark_oak_log", "minecraft:dark_oak_wood", "minecraft:stripped_dark_oak_log", "minecraft:stripped_dark_oak_wood",
  "minecraft:mangrove_log", "minecraft:mangrove_wood", "minecraft:stripped_mangrove_log", "minecraft:stripped_mangrove_wood",
  "minecraft:cherry_log", "minecraft:cherry_wood", "minecraft:stripped_cherry_log", "minecraft:stripped_cherry_wood",
  "minecraft:crimson_stem", "minecraft:crimson_hyphae", "minecraft:stripped_crimson_stem", "minecraft:stripped_crimson_hyphae",
  "minecraft:warped_stem", "minecraft:warped_hyphae", "minecraft:stripped_warped_stem", "minecraft:stripped_warped_hyphae",
  "minecraft:coal_ore", "minecraft:deepslate_coal_ore",
  "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
  "minecraft:iron_ore", "minecraft:deepslate_iron_ore",
  "minecraft:gold_ore", "minecraft:deepslate_gold_ore", "minecraft:nether_gold_ore",
  "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore",
  "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
  "minecraft:nether_quartz_ore", "minecraft:ancient_debris",
  "minecraft:obsidian", "minecraft:crying_obsidian", "minecraft:end_portal_frame",
]);

export type ObserveSelfEnvelope = InferToolSchema<typeof observeSelfOutput>;

export type ObserveSelfSuccessData = Extract<ObserveSelfEnvelope, { ok: true }>["data"];

export type ObserveSelfResult = Readonly<{
  ok: true;
  dimension: string;
  position: Readonly<{ x: number; y: number; z: number }>;
  feet: Readonly<{ x: number; y: number; z: number }>;
  facing: "north" | "east" | "south" | "west";
  health: number;
  max_health: number;
  food: number;
  air: number;
  max_air: number;
  on_ground: boolean;
  in_water: boolean;
  underwater: boolean;
  in_lava: boolean;
  on_fire: boolean;
  velocity: Readonly<{ x: number; y: number; z: number }>;
  fall_distance: number;
  main_hand: Readonly<{ item_id: string; count: number; damage: number; max_damage: number }> | null;
  active_effects: readonly Readonly<{
    effect_id: string; amplifier: number; duration_ticks: number; ambient: boolean; visible: boolean;
  }>[];
}>;

export function projectObserveSelfResult(data: ObserveSelfSuccessData): ObserveSelfResult {
  const air = airSupply(data.air);
  const mainhand = data.equipment.mainhand;
  return {
    ok: true,
    dimension: data.dimension,
    position: data.position,
    feet: data.feet,
    facing: data.facing,
    health: data.hp,
    max_health: data.max_hp,
    food: data.hunger,
    air: air.current,
    max_air: air.maximum,
    on_ground: data.on_ground,
    in_water: data.in_water,
    underwater: data.underwater,
    in_lava: data.in_lava,
    on_fire: data.on_fire,
    velocity: data.velocity,
    fall_distance: data.fall_distance,
    main_hand: mainhand === undefined ? null : {
      item_id: mainhand.item,
      count: mainhand.count ?? 1,
      damage: 0,
      max_damage: 0,
    },
    active_effects: data.active_effects.map((effect) => ({
      effect_id: effect.effect_id,
      amplifier: effect.amplifier,
      duration_ticks: effect.duration_ticks,
      ambient: false,
      visible: true,
    })),
  };
}

export function normalizeTurnObservation(input: TurnObservationInput): TurnObservation {
  const inventory = aggregateItems(input.inventory.items);
  const blocksById = new Map<string, Map<string, BlockPosition>>();
  for (const block of input.perceivedBlocks.blocks) {
    const blockId = canonicalBlockId(block.blockId);
    const positions = blocksById.get(blockId) ?? new Map<string, BlockPosition>();
    positions.set(positionText(block.position), block.position);
    blocksById.set(blockId, positions);
  }
  const blockGroups = [...blocksById].map(([blockId, positionsByKey]) => {
    const positions = [...positionsByKey.values()].sort((first, second) =>
      distanceSquared(input.self.feet, first) - distanceSquared(input.self.feet, second)
        || comparePosition(first, second));
    return { blockId, count: positions.length, positions: positions.slice(0, 3) };
  }).sort((first, second) =>
    blockCategoryOrder(first.blockId) - blockCategoryOrder(second.blockId)
      || distanceSquared(input.self.feet, first.positions[0]!)
        - distanceSquared(input.self.feet, second.positions[0]!)
      || compareText(first.blockId, second.blockId));
  const entities = [...new Map(input.perceivedEntities.entities.map((entity) => [entity.id, entity])).values()];
  const entitiesByGroup = new Map<string, typeof entities>();
  for (const entity of entities) {
    const groupKey = entity.item === undefined ? entity.entityType : `${entity.entityType}\0${entity.item.itemId}`;
    const group = entitiesByGroup.get(groupKey) ?? [];
    group.push(entity);
    entitiesByGroup.set(groupKey, group);
  }
  const entityGroups = [...entitiesByGroup.entries()].map(([groupKey, groupEntities]) => {
    const sorted = groupEntities.sort((first, second) =>
      trackOrder(first.trackState) - trackOrder(second.trackState)
      || distanceSquared(input.self.feet, first.position) - distanceSquared(input.self.feet, second.position)
      || first.ageSeconds - second.ageSeconds
      || compareText(first.id, second.id));
    const first = sorted[0]!;
    return {
      groupKey,
      nearestDistance: Math.min(...sorted.map((entity) => distanceSquared(input.self.feet, entity.position))),
      entityType: first.entityType,
      ...(first.item === undefined ? {} : { itemId: first.item.itemId }),
      count: sorted.length,
      samples: sorted.slice(0, 3).map((entity) => ({
        id: entity.id,
        position: entity.position,
        trackState: entity.trackState,
        ...(entity.trackState === "RECENT" ? { ageSeconds: entity.ageSeconds } : {}),
        ...(entity.item === undefined ? {} : { itemCount: entity.item.count }),
      })),
    };
  }).sort((first, second) =>
    trackOrder(first.samples[0]!.trackState) - trackOrder(second.samples[0]!.trackState)
      || first.nearestDistance - second.nearestDistance
      || compareText(first.groupKey, second.groupKey));
  const unavailableTools = input.unavailableTools
    .map((group) => ({ error: group.error, tools: [...new Set(group.tools)].sort(compareText) }))
    .sort((first, second) => compareText(first.error, second.error));

  return {
    ...input,
    inventory: { ...input.inventory, location: "player_inventory", items: inventory },
    perceivedBlocks: {
      truncated: input.perceivedBlocks.truncated,
      ...(input.perceivedBlocks.provenance === undefined ? {} : { provenance: input.perceivedBlocks.provenance }),
      groups: blockGroups,
      ...(input.perceivedBlocks.unavailableError === undefined
        ? {} : { unavailableError: input.perceivedBlocks.unavailableError }),
    },
    perceivedEntities: {
      truncated: input.perceivedEntities.truncated,
      ...(input.perceivedEntities.provenance === undefined ? {} : { provenance: input.perceivedEntities.provenance }),
      groups: entityGroups.map(({ groupKey: _groupKey, nearestDistance: _nearestDistance, ...group }) => group),
      ...(input.perceivedEntities.unavailableError === undefined
        ? {} : { unavailableError: input.perceivedEntities.unavailableError }),
    },
    unavailableTools,
  };
}

export function renderTurnObservation(observation: TurnObservation): string {
  const lines = [
    "<turn_observation>",
    "SELF",
    `dimension=${observation.self.dimension}`,
    `feet=${positionText(observation.self.feet)}`,
    `facing=${observation.self.facing}`,
    `health=${numberText(observation.self.health)}/${numberText(observation.self.maxHealth)}`,
    `food=${observation.self.food}`,
    `air_seconds=${numberText(observation.self.airSeconds)}/${numberText(observation.self.maxAirSeconds)}`,
    `on_ground=${observation.self.onGround}`,
    `in_water=${observation.self.inWater}`,
    `underwater=${observation.self.underwater}`,
    `in_lava=${observation.self.inLava}`,
    `on_fire=${observation.self.onFire}`,
    `main_hand=${itemText(observation.self.mainHand)}`,
    ...((observation.self.activeEffects ?? []).length === 0 ? [] : [
      "active_effects=" + (observation.self.activeEffects ?? []).map((effect) =>
        `${effect.effectId}:amplifier=${effect.amplifier}:remaining_seconds=${numberText(effect.remainingSeconds)}`,
      ).join(","),
    ]),
    "INVENTORY",
    ...(observation.inventory.unavailableError === undefined ? ["location=player_inventory"] : []),
    ...(observation.inventory.unavailableError === undefined && observation.inventory.items.length === 0
      ? ["items=empty"]
      : observation.inventory.unavailableError === undefined
        ? observation.inventory.items.map((item) => `${item.itemId} count=${item.count}`)
        : [`unavailable error=${observation.inventory.unavailableError}`]),
    "MENU",
    ...menuLines(observation.menu),
    "PERCEIVED_BLOCKS",
    `coverage=${observation.perceivedBlocks.truncated ? "incomplete" : "complete"} count_scope=returned_known samples_per_group=3`,
    ...(observation.perceivedBlocks.provenance === undefined ? [] : [`provenance=${JSON.stringify(observation.perceivedBlocks.provenance)}`]),
    ...(observation.perceivedBlocks.unavailableError !== undefined
      ? [`unavailable error=${observation.perceivedBlocks.unavailableError}`]
      : observation.perceivedBlocks.groups.length === 0
      ? ["none"]
      : observation.perceivedBlocks.groups.map((group) =>
        `${group.blockId} count=${group.count} positions=${group.positions.map(positionText).join(";")}`)),
    "PERCEIVED_ENTITIES",
    `coverage=${observation.perceivedEntities.truncated ? "incomplete" : "complete"} count_scope=returned_known samples_per_group=3`,
    ...(observation.perceivedEntities.provenance === undefined ? [] : [`provenance=${JSON.stringify(observation.perceivedEntities.provenance)}`]),
    ...(observation.perceivedEntities.unavailableError !== undefined
      ? [`unavailable error=${observation.perceivedEntities.unavailableError}`]
      : observation.perceivedEntities.groups.length === 0
      ? ["none"]
      : observation.perceivedEntities.groups.map((group) => {
        const groupName = group.itemId === undefined
          ? group.entityType : `${group.entityType}[${group.itemId}]`;
        const samples = group.samples.map((sample) => {
          const age = sample.ageSeconds === undefined ? "" : `/${numberText(sample.ageSeconds)}s`;
          const items = sample.itemCount === undefined ? "" : `/items=${sample.itemCount}`;
          return `${sample.id}@${positionText(sample.position)}:${sample.trackState}${age}${items}`;
        }).join(";");
        return `${groupName} count=${group.count} samples=${samples}`;
      })),
    "UNAVAILABLE_TOOLS",
    ...(observation.unavailableTools.length === 0
      ? ["none"]
      : observation.unavailableTools.map((group) => `${group.error}=${group.tools.join(",")}`)),
    "</turn_observation>",
  ];
  return lines.join("\n");
}

export function aggregateItems(items: readonly ItemSummary[]): ItemSummary[] {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.count);
  return [...totals].sort(([first], [second]) => compareText(first, second))
    .map(([itemId, count]) => ({ itemId, count }));
}

function itemText(item: ItemSummary | null): string {
  if (item === null) return "empty";
  const durability = item.durability === undefined
    ? ""
    : ` durability=${item.durability.remaining}/${item.durability.maximum}`;
  return `${item.itemId} count=${item.count}${durability}`;
}

function menuLines(menu: TurnObservation["menu"]): string[] {
  switch (menu.kind) {
    case "none": return ["none"];
    case "storage": return [
      `menu_storage total=${menu.totalSlots} occupied=${menu.occupiedSlots} empty=${menu.emptySlots}`,
    ];
    case "crafting_table": return ["menu_type=crafting_table", `surface=${menu.surface}`];
    case "furnace": return [
      "menu_type=furnace",
      `menu_input=${itemText(menu.input)}`,
      `menu_fuel=${itemText(menu.fuel)}`,
      `menu_output=${itemText(menu.output)}`,
      `burning=${menu.burning}`,
      `cook_progress_seconds=${numberText(menu.cookProgressSeconds)}`,
      `cook_total_seconds=${numberText(menu.cookTotalSeconds)}`,
    ];
    case "unsupported": return ["unsupported"];
    case "unavailable": return [`unavailable error=${menu.error}`];
  }
}

function trackOrder(trackState: "VISIBLE" | "RECENT"): number {
  return trackState === "RECENT" ? 1 : 0;
}

function blockCategoryOrder(blockId: string): number {
  if (WORK_BLOCK_IDS.has(blockId)) return 0;
  if (RESOURCE_BLOCK_IDS.has(blockId)) return 1;
  return 2;
}

function comparePosition(first: BlockPosition, second: BlockPosition): number {
  return first.y - second.y || first.x - second.x || first.z - second.z;
}

function distanceSquared(first: Readonly<{ x: number; y: number; z: number }>, second: Readonly<{ x: number; y: number; z: number }>): number {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2 + (first.z - second.z) ** 2;
}

function positionText(position: Readonly<{ x: number; y: number; z: number }>): string {
  return `${numberText(position.x)},${numberText(position.y)},${numberText(position.z)}`;
}

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
