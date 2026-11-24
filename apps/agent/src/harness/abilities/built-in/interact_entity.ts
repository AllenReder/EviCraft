import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { canonicalIdValue, toolEmpty, uuidPattern } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
const interactionData = s.object({
  uuid: s.field(s.string({ pattern: uuidPattern }), { description: "Exact embodied Entity Track UUID." }),
  failure_type: s.optional(s.literal("target_lost"), { description: "Stable indication that the exact target was lost during interaction." }),
});
const output = canonicalAbilityResultSchema(interactionData, s.oneOf(
  s.branch(toolEmpty, { title: "No verified interaction progress", description: "No target facts were verified." }),
  s.branch(interactionData, { title: "Verified target progress", description: "The result retains the exact target and any stable loss fact." }),
));
export const interact_entity = defineDirectRuntimeAbility({
  name: "interact_entity", description: "Interact with one exact embodied Entity Track UUID.", execution: "body",
  input: s.object({
    uuid: s.field(s.string({ pattern: uuidPattern }), {
      description: "Exact embodied Entity Track UUID to interact with.",
      examples: ["123e4567-e89b-42d3-a456-426614174000"],
    }),
    hold_ticks: s.optional(s.integer({ minimum: -1, maximum: 1200 }), {
      description: "Optional interaction duration in ticks; omit for one interaction, use a positive value to hold or repeat, or -1 for Runtime-controlled duration.",
      examples: [20],
    }),
    item_id: s.optional(canonicalIdValue, {
      description: "Optional exact canonical Inventory item id to use for the interaction.",
      examples: ["minecraft:lead"],
    }),
  }),
  output,
});
