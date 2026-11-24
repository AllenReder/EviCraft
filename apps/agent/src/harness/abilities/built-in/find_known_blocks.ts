import { defineAbility } from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { currentSelf } from "../shared/current-self.js";
import { withOreVariantGlobNote } from "../../canonical-registry-id.js";
import { canonicalIdGlobValue, rememberedBlockCandidateSchema, toolEmpty } from "../shared/schemas.js";
import { requiredRuntime } from "../shared/runtime.js";

const output = canonicalAbilityResultSchema(s.object({
  matches: s.field(s.array(rememberedBlockCandidateSchema, { maxItems: 32 }), { description: "Nearest matching remembered block candidates, bounded to 32 entries." }),
  truncated: s.field(s.boolean(), { description: "Whether additional matching remembered candidates existed beyond the fixed bound." }),
}), toolEmpty);

export const find_known_blocks = defineAbility({
  name: "find_known_blocks",
  description: "Return at most 32 nearest remembered block candidates in the current dimension using a bounded full-match Canonical ID Glob including namespace; minecraft:*_log matches vanilla logs, and minecraft:*iron_ore matches both iron_ore and deepslate_iron_ore (minecraft:*_iron_ore misses iron_ore). An empty result does not prove the world contains no match.",
  concurrency: "safe", execution: "query",
  input: s.object({ block_id_glob: s.field(canonicalIdGlobValue, {
    description: "Full-match Canonical ID Glob over canonical remembered block ids including namespace.",
    examples: ["minecraft:*_log"],
  }) }), output,
  async execute(input, context) {
    const self = await currentSelf(context);
    if (!self.ok) return output.parse(self, "find_known_blocks self result");
    const found = await requiredRuntime(context).blockFind(
      self.data.dimension,
      input.block_id_glob,
      { origin: self.data.feet, limit: 32 },
    );
    const data = {
      matches: found.matches.map(({ position, block_state }) => ({ position, block_state })),
      truncated: found.has_more,
    };
    const message = withOreVariantGlobNote(data.matches.length === 0
      ? "no matching remembered block evidence"
      : "found matching remembered block evidence", input.block_id_glob);
    return output.parse({ ok: true, message, data });
  },
});
