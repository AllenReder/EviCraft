import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { canonicalIdValue, toolEmpty, uuidPattern } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
const dropData = s.object({
  item: s.field(s.string(), { description: "Canonical item id requested for dropping." }),
  dropped: s.field(s.integer({ minimum: 0 }), { description: "Verified number of items dropped." }),
  remaining_in_inventory: s.field(s.integer({ minimum: 0 }), { description: "Verified remaining count of the item in Inventory." }),
  dropped_entity_uuids: s.field(s.array(s.string({ pattern: uuidPattern })), { description: "Verified ordinary item-entity UUIDs produced by the drop action." }),
});
const output = canonicalAbilityResultSchema(dropData, s.oneOf(
  s.branch(toolEmpty, { title: "No verified drop progress", description: "No drop facts were verified." }),
  s.branch(dropData, { title: "Verified drop progress", description: "The failure retains verified drop and Inventory facts." }),
));
export const drop_items = defineDirectRuntimeAbility({
  name: "drop_items", description: "Drop an exact positive count of one canonical inventory item.", execution: "body",
  input: s.object({
    item_id: s.field(canonicalIdValue, {
      description: "Canonical Inventory item id to drop.",
      examples: ["minecraft:cobblestone"],
    }),
    count: s.field(s.integer({ minimum: 1, maximum: 999 }), {
      description: "Exact positive number of items to drop.",
      examples: [16],
    }),
  }),
  output,
});
