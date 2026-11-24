import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { canonicalIdValue } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
const equipmentData = s.oneOf(
  s.branch(s.object({
    item: s.field(s.string(), { description: "Canonical item id affected by the equipment action." }),
    slot: s.optional(s.string(), { description: "Semantic equipment slot used by the action when reported." }),
  }), { title: "Equipped item", description: "The result identifies one equipped or unequipped item." }),
  s.branch(s.object({
    removed: s.optional(s.array(s.string()), { description: "Canonical item ids removed from equipment." }),
    still_worn: s.optional(s.array(s.string()), { description: "Canonical item ids that remain equipped." }),
  }), { title: "Equipment summary", description: "The result summarizes removed and retained worn items." }),
);
const output = canonicalAbilityResultSchema(equipmentData, equipmentData);
export const equip_item = defineDirectRuntimeAbility({
  name: "equip_item", description: "Equip or unequip an inventory item.", execution: "body",
  input: s.object({
    action: s.optional(s.enumeration("equip", "unequip"), {
      description: "Equipment action; omission defaults to equip. equip wears or holds item_id; unequip returns the specified slot to Inventory.",
      examples: ["equip"],
    }),
    item_id: s.optional(canonicalIdValue, {
      description: "Canonical Inventory item id to equip; required for equip and ignored for unequip.",
      examples: ["minecraft:iron_pickaxe"],
    }),
    slot: s.optional(s.enumeration("mainhand", "offhand", "head", "chest", "legs", "feet", "armor"), {
      description: "For equip, omit to auto-route by item type; for unequip, specify the slot to empty. armor removes all armor pieces.",
      examples: ["mainhand"],
    }),
  }), output,
});
