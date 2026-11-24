import { defineAbility } from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { currentSelf } from "../shared/current-self.js";
import { blockEvidenceSchema, blockPositionSchema, toolEmpty } from "../shared/schemas.js";
import { requiredRuntime } from "../shared/runtime.js";

const output = canonicalAbilityResultSchema(s.object({
  operation: s.field(s.literal("block.get"), { description: "Runtime evidence operation that produced this result." }),
  cells: s.field(s.array(blockEvidenceSchema), { description: "Evidence cells in the same order as requested positions." }),
}), toolEmpty);

export const observe_block = defineAbility({
  name: "observe_block",
  description: "Return UNKNOWN, KNOWN_AIR, or KNOWN_BLOCK for one exact current-dimension position.",
  concurrency: "safe", execution: "query", input: blockPositionSchema, output,
  async execute(input, context) {
    const self = await currentSelf(context);
    if (!self.ok) return output.parse(self, "observe_block self result");
    const data = await requiredRuntime(context).blockGet(self.data.dimension, [input]);
    return output.parse({ ok: true, message: "exact embodied block evidence", data });
  },
});
