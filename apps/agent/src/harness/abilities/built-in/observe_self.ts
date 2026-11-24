import { defineAbility } from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { blockPositionSchema, canonicalIdValue, continuousPosition, toolEmpty } from "../shared/schemas.js";
import { requiredRuntime } from "../shared/runtime.js";

const observedEquipment = s.object({
  item: s.field(canonicalIdValue, { description: "Canonical equipped item registry identifier." }),
  count: s.optional(s.integer({ minimum: 1 }), { description: "Verified equipped stack count when the Runtime reports one." }),
});
const selfData = s.object({
  entity_id: s.field(s.integer(), { description: "Runtime entity id of the controlled Bot." }),
  name: s.field(s.string(), { description: "Minecraft username of the controlled Bot." }),
  game_mode: s.field(s.enumeration("survival", "creative", "adventure", "spectator"), { description: "Current Minecraft game mode." }),
  hp: s.field(s.number(), { description: "Current health points." }),
  max_hp: s.field(s.number(), { description: "Maximum health points." }),
  hunger: s.field(s.integer(), { description: "Current food level in half-drumstick units." }),
  position: s.field(continuousPosition, { description: "Current continuous world position of the Bot." }),
  dimension: s.field(canonicalIdValue, { description: "Canonical current dimension registry identifier.", examples: ["minecraft:overworld"] }),
  equipment: s.field(s.record(observedEquipment), { description: "Verified equipped items keyed by semantic equipment location." }),
  backpack_slots: s.field(s.object({
    used: s.field(s.integer({ minimum: 0 }), { description: "Number of occupied backpack slots." }),
    total: s.field(s.integer({ minimum: 0 }), { description: "Total backpack slot capacity." }),
  }), { description: "Backpack slot occupancy summary." }),
  on_ground: s.field(s.boolean(), { description: "Whether the Bot is currently supported by the ground." }),
  in_water: s.field(s.boolean(), { description: "Whether the Bot intersects water." }),
  air: s.field(s.string(), { description: "Runtime-formatted current air supply." }),
  in_lava: s.field(s.boolean(), { description: "Whether the Bot intersects lava." }),
  underwater: s.field(s.boolean(), { description: "Whether the Bot's eyes are underwater." }),
  on_fire: s.field(s.boolean(), { description: "Whether the Bot is currently burning." }),
  suffocating: s.field(s.boolean(), { description: "Whether the Bot is currently taking in-wall suffocation." }),
  intersecting_blocks: s.field(s.array(blockPositionSchema), {
    description: "Exact body-intersecting block positions while suffocating; empty otherwise.",
  }),
  fall_distance: s.field(s.number(), { description: "Current accumulated fall distance in blocks." }),
  facing: s.field(s.enumeration("north", "east", "south", "west"), { description: "Current horizontal facing direction." }),
  feet: s.field(blockPositionSchema, { description: "Current integer Feet Cell in the world." }),
  velocity: s.field(continuousPosition, { description: "Current velocity vector in blocks per tick." }),
  active_effects: s.field(s.array(s.object({
    effect_id: s.field(canonicalIdValue, { description: "Canonical status-effect registry identifier.", examples: ["minecraft:speed"] }),
    amplifier: s.field(s.integer({ minimum: 0 }), { description: "Zero-based status-effect amplifier." }),
    duration_ticks: s.field(s.integer({ minimum: 0 }), { description: "Remaining status-effect duration in Minecraft ticks." }),
  })), { description: "Current active status effects." }),
});
export const observeSelfOutput = canonicalAbilityResultSchema(selfData, toolEmpty);

export function airSupply(value: unknown): { current: number; maximum: number } {
  if (typeof value === "number") return { current: value, maximum: 300 };
  if (typeof value === "string") {
    const match = /^(\d+)\/(\d+)/u.exec(value);
    if (match !== null) return { current: Number(match[1]), maximum: Number(match[2]) };
  }
  return { current: 300, maximum: 300 };
}

export const observe_self = defineAbility({
  name: "observe_self", description: "Observe current body state, velocity, fall distance, and active effects.",
  concurrency: "safe", execution: "query", input: toolEmpty, output: observeSelfOutput,
  async execute(_input, context) {
    return observeSelfOutput.parse(
      stripRuntimeOnlySelfFields(await requiredRuntime(context).call("get_self_status", {}, context.signal)),
      "observe_self Runtime result",
    );
  },
});

export function stripRuntimeOnlySelfFields(result: unknown): unknown {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const outer = result as Record<string, unknown>;
  const data = outer.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return result;
  const details = data as Record<string, unknown>;
  const equipment = details.equipment;
  if (equipment === null || typeof equipment !== "object" || Array.isArray(equipment)) return result;
  const visibleEquipment = Object.fromEntries(Object.entries(equipment as Record<string, unknown>).map(([slot, value]) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [slot, value];
    const {
      damage: _damage,
      max_damage: _maxDamage,
      custom_name: _customName,
      ...visible
    } = value as Record<string, unknown>;
    return [slot, visible];
  }));
  const {
    raw_inventory: _rawInventory,
    selected_hotbar_slot: _selectedHotbarSlot,
    ...agentDetails
  } = details;
  return { ...outer, data: { ...agentDetails, equipment: visibleEquipment } };
}
