import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { canonicalIdValue, observedItemCountSchema, statusEffectSchema, toolEmpty } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
const eatData = s.object({
  item: s.field(canonicalIdValue, { description: "Canonical item identifier of the selected food or drink." }),
  slot: s.field(s.integer({ minimum: 0, maximum: 40 }), { description: "Inventory slot selected before the item was held." }),
  consumed_count: s.field(s.integer({ minimum: 0 }), { description: "Verified consumed units of the selected stack variant." }),
  returned_container: s.optional(observedItemCountSchema, { description: "Verified returned container; absent when no container was returned." }),
  hp: s.field(s.number(), { description: "Verified health points after eating." }),
  hunger: s.field(s.integer(), { description: "Verified food level after eating." }),
  active_effects: s.field(s.array(statusEffectSchema), { description: "Actual active body effects after the action; includes effects not caused by this consumption." }),
});
const output = canonicalAbilityResultSchema(eatData, s.oneOf(
  s.branch(toolEmpty, { title: "No verified consumption", description: "No post-consumption facts were verified." }),
  s.branch(eatData, { title: "Verified post-consumption state", description: "The failure retains verified body state after consumption." }),
));
export const eat = defineDirectRuntimeAbility({
  name: "eat", description: "Natively consume one food, milk bucket, or ordinary drinkable potion. Choose exactly one item_id or observed Inventory slot; different variants sharing an item id require a slot. Ordinary food is refused immediately while hunger is full. Splash and lingering potions are not drinks.", execution: "body",
  input: s.oneOf(
    s.branch(s.object({ item_id: s.field(canonicalIdValue, {
      description: "Exact item id; refused when carried stacks with that id have different components. Use slot to choose a potion variant.",
      examples: ["minecraft:cooked_beef"],
    }) }), { title: "Unambiguous item identifier", description: "Use when all carried stacks of this item have the same variant." }),
    s.branch(s.object({ slot: s.field(s.integer({ minimum: 0, maximum: 40 }), {
      description: "Exact slot from observe_inventory.consumables; Inventory indexing, not Menu indexing. Consumes the current stack there.",
      examples: [7],
    }) }), { title: "Exact Inventory slot", description: "Select the intended food or potion stack after observing Inventory." }),
  ), output,
});
