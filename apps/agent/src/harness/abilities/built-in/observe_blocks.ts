import { defineAbility } from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import { currentSelf } from "../shared/current-self.js";
import { blockPositionSchema, canonicalIdValue, knownEvidenceFields, toolEmpty } from "../shared/schemas.js";
import { requiredRuntime } from "../shared/runtime.js";

const paletteEvidence = s.oneOf(
  s.branch(s.object({
    state: s.field(s.literal("UNKNOWN"), { description: "The palette entry represents unknown evidence." }),
  }), { title: "Unknown palette entry", description: "The region contains a cell without current evidence." }),
  s.branch(s.object({
    state: s.field(s.literal("KNOWN_AIR"), { description: "The palette entry represents verified air." }),
    ...knownEvidenceFields,
  }), { title: "Known-air palette entry", description: "The region contains verified air." }),
  s.branch(s.object({
    state: s.field(s.literal("KNOWN_BLOCK"), { description: "The palette entry represents a verified block." }),
    block_state: s.field(s.string(), { description: "Canonical verified BlockState string." }),
    fluid: s.field(s.string(), { description: "Canonical verified fluid-state string." }),
    ...knownEvidenceFields,
  }), { title: "Known-block palette entry", description: "The region contains a verified BlockState." }),
);
const output = canonicalAbilityResultSchema(s.object({
  operation: s.field(s.literal("block.region"), { description: "Runtime evidence operation that produced this result." }),
  dimension: s.field(canonicalIdValue, { description: "Canonical dimension registry identifier for the entire region." }),
  min: s.field(blockPositionSchema, { description: "Inclusive minimum block coordinate of the returned region." }),
  size: s.field(blockPositionSchema, { description: "Region size in blocks along each axis." }),
  palette: s.field(s.array(paletteEvidence), { description: "Deduplicated evidence values referenced by region indices." }),
  indices: s.field(s.array(s.integer({ minimum: 0 })), { description: "Palette indices in deterministic region order." }),
  complete: s.field(s.boolean(), { description: "Whether every requested region cell has current embodied evidence." }),
}), toolEmpty);
export type ObservedBlocksResult = InferToolSchema<typeof output>;
const radiusInput = s.branch(s.object({ radius: s.optional(s.integer({ minimum: 1, maximum: 16 }), {
  description: "Observation radius in blocks around the current Feet Cell; omission uses four.",
  default: 4,
  examples: [2],
}) }), {
  title: "Centered block observation",
  description: "A cubic Block Knowledge Region centered on the current Feet Cell.",
});
const explicitRegionInput = s.branch(s.object({
  min: s.field(blockPositionSchema, { description: "Inclusive minimum coordinate of the current-dimension Block Knowledge Region." }),
  max: s.field(blockPositionSchema, { description: "Inclusive maximum coordinate of the current-dimension Block Knowledge Region." }),
}), {
  title: "Explicit block region",
  description: "One inclusive rectangular Block Knowledge Region in the current Runtime Bot dimension.",
});
const input = s.oneOf(radiusInput, explicitRegionInput);

export const observe_blocks = defineAbility({
  name: "observe_blocks",
  description: "Refresh nearby block evidence only when the newest Turn Observation lacks required coordinates. Prefer observe_block for one coordinate and find_known_blocks for a known block type; use the smallest radius or explicit Region needed.",
  concurrency: "safe", execution: "query", input, output,
  async execute(value, context) {
    const self = await currentSelf(context);
    if (!self.ok) return output.parse(self, "observe_blocks self result");
    const [min, max] = "min" in value
      ? [value.min, value.max]
      : centeredRegion(self.data.feet, value.radius ?? 4);
    const data = await requiredRuntime(context).blockRegion(self.data.dimension, min, max);
    return output.parse({ ok: true, message: "bounded selected Block Knowledge", data });
  },
});

function centeredRegion(center: Readonly<{ x: number; y: number; z: number }>, radius: number) {
  return [{
    x: center.x - radius,
    y: center.y - radius,
    z: center.z - radius,
  }, {
    x: center.x + radius,
    y: center.y + radius,
    z: center.z + radius,
  }] as const;
}
