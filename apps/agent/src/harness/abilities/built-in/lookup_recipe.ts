import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { defineAbility } from "../../ability-runtime.js";
import { canonicalIdGlobValue, toolEmpty } from "../shared/schemas.js";
import { requiredRuntime } from "../shared/runtime.js";
const output = canonicalAbilityResultSchema(toolEmpty, toolEmpty);
export const lookup_recipe = defineAbility({
  name: "lookup_recipe", description: "Look up recipes by a bounded full-match Canonical ID Glob over recipe ids or output item ids, such as minecraft:*_planks; recipe details are returned in the message and data is empty. Make [crafting] recipes with craft and [smelting] recipes with smelt_at_furnace; other stations are opened with goto_and_activate_block and filled with transfer_item.",
  concurrency: "safe",
  execution: "query", input: s.object({
    recipe_or_output_id_glob: s.field(canonicalIdGlobValue, {
      description: "Full-match Canonical ID Glob over canonical recipe ids or output item ids.",
      examples: ["minecraft:*pickaxe"],
    }),
  }),
  output,
  async execute(input, context) {
    return await requiredRuntime(context).call<InferToolSchema<typeof toolEmpty>>(
      "lookup_recipe",
      input,
      context.signal,
    );
  },
});
