import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import {
  lookAroundRegionBounds,
  renderLookAroundGrid,
  type LookAroundGridCell,
} from "../../look-around-grid.js";
import type { ProjectAbilityNamespace } from "../index.js";
import type { ObservedBlocksResult } from "../built-in/observe_blocks.js";
import { blockPositionSchema, toolEmpty } from "../shared/schemas.js";

type ObservedRegion = Extract<ObservedBlocksResult, { ok: true }>["data"];

const successData = s.object({
  center: s.field(blockPositionSchema, { description: "Sampled Feet Cell anchoring the North-up map." }),
  facing: s.field(s.enumeration("north", "east", "south", "west"), {
    description: "Sampled horizontal facing at the map anchor.",
  }),
  grid: s.field(s.array(s.string(), { minItems: 17, maxItems: 17 }), {
    description: "North-up 17x17 matrix with one space-separated three-character token per cell.",
  }),
});
const output = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED",
    data: toolEmpty,
    title: "Look-Around query failure",
    description: "The Map Anchor or bounded Block Knowledge Region could not be observed.",
  },
  {
    error: "INTERRUPTED",
    data: toolEmpty,
    title: "Look-Around interruption",
    description: "The Map Anchor or bounded Block Knowledge Region was interrupted.",
  },
]);

export const look_around: CompositeAbilityDefinition<
  "look_around",
  InferToolSchema<typeof toolEmpty>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "look_around",
  description: "Render a fixed North-up 17x17 terrain matrix from selected Block Knowledge without moving. Tokens show your center (@@@), the nearest safe landing height (+00 through +/-16), or conservative unknown (???), hazard (!!!), liquid (~~~), obstruction (###), and fully known unsupported (VVV) columns. The map reports geometry, not route reachability or movement permission.",
  concurrency: "safe", input: toolEmpty, output,
  async execute(_input, { abilities, signal }) {
    if (signal.aborted) return interrupted();
    const anchor = await abilities.observe_self({});
    if (!anchor.ok) return failure(anchor);
    if (signal.aborted) return interrupted();

    const bounds = lookAroundRegionBounds(anchor.data.feet);
    const region = await abilities.observe_blocks(bounds);
    if (!region.ok) return failure(region);
    if (region.data.dimension !== anchor.data.dimension) {
      return {
        ok: false as const,
        error: "RUNTIME_FAILED" as const,
        message: "Block Knowledge Region dimension changed after Map Anchor",
        data: {},
      };
    }
    if (signal.aborted) return interrupted();

    return {
      ok: true as const,
      message: "North-up Look-Around Projection from selected Block Knowledge",
      data: {
        center: anchor.data.feet,
        facing: anchor.data.facing,
        grid: renderLookAroundGrid(regionCell(region.data), anchor.data.feet),
      },
    };
  },
});

function failure(result: Readonly<{ error: "RUNTIME_FAILED" | "INTERRUPTED"; message: string }>) {
  return result.error === "INTERRUPTED"
    ? { ok: false as const, error: "INTERRUPTED" as const, message: result.message, data: {} }
    : { ok: false as const, error: "RUNTIME_FAILED" as const, message: result.message, data: {} };
}

function interrupted() {
  return { ok: false as const, error: "INTERRUPTED" as const, message: "Look-Around Projection interrupted", data: {} };
}

function regionCell(region: ObservedRegion) {
  return (x: number, y: number, z: number): LookAroundGridCell => {
    const dx = x - region.min.x;
    const dy = y - region.min.y;
    const dz = z - region.min.z;
    if (dx < 0 || dy < 0 || dz < 0 || dx >= region.size.x || dy >= region.size.y || dz >= region.size.z) {
      return { state: "unknown", stale: false };
    }
    const paletteIndex = region.indices[dx + region.size.x * (dy + region.size.y * dz)];
    const evidence = paletteIndex === undefined ? undefined : region.palette[paletteIndex];
    if (evidence === undefined || evidence.state === "UNKNOWN") return { state: "unknown", stale: false };
    if (evidence.state === "KNOWN_AIR") return { state: "air", stale: false };
    const blockId = canonicalBlockId(evidence.block_state);
    return blockId === undefined
      ? { state: "unknown", stale: false }
      : { state: "block", blockId, stale: false };
  };
}

function canonicalBlockId(blockState: string): string | undefined {
  const match = /^([a-z0-9_.-]+:[a-z0-9_./-]+)(?:\[[^\]]*\])?$/u.exec(blockState);
  return match?.[1];
}
