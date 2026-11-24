import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";

const canonicalIdPattern = "^[a-z0-9_.-]+:[a-z0-9_./-]+$";
export const canonicalIdGlobPattern = "^[a-z0-9_.:/?*-]{1,256}$";

export const uuidPattern = "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$";
export const toolEmpty = s.object({});
export const canonicalIdValue = s.string({ pattern: canonicalIdPattern });
export const canonicalIdGlobValue = s.string({ pattern: canonicalIdGlobPattern });
export const blockPositionSchema = s.object({
  x: s.field(s.integer(), { description: "Integer block X coordinate in the current coordinate frame." }),
  y: s.field(s.integer(), { description: "Integer block Y coordinate in the current coordinate frame." }),
  z: s.field(s.integer(), { description: "Integer block Z coordinate in the current coordinate frame." }),
});
export const continuousPosition = s.object({
  x: s.field(s.number(), { description: "Continuous X coordinate in blocks." }),
  y: s.field(s.number(), { description: "Continuous Y coordinate in blocks." }),
  z: s.field(s.number(), { description: "Continuous Z coordinate in blocks." }),
});
export const observedItemCountSchema = s.object({
  item_id: s.field(canonicalIdValue, {
    description: "Canonical item registry identifier.",
    examples: ["minecraft:oak_log"],
  }),
  count: s.field(s.integer({ minimum: 0 }), { description: "Verified item stack count." }),
});

export const statusEffectSchema = s.object({
  effect_id: s.field(canonicalIdValue, { description: "Canonical status-effect identifier." }),
  amplifier: s.field(s.integer({ minimum: 0 }), { description: "Zero-based effect amplifier." }),
  duration_ticks: s.field(s.integer({ minimum: -1 }), { description: "Effect duration in ticks; -1 means infinite." }),
});

export const potionContentsSchema = s.object({
  potion_id: s.field(s.nullable(canonicalIdValue), { description: "Registered potion variant, or null for custom effects only." }),
  effects: s.field(s.array(statusEffectSchema), { description: "Potion effects, including custom effects; not a recommendation to drink it." }),
});

export const consumableStackSchema = s.object({
  slot: s.field(s.integer({ minimum: 0, maximum: 40 }), { description: "Inventory slot for eat; not a Menu slot index. Re-observe after inventory changes." }),
  item_id: s.field(canonicalIdValue, { description: "Canonical consumable item identifier." }),
  count: s.field(s.integer({ minimum: 1 }), { description: "Current count in this Inventory slot." }),
  potion: s.optional(potionContentsSchema, { description: "Potion variant and effects when present on the stack." }),
});
export const observedDropEntitySchema = s.object({
  uuid: s.field(s.string({ pattern: uuidPattern }), { description: "Observed dropped-item Entity UUID." }),
  item_id: s.field(canonicalIdValue, { description: "Canonical observed dropped-item id." }),
  count: s.field(s.integer({ minimum: 1 }), { description: "Observed positive dropped-item count." }),
});
export type ObservedDropEntity = InferToolSchema<typeof observedDropEntitySchema>;
export const menuLocation = s.enumeration(
  "player_inventory", "menu_storage", "menu_input", "menu_fuel", "menu_output",
);

export const knownEvidenceFields = {
  source: s.field(s.string(), { description: "Evidence source reported by the Runtime." }),
  observed_tick: s.field(s.integer(), { description: "Minecraft server tick when the evidence was observed." }),
  observation_revision: s.field(s.integer(), { description: "Monotonic evidence revision containing this observation." }),
} as const;
const unknownBlockEvidenceSchema = s.object({
  dimension: s.field(canonicalIdValue, { description: "Canonical dimension registry identifier." }),
  position: s.field(blockPositionSchema, { description: "Exact queried block position." }),
  state: s.field(s.literal("UNKNOWN"), { description: "The queried cell lacks current embodied evidence." }),
});
const knownAirEvidenceSchema = s.object({
  dimension: s.field(canonicalIdValue, { description: "Canonical dimension registry identifier." }),
  position: s.field(blockPositionSchema, { description: "Exact observed block position." }),
  state: s.field(s.literal("KNOWN_AIR"), { description: "Embodied evidence verifies air at this cell." }),
  ...knownEvidenceFields,
});
export const knownBlockEvidenceSchema = s.object({
  dimension: s.field(canonicalIdValue, { description: "Canonical dimension registry identifier." }),
  position: s.field(blockPositionSchema, { description: "Exact observed block position." }),
  state: s.field(s.literal("KNOWN_BLOCK"), { description: "Embodied evidence verifies a block at this cell." }),
  block_state: s.field(s.string(), {
    description: "Canonical BlockState string verified at the exact position.",
    examples: ["minecraft:stone"],
  }),
  fluid: s.field(s.string(), { description: "Canonical fluid-state string verified at the exact position." }),
  ...knownEvidenceFields,
});
export const blockEvidenceSchema = s.oneOf(
  s.branch(unknownBlockEvidenceSchema, {
    title: "Unknown cell", description: "No current embodied block evidence is available.",
  }),
  s.branch(knownAirEvidenceSchema, {
    title: "Known air", description: "Current embodied evidence verifies air.",
  }),
  s.branch(knownBlockEvidenceSchema, {
    title: "Known block", description: "Current embodied evidence verifies a BlockState.",
  }),
);
export const rememberedBlockCandidateSchema = s.object({
  position: s.field(blockPositionSchema, { description: "Exact remembered candidate block position." }),
  block_state: s.field(s.string(), {
    description: "Canonical remembered BlockState string.",
    examples: ["minecraft:iron_ore"],
  }),
});

export const blockingCellSchema = s.object({
  position: s.field(blockPositionSchema, { description: "Exact cell that stopped the excavation." }),
  state: s.field(s.string(), { description: "UNKNOWN, KNOWN_AIR, or the canonical BlockState known at that cell." }),
});
