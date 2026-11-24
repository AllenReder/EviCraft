import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";

const input = s.object({
  item_id: s.field(canonicalIdValue, {
    description: "Exact canonical Inventory BlockItem id to place.",
    examples: ["minecraft:cobblestone"],
  }),
  position: s.field(blockPositionSchema, {
    description: "Exact current-dimension anchor: bed foot, door lower half, or the single block. Every filled cell must be known air or a known replaceable block (water, lava, short grass, fern, vines, snow layer), which is replaced in place like vanilla; no navigation.",
    examples: [{ x: 4, y: 64, z: -2 }],
  }),
});
const placedBlock = s.object({
  position: s.field(blockPositionSchema, { description: "Exact cell filled by the native placement." }),
  block_state: s.field(s.string(), { description: "Canonical BlockState verified in that cell." }),
});
const successData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical BlockItem id consumed by placement." }),
  position: s.field(blockPositionSchema, { description: "Exact position where placement was verified." }),
  block_state: s.field(s.string(), { description: "Canonical BlockState verified at the exact target." }),
  consumed_count: s.field(s.integer({ minimum: 0 }), { description: "Verified Inventory count consumed by placement." }),
  placed_blocks: s.field(s.array(placedBlock, { minItems: 1, maxItems: 2 }), {
    description: "Every verified placed cell, beginning with the requested anchor; includes both bed or door halves.",
  }),
});
const partialFacts = {
  block_state: s.optional(s.string(), { description: "Verified target BlockState when one was observed." }),
  consumed_count: s.optional(s.integer({ minimum: 0 }), {
    description: "Verified Inventory count consumed when known.",
  }),
  placed_blocks: s.optional(s.array(placedBlock, { maxItems: 2 }), {
    description: "Actual placed cells already verified before interruption or failure.",
  }),
  target_block_state: s.optional(s.string(), {
    description: "For target_occupied: the known BlockState holding the target cell.",
  }),
  occluding_detail: s.optional(s.string(), {
    description: "Placement blocker identity when known — distinguishes self / other-entity "
        + "(e.g. target_volume_other:minecraft:zombie) / indeterminate occupancy, "
        + "or the native ray blocker for occluded.",
  }),
} as const;
const failureData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical BlockItem id requested for placement." }),
  position: s.field(blockPositionSchema, { description: "Exact requested target position." }),
  failure_type: s.field(s.enumeration(
    "menu_open", "target_unknown", "target_occupied", "second_cell_not_free", "target_changed",
    "item_not_found", "item_not_block", "multi_cell_item", "no_support", "body_in_target",
    "entity_blocked", "out_of_reach", "occluded", "unsupported_shape", "no_effect",
    "verification_failed",
  ), {
    description: "Stable reason the exact placement intent was not verified. target_unknown: the cell has no current knowledge; approach and observe it first. target_occupied: the cell holds a known non-replaceable block (see target_block_state), break it or choose another cell. second_cell_not_free: the bed head or door upper cell is not known air or replaceable. body_in_target: the bot's own body overlaps the cell, step out of it first. entity_blocked: another entity occupies the cell (see occluding_detail).",
  }),
  ...partialFacts,
});
const interruptionData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical BlockItem id requested for placement." }),
  position: s.field(blockPositionSchema, { description: "Exact requested target position retained after interruption." }),
  ...partialFacts,
});
const output = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED", data: failureData,
    title: "Expected placement failure",
    description: "The exact placement intent reached a stable expected Minecraft failure.",
  },
  {
    error: "INTERRUPTED", data: interruptionData,
    title: "Placement interrupted",
    description: "Placement was interrupted while retaining only verified partial facts.",
  },
]);

export const place_block = defineDirectRuntimeAbility({
  name: "place_block",
  description: "Place one carried BlockItem at an exact anchor that is known air or a known replaceable block (water, grass, snow layer), including a bed foot or door lower half. Runtime selects one native context and verifies the full footprint without moving or retrying; other multi-cell items are unsupported.",
  execution: "body", input, output,
});
