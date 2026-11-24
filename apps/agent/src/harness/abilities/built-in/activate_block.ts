import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
import { blockPositionSchema } from "../shared/schemas.js";

const input = s.object({
  position: s.field(blockPositionSchema, {
    description: "Exact current-dimension position of the known block to activate.",
    examples: [{ x: 4, y: 64, z: -2 }],
  }),
});
const successData = s.oneOf(
  s.branch(s.object({
    position: s.field(blockPositionSchema, { description: "Exact activated block position." }),
    outcome: s.field(s.literal("menu_opened"), { description: "Activation opened a supported or unsupported Block Menu." }),
  }), { title: "Menu opened", description: "Activation is verified by an open Block Menu." }),
  s.branch(s.object({
    position: s.field(blockPositionSchema, { description: "Exact activated block position." }),
    outcome: s.field(s.literal("block_state_changed"), { description: "Activation changed the exact target BlockState." }),
    block_state: s.field(s.string(), { description: "Verified canonical BlockState after activation." }),
  }), { title: "BlockState changed", description: "Activation is verified by an exact target BlockState change." }),
);
const failureData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested block position." }),
  failure_type: s.field(s.enumeration(
    "menu_open", "target_not_known_block", "target_changed",
    "out_of_reach", "occluded", "no_effect",
  ), { description: "Stable reason the exact activation intent was not verified." }),
});
const interruptionData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested block position retained after interruption." }),
});
const output = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED", data: failureData,
    title: "Expected activation failure",
    description: "The exact activation intent reached a stable expected Minecraft failure.",
  },
  {
    error: "INTERRUPTED", data: interruptionData,
    title: "Activation interrupted",
    description: "The exact activation intent was interrupted before a verified success.",
  },
]);

export const activate_block = defineDirectRuntimeAbility({
  name: "activate_block",
  description: "Activate one exact known block with a temporary empty main hand; success requires a block Menu or exact target BlockState change.",
  execution: "body", input, output,
});
