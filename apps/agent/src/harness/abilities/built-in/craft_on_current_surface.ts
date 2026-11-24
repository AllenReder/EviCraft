import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";

const canonicalItemId = s.string({ pattern: "^[a-z0-9_.-]+:[a-z0-9_./-]+$" });
const input = s.object({
  item_id: s.field(canonicalItemId, {
    description: "The canonical item registry identifier to craft.",
    examples: ["minecraft:crafting_table"],
  }),
  count: s.optional(s.integer({ minimum: 1, maximum: 256 }), {
    description: "Desired number of new items to craft, not recipe executions or total carried items; omission requests one new item. Whole recipes may produce more, and limited materials may produce fewer. Check crafted for the actual amount.",
    default: 1,
    examples: [4],
  }),
});
const output = canonicalAbilityResultSchema(
  s.object({
    crafted: s.field(s.integer({ minimum: 0 }), {
      description: "The verified number of requested items crafted by this call.",
      examples: [4],
    }),
    carrying: s.field(s.integer({ minimum: 0 }), {
      description: "The verified number of the requested item carried after crafting.",
      examples: [4],
    }),
  }),
  s.object({
    failure_type: s.field(s.enumeration(
      "no_recipe", "missing_ingredients", "needs_crafting_table", "inventory_full",
      "crafted_nothing",
    ), {
      description: "Why nothing was crafted. no_recipe: the item is not crafted (see lookup_recipe). missing_ingredients: see missing. needs_crafting_table: a 3x3 recipe and no crafting-table Menu is open. inventory_full: free a slot.",
    }),
    missing: s.optional(s.array(s.string()), {
      description: "For missing_ingredients: each short ingredient as \"<need>x <ingredient> (have <n>)\".",
    }),
  }),
);

/** Internal: the Agent-facing `craft` Composite selects the surface and calls this. */
export const craft_on_current_surface = defineDirectRuntimeAbility({
  name: "craft_on_current_surface", runtimeToolName: "craft", visibility: "internal",
  description: "Craft new items using the current 2x2 inventory grid or an open crafting-table Menu. Success means some items were crafted, including partial completion.",
  execution: "body", input, output,
});
