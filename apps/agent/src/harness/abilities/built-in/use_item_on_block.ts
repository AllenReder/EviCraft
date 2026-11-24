import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";

const input = s.object({
  item_id: s.field(canonicalIdValue, {
    description: "Exact canonical carried non-BlockItem id to use.",
    examples: ["minecraft:flint_and_steel"],
  }),
  position: s.field(blockPositionSchema, {
    description: "Exact current-dimension known-block position to target without navigation.",
    examples: [{ x: 4, y: 64, z: -2 }],
  }),
});
const face = s.enumeration("down", "up", "north", "south", "west", "east");
const itemFacts = {
  consumed_count: s.field(s.integer({ minimum: 0 }), { description: "Verified item count consumed by the interaction." }),
  durability_used: s.field(s.integer({ minimum: 0 }), { description: "Verified durability consumed by the interaction." }),
  resulting_item_id: s.optional(canonicalIdValue, {
    description: "Canonical resulting carried item id when the used stack transforms.",
  }),
} as const;
const commonSuccess = {
  item_id: s.field(canonicalIdValue, { description: "Canonical item id used for the interaction." }),
  position: s.field(blockPositionSchema, { description: "Exact targeted known-block position." }),
  face: s.field(face, { description: "Block face selected and resolved by the Runtime." }),
} as const;
const successData = s.oneOf(
  s.branch(s.object({
    ...commonSuccess,
    outcome: s.field(s.literal("item_changed"), { description: "The carried item changed without a verified BlockState change." }),
    ...itemFacts,
  }), { title: "Item changed", description: "Success is verified by the carried item or durability change." }),
  s.branch(s.object({
    ...commonSuccess,
    outcome: s.field(s.literal("target_block_changed"), { description: "The exact target BlockState changed." }),
    effect_position: s.field(blockPositionSchema, { description: "Exact target position where the effect was verified." }),
    block_state: s.field(s.string(), { description: "Canonical BlockState verified after the interaction." }),
    ...itemFacts,
  }), { title: "Target block changed", description: "Success is verified by an exact target BlockState change." }),
  s.branch(s.object({
    ...commonSuccess,
    outcome: s.field(s.literal("adjacent_block_changed"), { description: "One adjacent BlockState changed." }),
    effect_position: s.field(blockPositionSchema, { description: "Exact adjacent position where the effect was verified." }),
    block_state: s.field(s.string(), { description: "Canonical BlockState verified after the interaction." }),
    ...itemFacts,
  }), { title: "Adjacent block changed", description: "Success is verified by one exact adjacent BlockState change." }),
);
const partialFacts = {
  face: s.optional(face, { description: "Resolved block face when one was verified." }),
  consumed_count: s.optional(s.integer({ minimum: 0 }), { description: "Verified consumed item count when known." }),
  durability_used: s.optional(s.integer({ minimum: 0 }), { description: "Verified durability use when known." }),
  resulting_item_id: s.optional(canonicalIdValue, { description: "Verified resulting carried item id when known." }),
  effect_position: s.optional(blockPositionSchema, { description: "Exact effect position when a change was verified." }),
  block_state: s.optional(s.string(), { description: "Canonical verified effect BlockState when known." }),
} as const;
const failureData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical item id requested for use." }),
  position: s.field(blockPositionSchema, { description: "Exact requested target position." }),
  failure_type: s.field(s.enumeration(
    "menu_open", "target_not_known_block", "target_changed", "item_not_found",
    "item_not_supported", "out_of_reach", "occluded", "no_effect", "verification_failed",
    "not_fluid_source", "no_support",
  ), { description: "Stable reason the exact item-use intent was not verified." }),
  ...partialFacts,
});
const interruptionData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical item id requested for use." }),
  position: s.field(blockPositionSchema, { description: "Exact requested target position retained after interruption." }),
  ...partialFacts,
});
export const useItemOnBlockOutput = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED", data: failureData,
    title: "Expected item-use failure",
    description: "The exact item-use intent reached a stable expected Minecraft failure.",
  },
  {
    error: "INTERRUPTED", data: interruptionData,
    title: "Item use interrupted",
    description: "Item use was interrupted while retaining only verified partial facts.",
  },
]);

export const use_item_on_block = defineDirectRuntimeAbility({
  name: "use_item_on_block",
  description: "Use one carried non-BlockItem on an exact known block from the current position, including water/lava buckets and empty-bucket pickup of a known source; a full bucket aimed at a known fluid cell pours into that cell. An empty bucket only picks up a source cell (level=0); fill_bucket chooses one itself. Runtime resolves the item's native ray and verifies the item or local BlockState effect; water evaporating in the Nether reports only item_changed. It does not travel; use goto_and_use_item_on_block for an out-of-reach or occluded target.",
  execution: "body", input, output: useItemOnBlockOutput,
});
