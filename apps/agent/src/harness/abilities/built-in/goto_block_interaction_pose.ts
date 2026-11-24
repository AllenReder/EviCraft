import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";

const input = s.object({
  position: s.field(blockPositionSchema, { description: "Exact known block position requiring an interaction pose." }),
  item_id: s.optional(canonicalIdValue, {
    description: "Carried item the pose must be able to use on the target; a bucket then reaches a known water or lava cell.",
  }),
});
const successData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact protected target block position." }),
  feet: s.field(blockPositionSchema, { description: "Verified final standable Feet Cell." }),
});
const failureData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested block position." }),
  failure_type: s.field(s.enumeration(
    "target_not_known_block", "target_changed", "no_interaction_pose",
    "item_not_found", "not_fluid_source", "no_support",
  ), {
    description: "Stable reason no verified interaction pose was reached.",
  }),
});
const interruptedData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact protected target retained on interruption." }),
});
const output = canonicalAbilityResultVariants(successData, [
  { error: "RUNTIME_FAILED", data: failureData, title: "Expected interaction-pose failure", description: "No verified interaction pose was available." },
  { error: "INTERRUPTED", data: interruptedData, title: "Interaction-pose navigation interrupted", description: "Navigation was interrupted before a pose was verified." },
]);

export const goto_block_interaction_pose = defineDirectRuntimeAbility({
  name: "goto_block_interaction_pose",
  description: "Move to a standable position from which an exact block can be visibly interacted with, or, given item_id, from which that carried item can be used on it (a bucket on a water or lava cell). It may use route breaking and configured scaffolding, but does not interact.",
  execution: "body", input, output,
});
