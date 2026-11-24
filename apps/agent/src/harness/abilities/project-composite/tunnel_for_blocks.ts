import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { blockPositionSchema, blockingCellSchema, canonicalIdGlobValue, rememberedBlockCandidateSchema } from "../shared/schemas.js";
import { canonicalBlockId, canonicalIdGlobPattern, withOreVariantGlobNote } from "../../canonical-registry-id.js";
import {
  cellKind, childStop, clearPlannedCell, direction, excavationStop, knownCell, offset, positionLabel, regionCell,
  type CardinalDirection, type EvidenceCell, type EvidenceRegion, type ExcavationStop,
} from "../shared/composites.js";

type BlockPosition = InferToolSchema<typeof blockPositionSchema>;
type RememberedBlockCandidate = InferToolSchema<typeof rememberedBlockCandidateSchema>;
type TunnelAbilities = Pick<
  ProjectAbilityNamespace,
  "observe_self" | "observe_block" | "observe_blocks" | "find_known_blocks" | "break_block" | "goto" | "wait"
>;
type FindResult =
  | { status: "found"; target: RememberedBlockCandidate }
  | { status: "not_found" }
  | { status: "failed"; failure: Parameters<typeof childStop>[0] };

const progressFields = {
  completed_length: s.field(s.integer({ minimum: 0 }), { description: "Verified number of completed tunnel steps." }),
  broken: s.field(s.array(blockPositionSchema), { description: "Exact block positions verified broken while tunnelling." }),
} as const;
const failureData = s.object({
  ...progressFields,
  feet: s.optional(blockPositionSchema, { description: "Last verified Feet Cell when known." }),
  failure_type: s.optional(s.enumeration("open_space_below", "hazard", "unknown_evidence", "blocked"), {
    description: "Why the tunnel stopped early: open_space_below means known air or water under the next step (often a cave to inspect); hazard means lava in the next step; unknown_evidence means a required cell is still unobserved; blocked means a block could not be cleared or the next step could not be reached.",
  }),
  blocking_cell: s.optional(blockingCellSchema, { description: "The evidence cell that stopped the tunnel, when one did." }),
});
const successData = s.object({
  found: s.field(s.boolean(), { description: "Whether a matching block was found; false means the full length was dug without a match." }),
  target: s.optional(rememberedBlockCandidateSchema, { description: "Matching remembered or Tunnel Frontier block evidence when found." }),
  ...progressFields,
  feet: s.field(blockPositionSchema, { description: "Verified final Feet Cell." }),
});
const input = s.object({
  block_id_glob: s.field(canonicalIdGlobValue, {
    description: "Full-match Canonical ID Glob over canonical block ids to find while tunnelling; minecraft:*iron_ore matches both iron_ore and deepslate_iron_ore, minecraft:*_iron_ore misses iron_ore.",
    examples: ["minecraft:*iron_ore"],
  }),
  direction: s.field(s.enumeration("north", "east", "south", "west"), {
    description: "Cardinal direction to dig; it remains fixed for the entire tunnel.",
    examples: ["north"],
  }),
  max_length: s.field(s.integer({ minimum: 1, maximum: 128 }), {
    description: "Maximum tunnel length in whole horizontal block steps.",
    examples: [16],
  }),
});
const output = canonicalAbilityResultSchema(successData, failureData);

export const tunnel_for_blocks: CompositeAbilityDefinition<
  "tunnel_for_blocks",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "tunnel_for_blocks",
  description: "Dig a straight 1x2 horizontal tunnel and stop when matching blocks are found nearby or remembered. Digging the full length without a match succeeds with found=false. Water cells are passed without breaking; lava, open space under the next step, or unobserved cells stop the tunnel with failure_type and partial progress.",
  concurrency: "safe", input: input, output,
  async execute(input, { abilities, signal }) {
    const observed = await abilities.observe_self({});
    if (!observed.ok) return { ok: false as const, error: observed.error, message: observed.message, data: { completed_length: 0, broken: [] } };
    const start = observed.data.feet;
    const broken: BlockPosition[] = [];
    let feet = start;
    let completedLength = 0;
    const progress = () => ({ completed_length: completedLength, broken, feet });
    const stopped = (stop: ExcavationStop) => ({ ok: false as const, error: stop.error, message: stop.message, data: { ...progress(), ...stop.details } });
    const findFirstMatchingEvidence = async (): Promise<FindResult> => {
      const found = await abilities.find_known_blocks({ block_id_glob: input.block_id_glob });
      if (!found.ok) return { status: "failed", failure: found };
      const target = found.data.matches[0];
      return target === undefined
        ? { status: "not_found" }
        : { status: "found", target };
    };
    const initial = await findFirstMatchingEvidence();
    if (initial.status === "failed") return stopped(childStop(initial.failure));
    if (initial.status === "found") {
      return success("found matching remembered block", initial.target, progress());
    }

    const blockIdPattern = canonicalIdGlobPattern(input.block_id_glob);
    const forward = direction(input.direction as CardinalDirection);
    const initialRegion = await observeStepRegion(abilities, start);
    if (!initialRegion.ok) return stopped(childStop(initialRegion));
    let cellAt = cellReader(initialRegion.data);
    for (let index = 0; index < input.max_length; index += 1) {
      if (signal.aborted) return interrupted(progress());
      const destination = offset(feet, forward.x, 0, forward.z);
      const clearance = [offset(destination, 0, 1, 0), destination];
      const floor = offset(destination, 0, -1, 0);
      for (const target of [...clearance, floor]) {
        if (cellKind(cellAt(target)) === "lava") return stopped(lavaStop(target, cellAt(target)));
      }
      for (const target of clearance) {
        if (signal.aborted) return interrupted(progress());
        const cleared = await clearPlannedCell(target, cellAt(target), abilities);
        if (!cleared.ok) return stopped(cleared);
        if (cleared.broken) broken.push(target);
      }
      let floorCell = cellAt(floor);
      if (cellKind(floorCell) === "unknown") {
        const known = await knownCell(floor, abilities);
        if (!known.ok) return stopped(known);
        floorCell = known.cell;
      }
      const floorKind = cellKind(floorCell);
      if (floorKind === "lava") return stopped(lavaStop(floor, floorCell));
      if (floorKind !== "block") {
        return stopped(excavationStop("open_space_below", floor, floorCell,
          `tunnel_for_blocks found open space under the next step at ${positionLabel(floor)}`));
      }
      if (signal.aborted) return interrupted(progress());
      const moved = await abilities.goto({ ...destination, exact: true });
      if (!moved.ok) {
        return stopped(moved.error === "INTERRUPTED"
          ? childStop(moved)
          : { ...childStop(moved), details: { failure_type: "blocked" } });
      }
      feet = destination;
      completedLength = index + 1;

      const region = await observeStepRegion(abilities, feet);
      if (!region.ok) return stopped(childStop(region));
      cellAt = cellReader(region.data);
      const frontierEvidence = inspectFrontier(cellAt, frontier(feet, forward), blockIdPattern);
      if (frontierEvidence.target !== undefined) {
        return success("found matching Tunnel Frontier block", frontierEvidence.target, progress());
      }
      if (frontierEvidence.hasKnownAir) {
        const found = await findFirstMatchingEvidence();
        if (found.status === "failed") return stopped(childStop(found.failure));
        if (found.status === "found") {
          return success("found matching remembered block", found.target, progress());
        }
      }
    }
    return {
      ok: true as const,
      message: withOreVariantGlobNote(
        `tunnelled ${completedLength} blocks without finding a matching block`, input.block_id_glob,
      ),
      data: { found: false, ...progress() },
    };
  },
});

/** One small Block Knowledge Region holding the next step's clearance, floor, and frontier. */
async function observeStepRegion(abilities: Pick<TunnelAbilities, "observe_blocks">, feet: BlockPosition) {
  return await abilities.observe_blocks({
    min: offset(feet, -2, -1, -2),
    max: offset(feet, 2, 2, 2),
  });
}

function cellReader(region: EvidenceRegion) {
  return (position: BlockPosition) => regionCell(region, position);
}

function frontier(feet: BlockPosition, forward: ReturnType<typeof direction>) {
  const side = { x: -forward.z, z: forward.x };
  return [
    offset(feet, forward.x, 0, forward.z),
    offset(feet, forward.x, 1, forward.z),
    offset(feet, side.x, 0, side.z),
    offset(feet, side.x, 1, side.z),
    offset(feet, -side.x, 0, -side.z),
    offset(feet, -side.x, 1, -side.z),
    offset(feet, 0, -1, 0),
    offset(feet, 0, 2, 0),
  ];
}

function inspectFrontier(
  cellAt: (position: BlockPosition) => EvidenceCell,
  positions: readonly BlockPosition[],
  blockIdPattern: RegExp,
): { target?: RememberedBlockCandidate; hasKnownAir: boolean } {
  let hasKnownAir = false;
  for (const position of positions) {
    const cell = cellAt(position);
    if (cell.state === "KNOWN_AIR") {
      hasKnownAir = true;
      continue;
    }
    if (cell.state !== "KNOWN_BLOCK") continue;
    if (blockIdPattern.test(canonicalBlockId(cell.block_state))) {
      return {
        target: rememberedBlockCandidateSchema.parse(
          { position, block_state: cell.block_state }, "Tunnel Frontier match",
        ),
        hasKnownAir,
      };
    }
  }
  return { hasKnownAir };
}

function interrupted(data: { completed_length: number; broken: BlockPosition[]; feet: BlockPosition }) {
  return { ok: false as const, error: "INTERRUPTED" as const, message: "composite interrupted", data };
}

function success(
  message: string,
  target: RememberedBlockCandidate,
  progress: { completed_length: number; broken: BlockPosition[]; feet: BlockPosition },
) {
  return { ok: true as const, message, data: { found: true, target, ...progress } };
}

function lavaStop(position: BlockPosition, cell: EvidenceCell): ExcavationStop {
  return excavationStop("hazard", position, cell, `tunnel_for_blocks stopped before lava at ${positionLabel(position)}`);
}
