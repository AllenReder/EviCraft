import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { continuousPosition, toolEmpty, uuidPattern } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
const output = canonicalAbilityResultSchema(s.object({
  consumed: s.field(s.literal(1), { description: "Verified Ender Eye count consumed by the throw." }),
  direction: s.field(continuousPosition, { description: "Verified initial Ender Eye travel direction vector." }),
  terminal: s.field(s.enumeration("dropped", "shattered"), { description: "Verified terminal outcome of the thrown Ender Eye." }),
  item_entity_uuid: s.optional(s.string({ pattern: uuidPattern }), { description: "Dropped Ender Eye item-entity UUID when one was observed." }),
}), toolEmpty);
export const throw_eye_of_ender = defineDirectRuntimeAbility({
  name: "throw_eye_of_ender", description: "Throw one Ender Eye and report dropped or shattered terminal evidence.",
  execution: "body", input: toolEmpty, output,
});
