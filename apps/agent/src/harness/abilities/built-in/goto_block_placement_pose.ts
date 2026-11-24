import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";

const input = s.object({
  item_id: s.field(canonicalIdValue, {
    description: "Exact canonical carried BlockItem id required for the placement context.",
    examples: ["minecraft:cobblestone"],
  }),
  position: s.field(blockPositionSchema, {
    description: "Exact current-dimension target to approach for placement. Unknown targets may be approached and observed; known non-replaceable blocks are refused.",
    examples: [{ x: 4, y: 64, z: -2 }],
  }),
});
const successData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical carried BlockItem verified for placement." }),
  position: s.field(blockPositionSchema, { description: "Exact placement target." }),
  feet: s.field(blockPositionSchema, { description: "Verified final standable Placement-Reachable Feet Cell." }),
});
const failureData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical BlockItem requested for placement approach." }),
  position: s.field(blockPositionSchema, { description: "Exact requested placement target." }),
  failure_type: s.field(s.enumeration(
    "menu_open", "target_unknown", "target_occupied", "target_changed", "item_not_found",
    "item_not_block", "multi_cell_item", "no_support", "no_placement_pose",
  ), { description: "Stable reason no verified item-specific placement pose was reached." }),
});
const interruptedData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical BlockItem retained after interruption." }),
  position: s.field(blockPositionSchema, { description: "Exact requested target retained after interruption." }),
});
const output = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED", data: failureData,
    title: "Expected placement-pose failure",
    description: "No verified item-specific Placement-Reachable Pose was available.",
  },
  {
    error: "INTERRUPTED", data: interruptedData,
    title: "Placement-pose navigation interrupted",
    description: "Navigation was interrupted before a Placement-Reachable Pose was verified.",
  },
]);

export const goto_block_placement_pose = defineDirectRuntimeAbility({
  name: "goto_block_placement_pose",
  description: "Move to a verified placement position for an exact cell, approaching unknown targets to observe them. It may use route breaking and configured scaffolding, but does not place.",
  execution: "body", input, output,
});
