import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { blockPositionSchema, blockingCellSchema } from "../shared/schemas.js";
import {
  cellKind, childStop, clearPlannedCell, direction, excavationStop, knownCell, offset, positionLabel,
  regionCell, samePosition,
  type CardinalDirection, type EvidenceCell, type EvidenceRegion, type ExcavationStop,
} from "../shared/composites.js";

type BlockPosition = { x: number; y: number; z: number };
type MineDownAbilities = Pick<
  ProjectAbilityNamespace,
  "observe_self" | "observe_block" | "observe_blocks" | "break_block" | "goto" | "wait"
>;

const SETTLE_OBSERVATION_LIMIT = 10;
const SHAFT_SETTLE_OBSERVATION_LIMIT = 30;
const SETTLE_WAIT_SECONDS = 0.1;
/** Extra levels a staircase step may drop onto a known floor; the whole fall stays within three blocks. */
const MAX_STEP_DROP = 2;
/** A direct shaft may fall at most this many blocks onto known floor before it stops instead. */
const MAX_SHAFT_FALL = 3;

const progressFields = {
  completed_depth: s.field(s.integer({ minimum: 0 }), { description: "Verified number of block levels descended from the starting Feet Cell." }),
  broken: s.field(s.array(blockPositionSchema), { description: "Exact block positions verified broken during the descent." }),
} as const;
const successData = s.object({
  ...progressFields,
  feet: s.field(blockPositionSchema, { description: "Verified final Feet Cell." }),
});
const failureData = s.object({
  ...progressFields,
  feet: s.optional(blockPositionSchema, { description: "Last verified Feet Cell when known." }),
  failure_type: s.optional(s.enumeration("open_space_below", "hazard", "unknown_evidence", "blocked", "unsettled"), {
    description: "Why the descent stopped: open_space_below means known air or water under every tried step (often a cave or ravine to inspect); hazard means lava at the next cell; unknown_evidence means a required cell is still unobserved; blocked means a block or route could not be cleared; unsettled means the body did not come to rest on a verified lower Feet Cell.",
  }),
  blocking_cell: s.optional(blockingCellSchema, { description: "The evidence cell that stopped the descent, when one did." }),
  known_air_below: s.optional(s.integer({ minimum: 0 }), {
    description: "For open_space_below: consecutive known air or water cells under the planned step within the inspected column.",
  }),
});
const input = s.object({
  depth: s.field(s.integer({ minimum: 1, maximum: 64 }), {
    description: "Requested bounded descent depth in whole block levels.",
    examples: [8],
  }),
  direction: s.field(s.enumeration("north", "east", "south", "west", "down"), {
    description: "Descent geometry: prefer a supported cardinal staircase; use a gravity-driven direct vertical shaft only when needed.",
    examples: ["north"],
  }),
});
const output = canonicalAbilityResultSchema(successData, failureData);

/** A shared excavation stop, or a descent-only one: unsettled, or open space with its known depth. */
type Stop = Omit<ExcavationStop, "details"> & {
  details: Omit<InferToolSchema<typeof failureData>, "completed_depth" | "broken" | "feet">;
};
type StepResult =
  | { ok: true; feet: BlockPosition; broken: BlockPosition[] }
  | Stop & { broken: BlockPosition[] };

export const mine_down: CompositeAbilityDefinition<
  "mine_down",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "mine_down", description: "Mine a bounded descent from the current feet. Prefer a cardinal direction: it excavates a supported one-block staircase that can be walked back up, re-planning each step from the verified Feet Cell. Water cells are passed without breaking, a short known drop onto a known floor is taken, and a step over open space turns to a perpendicular direction; lava, unobserved cells, or open space on every side stop the descent with failure_type and partial progress. Use down only for a direct gravity-driven vertical shaft; it provides no return path, so returning upward requires blocks, ladders, or another route.",
  concurrency: "safe", input: input, output,
  async execute(input, { abilities, signal }) {
    const observed = await abilities.observe_self({});
    if (!observed.ok) return { ok: false as const, error: observed.error, message: observed.message, data: { completed_depth: 0, broken: [] } };
    const start = observed.data.feet;
    const targetY = start.y - input.depth;
    const broken: BlockPosition[] = [];
    let feet = start;
    let heading = input.direction as CardinalDirection | "down";
    const progress = () => ({ completed_depth: Math.max(0, start.y - feet.y), broken, feet });
    while (feet.y > targetY) {
      if (signal.aborted) return interrupted(progress());
      let step: StepResult;
      if (heading === "down") {
        step = await shaftStep(feet, abilities, signal);
      } else {
        const turned = await turningStaircaseStep(feet, heading, abilities, signal);
        step = turned.step;
        heading = turned.heading;
      }
      broken.push(...step.broken);
      if (!step.ok) {
        return { ok: false as const, error: step.error, message: step.message, data: { ...progress(), ...step.details } };
      }
      feet = step.feet;
    }
    return { ok: true as const, message: "completed bounded descent", data: progress() };
  },
});

/** Try the heading, then its two perpendicular directions, when the next step would be over open space. */
async function turningStaircaseStep(
  feet: BlockPosition,
  heading: CardinalDirection,
  abilities: MineDownAbilities,
  signal: AbortSignal,
): Promise<{ step: StepResult; heading: CardinalDirection }> {
  const first = await staircaseStep(feet, heading, abilities, signal);
  if (first.ok || first.details.failure_type !== "open_space_below") return { step: first, heading };
  const broken = [...first.broken];
  for (const turned of perpendicular(heading)) {
    if (signal.aborted) break;
    const step = await staircaseStep(feet, turned, abilities, signal);
    broken.push(...step.broken);
    if (step.ok) return { step: { ...step, broken }, heading: turned };
    if (step.details.failure_type !== "open_space_below") return { step: { ...step, broken }, heading };
  }
  return { step: { ...first, broken }, heading };
}

async function staircaseStep(
  feet: BlockPosition,
  heading: CardinalDirection,
  abilities: MineDownAbilities,
  signal: AbortSignal,
): Promise<StepResult> {
  const vector = direction(heading);
  const next = offset(feet, vector.x, -1, vector.z);
  const broken: BlockPosition[] = [];
  const stopped = (stop: Stop): StepResult => ({ ...stop, broken });
  const region = await observeColumn(abilities, next, 2);
  if (!region.ok) return stopped(childStop(region));
  let cellAt = cellReader(region.data);
  const clearance = [offset(next, 0, 2, 0), offset(next, 0, 1, 0), next];
  const support = offset(next, 0, -1, 0);
  for (const target of [...clearance, support]) {
    if (cellKind(cellAt(target)) === "lava") return stopped(lavaStop(target, cellAt(target)));
  }

  for (const target of clearance) {
    if (signal.aborted) return stopped(interruptedStop());
    const cleared = await clearPlannedCell(target, cellAt(target), abilities);
    if (!cleared.ok) return stopped(cleared);
    if (cleared.broken) broken.push(target);
  }

  if (cellKind(cellAt(support)) !== "block") {
    // Clearing the step can expose the column below it; judge support and drops on fresh evidence.
    const refreshed = await observeColumn(abilities, next, 0);
    if (!refreshed.ok) return stopped(childStop(refreshed));
    cellAt = cellReader(refreshed.data);
  }
  let supportCell = cellAt(support);
  if (cellKind(supportCell) === "unknown") {
    const known = await knownCell(support, abilities);
    if (!known.ok) return stopped(known);
    supportCell = known.cell;
  }
  const supportKind = cellKind(supportCell);
  if (supportKind === "lava") return stopped(lavaStop(support, supportCell));
  let destination = next;
  if (supportKind !== "block") {
    const landing = safeLanding(next, cellAt);
    if (landing === undefined) {
      const open = excavationStop("open_space_below", support, supportCell,
        `mine_down found open space below the next ${heading} step at ${positionLabel(support)}`);
      return stopped({ ...open, details: { ...open.details, known_air_below: knownOpenDepth(next, cellAt) } });
    }
    destination = landing;
  }
  if (signal.aborted) return stopped(interruptedStop());
  const moved = await abilities.goto({ ...destination, exact: true });
  if (!moved.ok) {
    const stop = childStop(moved);
    return stopped(moved.error === "INTERRUPTED" ? stop : { ...stop, details: { failure_type: "blocked" } });
  }
  return settle(destination, feet, SETTLE_OBSERVATION_LIMIT, abilities, broken);
}

async function shaftStep(
  feet: BlockPosition,
  abilities: MineDownAbilities,
  signal: AbortSignal,
): Promise<StepResult> {
  const below = offset(feet, 0, -1, 0);
  const broken: BlockPosition[] = [];
  const stopped = (stop: Stop): StepResult => ({ ...stop, broken });
  const region = await abilities.observe_blocks({ min: offset(feet, 0, -(MAX_SHAFT_FALL + 2), 0), max: below });
  if (!region.ok) return stopped(childStop(region));
  const cellAt = cellReader(region.data);
  // Known evidence under the shaft decides whether breaking would drop the body too far.
  let fall = 1;
  for (; fall <= MAX_SHAFT_FALL + 1; fall += 1) {
    const position = offset(feet, 0, -1 - fall, 0);
    const kind = cellKind(cellAt(position));
    if (kind === "lava") return stopped(lavaStop(position, cellAt(position)));
    if (kind !== "air") break;
  }
  if (fall > MAX_SHAFT_FALL) {
    const open = excavationStop("open_space_below", offset(feet, 0, -2, 0), { state: "KNOWN_AIR" },
      `mine_down found a known drop deeper than ${MAX_SHAFT_FALL} blocks under ${positionLabel(below)}`);
    return stopped({ ...open, details: { ...open.details, known_air_below: fall - 1 } });
  }
  if (signal.aborted) return stopped(interruptedStop());
  const cleared = await clearPlannedCell(below, cellAt(below), abilities);
  if (!cleared.ok) return stopped(cleared);
  if (cleared.broken) broken.push(below);
  return settle(below, feet, SHAFT_SETTLE_OBSERVATION_LIMIT, abilities, broken);
}

/**
 * Wait for the body to stand still on the expected Feet Cell. A body that came to rest lower
 * than it started (a longer fall into the same shaft or step) is accepted as progress.
 */
async function settle(
  expected: BlockPosition,
  from: BlockPosition,
  limit: number,
  abilities: Pick<MineDownAbilities, "observe_self" | "wait">,
  broken: BlockPosition[],
): Promise<StepResult> {
  let last: BlockPosition | undefined;
  for (let observation = 0; observation < limit; observation += 1) {
    const observed = await abilities.observe_self({});
    if (!observed.ok) return { ...childStop(observed), broken };
    last = observed.data.feet;
    const supported = observed.data.on_ground || observed.data.in_water;
    if (supported && (samePosition(last, expected) || (last.y < from.y && last.y <= expected.y))) {
      return { ok: true, feet: last, broken };
    }
    if (observation === limit - 1) break;
    const waited = await abilities.wait({ seconds: SETTLE_WAIT_SECONDS });
    if (!waited.ok) return { ...childStop(waited), broken };
  }
  return {
    ok: false, error: "RUNTIME_FAILED", broken,
    message: `mine_down descent did not settle at ${positionLabel(expected)}${last === undefined ? "" : `; feet are at ${positionLabel(last)}`}`,
    details: { failure_type: "unsettled" },
  };
}

/** The planned column from MAX_STEP_DROP + 2 below a step up to `above` cells over it. */
async function observeColumn(abilities: Pick<MineDownAbilities, "observe_blocks">, next: BlockPosition, above: number) {
  return await abilities.observe_blocks({ min: offset(next, 0, -(MAX_STEP_DROP + 2), 0), max: offset(next, 0, above, 0) });
}

function cellReader(region: EvidenceRegion) {
  return (position: BlockPosition) => regionCell(region, position);
}

/** The highest Feet Cell below an open step that keeps the whole fall within three blocks. */
function safeLanding(next: BlockPosition, cellAt: (position: BlockPosition) => EvidenceCell) {
  for (let drop = 1; drop <= MAX_STEP_DROP; drop += 1) {
    const landing = offset(next, 0, -drop, 0);
    if (cellKind(cellAt(landing)) !== "air") return undefined;
    const floor = cellKind(cellAt(offset(landing, 0, -1, 0)));
    if (floor === "block") return landing;
    if (floor !== "air") return undefined;
  }
  return undefined;
}

function knownOpenDepth(next: BlockPosition, cellAt: (position: BlockPosition) => EvidenceCell) {
  let depth = 0;
  for (let y = 1; y <= MAX_STEP_DROP + 2; y += 1) {
    const kind = cellKind(cellAt(offset(next, 0, -y, 0)));
    if (kind !== "air" && kind !== "water") break;
    depth += 1;
  }
  return depth;
}

function perpendicular(heading: CardinalDirection): CardinalDirection[] {
  return heading === "north" || heading === "south" ? ["east", "west"] : ["north", "south"];
}

function lavaStop(position: BlockPosition, cell: EvidenceCell): Stop {
  return excavationStop("hazard", position, cell, `mine_down stopped before lava at ${positionLabel(position)}`);
}

function interruptedStop(): Stop {
  return { ok: false, error: "INTERRUPTED", message: "composite interrupted", details: {} };
}

function interrupted(data: InferToolSchema<typeof successData>) {
  return { ok: false as const, error: "INTERRUPTED" as const, message: "composite interrupted", data };
}
