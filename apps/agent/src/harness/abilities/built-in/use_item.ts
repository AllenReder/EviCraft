import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";

const input = s.object({
  item_id: s.optional(canonicalIdValue, {
    description: "Carried item to hold and use. Omit to use the item already in hand.",
    examples: ["minecraft:bow"],
  }),
  aim: s.optional(blockPositionSchema, {
    description: "Known air cell to face in the current dimension. Omit to use the current facing.",
    examples: [{ x: 4, y: 66, z: -2 }],
  }),
  hold_ticks: s.optional(s.integer({ minimum: -1, maximum: 6000 }), {
    description: "Omit or 0 for one click. A positive value holds the use that many game ticks and then releases it, as for drawing a bow. -1 holds until the use ends on its own, as for charging a crossbow.",
    examples: [20],
  }),
});
const aimed = { aim: s.field(blockPositionSchema, { description: "The air cell the Runtime Bot faced for this use." }) } as const;
const failureData = s.object({
  aim: s.optional(blockPositionSchema, { description: "The air cell resolved for this use, when one was resolved." }),
  failure_type: s.field(s.enumeration(
    "item_not_found", "item_not_supported", "aim_not_known_air", "target_changed", "occluded", "no_effect",
  ), { description: "Stable reason the item was not used." }),
});
const interruptionData = s.object({
  aim: s.optional(blockPositionSchema, { description: "The air cell resolved for this use, when one was resolved." }),
});
const output = canonicalAbilityResultVariants(s.object(aimed), [
  {
    error: "RUNTIME_FAILED", data: failureData,
    title: "Expected item-use failure",
    description: "The item was not used, for a stable expected Minecraft reason.",
  },
  {
    error: "INTERRUPTED", data: interruptionData,
    title: "Item use interrupted",
    description: "The use was interrupted or ran out of time before the game accepted it.",
  },
]);

export const use_item = defineDirectRuntimeAbility({
  name: "use_item",
  description: "Use a carried item in open air from the current position: draw and release a bow, raise a shield, throw a snowball or splash potion, cast or reel in a fishing rod. The aim must be known air with nothing between it and the eyes within reach. Success means the game accepted the use; observe afterwards for its effect. Food, Ender Eyes and Ender Pearls are refused: use eat and throw_eye_of_ender. Use use_item_on_block for a block and interact_entity for an entity.",
  execution: "body", input, output,
});
