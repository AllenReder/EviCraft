import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { canonicalBlockId } from "../../canonical-registry-id.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { failure, failureTypeOf, interrupted } from "../shared/composites.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";

const DEFAULT_MAX_SOURCES = 4;
/** use_item_on_block failures that no other source position can fix. */
const TERMINAL_USE_FAILURES = new Set(["item_not_found", "item_not_supported", "menu_open"]);

const fluidSchema = s.enumeration("water", "lava");
const input = s.object({
  fluid: s.field(fluidSchema, { description: "Fluid to pick up into one carried empty minecraft:bucket." }),
  max_sources: s.optional(s.integer({ minimum: 1, maximum: 8 }), {
    description: "Most known source cells to try, nearest uncovered sources first; omission tries 4.",
    default: DEFAULT_MAX_SOURCES,
  }),
});
const triedSchema = s.object({
  position: s.field(blockPositionSchema, { description: "Known source cell that was tried." }),
  failure_type: s.optional(s.string(), { description: "goto_and_use_item_on_block failure_type for this source." }),
  message: s.field(s.string(), { description: "goto_and_use_item_on_block message for this source." }),
});
const successData = s.object({
  fluid: s.field(fluidSchema, { description: "Requested fluid." }),
  position: s.field(blockPositionSchema, { description: "Source cell the bucket was filled from." }),
  resulting_item_id: s.field(canonicalIdValue, { description: "Filled bucket item the empty bucket became." }),
  tried: s.field(s.array(triedSchema, { maxItems: 8 }), { description: "Earlier sources that failed before this one." }),
});
const failureData = s.object({
  fluid: s.field(fluidSchema, { description: "Requested fluid." }),
  failure_type: s.optional(s.enumeration(
    "no_known_source", "item_not_found", "item_not_supported", "menu_open", "all_sources_failed",
  ), { description: "Stable reason no bucket was filled; absent on interruption." }),
  tried: s.field(s.array(triedSchema, { maxItems: 8 }), { description: "Sources tried, in order." }),
});
const output = canonicalAbilityResultSchema(successData, failureData);
type BlockPosition = InferToolSchema<typeof blockPositionSchema>;
type Tried = InferToolSchema<typeof triedSchema>;
type Match = Readonly<{ position: BlockPosition; block_state: string }>;

export const fill_bucket: CompositeAbilityDefinition<
  "fill_bucket",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "fill_bucket",
  description: "Fill one carried empty minecraft:bucket with water or lava from a remembered source cell (level=0); flowing cells cannot fill a bucket. Tries up to max_sources of the nearest known sources, uncovered ones first, approaching each with goto_and_use_item_on_block, and stops at the first fill. It only considers known blocks: when none is a source, observe or explore near the fluid first.",
  concurrency: "safe", input: input, output,
  async execute(value, { abilities, signal }) {
    const fluidId = `minecraft:${value.fluid}`;
    const filledId = `minecraft:${value.fluid}_bucket`;
    const tried: Tried[] = [];
    const known = await abilities.find_known_blocks({ block_id_glob: fluidId });
    if (!known.ok) return { ok: false as const, error: known.error, message: known.message, data: { fluid: value.fluid, tried } };
    if (signal.aborted) return interrupted({ fluid: value.fluid, tried });
    const sources = orderedSources(known.data.matches, fluidId);
    if (sources.length === 0) {
      const seen = known.data.matches.filter((match) => canonicalBlockId(match.block_state) === fluidId).length;
      return failure(
        `no known ${fluidId} source (level=0) among the ${seen} nearest known ${fluidId} cells; observe the fluid's surface or explore closer to it`,
        { fluid: value.fluid, failure_type: "no_known_source" as const, tried },
      );
    }
    for (const position of sources.slice(0, value.max_sources ?? DEFAULT_MAX_SOURCES)) {
      const used = await abilities.goto_and_use_item_on_block({ item_id: "minecraft:bucket", position });
      if (used.ok && used.data.resulting_item_id === filledId) {
        return {
          ok: true as const,
          message: `filled a bucket with ${value.fluid} at ${position.x},${position.y},${position.z}`,
          data: { fluid: value.fluid, position, tried, resulting_item_id: filledId },
        };
      }
      if (used.ok) {
        // The use succeeded but did not yield the requested fluid; never report it as a fill.
        tried.push({ position, message: `the bucket became ${used.data.resulting_item_id ?? "nothing new"}, not ${filledId}` });
        continue;
      }
      if (used.error === "INTERRUPTED" || signal.aborted) return interrupted({ fluid: value.fluid, tried });
      const failureType = failureTypeOf(used.data);
      tried.push({ position, message: used.message, ...(failureType === undefined ? {} : { failure_type: failureType }) });
      if (failureType !== undefined && TERMINAL_USE_FAILURES.has(failureType)) {
        return failure(used.message, {
          fluid: value.fluid, failure_type: failureType as "item_not_found" | "item_not_supported" | "menu_open", tried,
        });
      }
    }
    return failure(
      `none of the ${tried.length} nearest known ${fluidId} sources could be reached; last: ${tried.at(-1)?.message ?? "none"}`,
      { fluid: value.fluid, failure_type: "all_sources_failed" as const, tried },
    );
  },
});

/** Source cells nearest first, with sources under another cell of the same fluid last. */
function orderedSources(matches: readonly Match[], fluidId: string): BlockPosition[] {
  const sameFluid = matches.filter((match) => canonicalBlockId(match.block_state) === fluidId);
  const occupied = new Set(sameFluid.map(({ position }) => key(position)));
  const sources = sameFluid
    .filter((match) => /[[,]level=0[,\]]/u.test(match.block_state))
    .map(({ position }) => position);
  const covered = (position: BlockPosition) => occupied.has(key({ ...position, y: position.y + 1 }));
  return [...sources.filter((position) => !covered(position)), ...sources.filter(covered)];
}

function key(position: BlockPosition) {
  return `${position.x},${position.y},${position.z}`;
}
