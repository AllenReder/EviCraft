import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { defineAbility } from "../../ability-runtime.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import { canonicalIdValue, toolEmpty } from "../shared/schemas.js";
import { requiredRuntime } from "../shared/runtime.js";
const registryKind = s.enumeration(
  "item", "block", "entity", "biome", "structure", "item_tag", "block_tag", "biome_tag", "structure_tag",
);
const registryResult = s.object({
  kind: s.field(registryKind, { description: "Registry or Tag family searched by the query." }),
  query: s.field(s.string(), { description: "Caller-supplied registry search text." }),
  candidates: s.field(s.array(s.object({
    kind: s.field(registryKind, { description: "Registry or Tag family of this candidate." }),
    id: s.field(canonicalIdValue, { description: "Canonical registry or Tag identifier." }),
    path: s.field(s.string(), { description: "Path portion of the canonical identifier." }),
    name: s.optional(s.string(), { description: "Optional English display name." }),
  })), { description: "Deterministically ordered matching registry candidates." }),
  truncated: s.field(s.boolean(), { description: "Whether additional candidates existed beyond the fixed result bound." }),
});
const output = canonicalAbilityResultSchema(registryResult, toolEmpty);
export const lookup_registry = defineAbility({
  name: "lookup_registry", description: "Look up at most eight deterministic item, block, entity type, biome, structure, or supported Registry Tag candidates.",
  concurrency: "safe",
  execution: "query", input: s.object({
    kind: s.field(registryKind, { description: "Registry or Tag family to search." }),
    query: s.field(s.string(), {
      description: "Case-insensitive registry path or display-name search text.",
      examples: ["crafting table"],
    }),
  }),
  output,
  async execute(input, context) {
    return await requiredRuntime(context).call<InferToolSchema<typeof registryResult>>(
      "lookup_registry",
      input,
      context.signal,
    );
  },
});
