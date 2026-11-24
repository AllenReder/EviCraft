import { randomInt } from "node:crypto";

import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { blockPositionSchema } from "../shared/schemas.js";

type Position = { x: number; y: number; z: number };
type Heading = { x: number; z: number };
type ExploredEdge = { from: Position; to: Position };
const DEFAULT_MAX_OUTBOUND_DISPLACEMENT = 128;
type SuccessfulRegion = Extract<
  Awaited<ReturnType<ProjectAbilityNamespace["observe_blocks"]>>,
  { ok: true }
>["data"];

const progressFields = {
  route_seed: s.field(s.integer(), {
    description: "Effective integer seed used for deterministic candidate tie-breaking.",
  }),
  outbound_displacement: s.field(s.integer({ minimum: 0 }), {
    description: "Verified three-dimensional Manhattan displacement accumulated on first visits to Exploration Anchors; backtracking is excluded.",
  }),
  return_displacement: s.field(s.integer({ minimum: 0 }), {
    description: "Verified three-dimensional Manhattan displacement accumulated while returning.",
  }),
  visited_anchor_count: s.field(s.integer({ minimum: 0 }), {
    description: "Number of distinct verified Exploration Anchors visited during this excursion.",
  }),
  attempted_target_count: s.field(s.integer({ minimum: 0 }), {
    description: "Number of candidate Feet Cells submitted to goto.",
  }),
};
const successData = s.object({
  start_feet: s.field(blockPositionSchema, {
    description: "Exact Ability Start Feet Snapshot for this excursion.",
  }),
  final_feet: s.field(blockPositionSchema, {
    description: "Exact final verified Feet Cell after optional return handling.",
  }),
  ...progressFields,
});
const ordinaryFailureData = s.object({
  failure_type: s.field(s.enumeration("no_progress", "exploration_failed", "return_failed"), {
    description: "Stable Exploration Excursion failure category.",
  }),
  ...progressFields,
  final_feet: s.optional(blockPositionSchema, {
    description: "Last exact verified Feet Cell when available.",
  }),
});
const interruptedData = s.object({
  ...progressFields,
  final_feet: s.optional(blockPositionSchema, {
    description: "Last exact verified Feet Cell when available.",
  }),
});
const input = s.object({
  max_outbound_displacement: s.optional(s.integer({ minimum: 1, maximum: 4_096 }), {
    description: "Maximum distance allowed for exploration. Defaults to 128.",
    examples: [128],
  }),
  return_to_start: s.optional(s.boolean(), {
    description: "Whether to return to the starting position after exploration. Defaults to false.",
  }),
  route_seed: s.optional(s.integer(), {
    description: "Random seed for the exploration algorithm.",
    examples: [17],
  }),
});
const output = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED",
    data: ordinaryFailureData,
    title: "Exploration Excursion failure",
    description: "The excursion made no progress, encountered an exploration failure, or could not return exactly.",
  },
  {
    error: "INTERRUPTED",
    data: interruptedData,
    title: "Exploration Excursion interruption",
    description: "External cancellation stopped the excursion and retained its bounded verified progress.",
  },
] as const);

export const explore_and_return: CompositeAbilityDefinition<
  "explore_and_return",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "explore_and_return",
  description: "Explore the surrounding area autonomously to learn more about the world. Use find_known_blocks afterward to check for discovered blocks.",
  concurrency: "safe",
  input: input,
  output: output,
  async execute(input, { abilities, signal }) {
    const routeSeed = input.route_seed ?? randomInt(-0x8000_0000, 0x8000_0000);
    const maxOutboundDisplacement = input.max_outbound_displacement
      ?? DEFAULT_MAX_OUTBOUND_DISPLACEMENT;
    const returnToStart = input.return_to_start ?? false;
    const state = {
      route_seed: routeSeed,
      outbound_displacement: 0,
      return_displacement: 0,
      visited_anchor_count: 0,
      attempted_target_count: 0,
    };
    if (signal.aborted) {
      return { ok: false as const, error: "INTERRUPTED" as const,
        message: "composite interrupted", data: state };
    }
    const observed = await abilities.observe_self({});
    if (!observed.ok) {
      return observed.error === "INTERRUPTED"
        ? { ok: false as const, error: "INTERRUPTED" as const, message: observed.message, data: state }
        : ordinaryFailure("exploration_failed", observed.message, state);
    }
    const start = observed.data.feet;
    let current = start;
    let heading = facingHeading(observed.data.facing);
    let explorationFailure: string | undefined;
    const visited = new Set([positionKey(start)]);
    const rejected = new Set<string>();
    const anchors = [start];
    const exploredEdges: ExploredEdge[] = [];
    state.visited_anchor_count = 1;
    if (signal.aborted) {
      return { ok: false as const, error: "INTERRUPTED" as const,
        message: "composite interrupted", data: { ...state, final_feet: current } };
    }

    while (state.outbound_displacement < maxOutboundDisplacement) {
      const region = await abilities.observe_blocks({ radius: 4 });
      if (!region.ok) {
        if (region.error === "INTERRUPTED" || signal.aborted) {
          return { ok: false as const, error: "INTERRUPTED" as const,
            message: region.message, data: { ...state, final_feet: current } };
        }
        explorationFailure = region.message;
        break;
      }
      const candidate = orderedCandidates(
        region.data,
        current,
        heading,
        visited,
        exploredEdges,
        anchors,
        rejected,
        routeSeed,
        maxOutboundDisplacement - state.outbound_displacement,
      )[0];
      if (candidate === undefined) {
        if (anchors.length === 1) break;
        const parent = anchors[anchors.length - 2]!;
        const moved = await abilities.goto({ ...parent, route_mutation_permissions: ["OPEN"] });
        if (signal.aborted || (!moved.ok && moved.error === "INTERRUPTED")) {
          return { ok: false as const, error: "INTERRUPTED" as const,
            message: moved.message, data: { ...state, final_feet: current } };
        }
        const verified = await abilities.observe_self({});
        if (!verified.ok) {
          if (verified.error === "INTERRUPTED" || signal.aborted) {
            return { ok: false as const, error: "INTERRUPTED" as const,
              message: verified.message, data: { ...state, final_feet: current } };
          }
          explorationFailure = verified.message;
          break;
        }
        const actual = verified.data.feet;
        const displacement = manhattan(current, actual);
        if (displacement > 0) {
          heading = { x: actual.x - current.x, z: actual.z - current.z };
          current = actual;
          updateAnchors(anchors, visited, actual, state);
        }
        if (!moved.ok || !samePosition(current, parent)) {
          explorationFailure = moved.ok
            ? "exact backtrack to the parent Exploration Anchor was not verified"
            : moved.message;
          break;
        }
        continue;
      }
      const origin = current;
      state.attempted_target_count += 1;
      const moved = await abilities.goto({
        ...candidate,
        route_mutation_permissions: ["OPEN"],
      });
      if (signal.aborted || (!moved.ok && moved.error === "INTERRUPTED")) {
        return { ok: false as const, error: "INTERRUPTED" as const,
          message: moved.message, data: { ...state, final_feet: current } };
      }
      const verified = await abilities.observe_self({});
      if (!verified.ok) {
        if (verified.error === "INTERRUPTED" || signal.aborted) {
          return { ok: false as const, error: "INTERRUPTED" as const,
            message: verified.message, data: { ...state, final_feet: current } };
        }
        explorationFailure = verified.message;
        break;
      }
      const actual = verified.data.feet;
      const displacement = manhattan(current, actual);
      if (displacement > 0) {
        heading = { x: actual.x - current.x, z: actual.z - current.z };
        current = actual;
        if (updateAnchors(anchors, visited, actual, state)) {
          state.outbound_displacement += displacement;
          exploredEdges.push({ from: origin, to: actual });
        }
      }
      if (state.outbound_displacement > maxOutboundDisplacement) {
        explorationFailure = "verified navigation exceeded the maximum outbound displacement";
        break;
      }
      if (!moved.ok) {
        rejected.add(rejectionKey(origin, candidate));
        if (displacement === 0) continue;
        continue;
      }
      if (displacement === 0) {
        rejected.add(rejectionKey(origin, candidate));
      }
    }

    if (state.outbound_displacement === 0 && explorationFailure === undefined) {
      return ordinaryFailure("no_progress", "no verified outward movement was available", {
        ...state, final_feet: current,
      });
    }
    if (signal.aborted) {
      return { ok: false as const, error: "INTERRUPTED" as const,
        message: "composite interrupted", data: { ...state, final_feet: current } };
    }
    if (returnToStart) {
      let returnFailure: string | undefined;
      for (let index = anchors.length - 2; index >= 0; index -= 1) {
        const anchor = anchors[index]!;
        const returned = await abilities.goto({ ...anchor, route_mutation_permissions: ["OPEN"] });
        if (signal.aborted || (!returned.ok && returned.error === "INTERRUPTED")) {
          return { ok: false as const, error: "INTERRUPTED" as const,
            message: returned.message, data: { ...state, final_feet: current } };
        }
        const finalObservation = await abilities.observe_self({});
        if (!finalObservation.ok) {
          if (finalObservation.error === "INTERRUPTED" || signal.aborted) {
            return { ok: false as const, error: "INTERRUPTED" as const,
              message: finalObservation.message, data: { ...state, final_feet: current } };
          }
          returnFailure = finalObservation.message;
          break;
        }
        state.return_displacement += manhattan(current, finalObservation.data.feet);
        current = finalObservation.data.feet;
        if (!returned.ok || !samePosition(current, anchor)) {
          returnFailure = returned.ok
            ? "exact return to an Exploration Anchor was not verified"
            : returned.message;
          break;
        }
      }
      if (returnFailure !== undefined) {
        const direct = await abilities.goto({ ...start, route_mutation_permissions: ["OPEN"] });
        if (signal.aborted || (!direct.ok && direct.error === "INTERRUPTED")) {
          return { ok: false as const, error: "INTERRUPTED" as const,
            message: direct.message, data: { ...state, final_feet: current } };
        }
        const finalObservation = await abilities.observe_self({});
        if (!finalObservation.ok) {
          if (finalObservation.error === "INTERRUPTED" || signal.aborted) {
            return { ok: false as const, error: "INTERRUPTED" as const,
              message: finalObservation.message, data: { ...state, final_feet: current } };
          }
          return ordinaryFailure("return_failed", finalObservation.message, {
            ...state, final_feet: current,
          });
        }
        state.return_displacement += manhattan(current, finalObservation.data.feet);
        current = finalObservation.data.feet;
        if (!direct.ok || !samePosition(current, start)) {
          return ordinaryFailure("return_failed", direct.ok
            ? "exact return to the Ability Start Feet Snapshot was not verified"
            : direct.message, { ...state, final_feet: current });
        }
      }
    }
    if (explorationFailure !== undefined) {
      return ordinaryFailure("exploration_failed", explorationFailure, {
        ...state, final_feet: current,
      });
    }
    return {
      ok: true as const,
      message: returnToStart
        ? "completed bounded Exploration Excursion and returned exactly"
        : "completed bounded Exploration Excursion",
      data: { start_feet: start, final_feet: current, ...state },
    };
  },
});

function ordinaryFailure<Progress extends Readonly<{
  route_seed: number;
  outbound_displacement: number;
  return_displacement: number;
  visited_anchor_count: number;
  attempted_target_count: number;
  final_feet?: Position;
}>>(
  failureType: "no_progress" | "exploration_failed" | "return_failed",
  message: string,
  progress: Progress,
) {
  return { ok: false as const, error: "RUNTIME_FAILED" as const, message,
    data: { failure_type: failureType, ...progress } };
}

function orderedCandidates(
  region: SuccessfulRegion,
  current: Position,
  heading: Heading,
  visited: ReadonlySet<string>,
  exploredEdges: readonly ExploredEdge[],
  anchors: readonly Position[],
  rejected: ReadonlySet<string>,
  routeSeed: number,
  remainingDisplacement: number,
): Position[] {
  const candidates: Array<Position & {
    frontier: number;
    novelty: number;
    continuity: number;
    tie: number;
  }> = [];
  for (let z = region.min.z; z < region.min.z + region.size.z; z += 1) {
    for (let y = region.min.y; y < region.min.y + region.size.y; y += 1) {
      for (let x = region.min.x; x < region.min.x + region.size.x; x += 1) {
        const position = { x, y, z };
        const distance = manhattan(current, position);
        if (distance < 2 || distance > 4 || distance > remainingDisplacement
            || Math.abs(position.y - current.y) > 2 || visited.has(positionKey(position))
            || distanceToExploredRoute(position, exploredEdges) < 2
            || rejected.has(rejectionKey(current, position))
            || movesTowardParentAnchor(current, position, anchors)
            || evidenceState(region, position) !== "KNOWN_AIR"
            || evidenceState(region, { ...position, y: position.y + 1 }) !== "KNOWN_AIR"
            || evidenceState(region, { ...position, y: position.y - 1 }) !== "KNOWN_BLOCK") {
          continue;
        }
        const frontier = nearbyUnknownEvidence(region, position);
        const outerBand = Math.abs(position.x - current.x) === 4
          || Math.abs(position.z - current.z) === 4;
        if (!outerBand && frontier === 0) continue;
        candidates.push({
          ...position,
          frontier,
          novelty: routeNovelty(position, visited, exploredEdges),
          continuity: headingContinuity(heading, current, position),
          tie: seededTie(routeSeed, current, position),
        });
      }
    }
  }
  candidates.sort((left, right) =>
    right.novelty - left.novelty
      || right.continuity - left.continuity
      || right.frontier - left.frontier
      || left.tie - right.tie
      || left.x - right.x || left.y - right.y || left.z - right.z);
  return candidates.map(({ x, y, z }) => ({ x, y, z }));
}

function routeNovelty(
  position: Position,
  visited: ReadonlySet<string>,
  exploredEdges: readonly ExploredEdge[],
): number {
  const anchorDistance = [...visited].reduce((minimum, key) =>
    Math.min(minimum, manhattan(position, parsePositionKey(key))), Number.POSITIVE_INFINITY);
  return Math.min(anchorDistance, distanceToExploredRoute(position, exploredEdges));
}

function distanceToExploredRoute(position: Position, exploredEdges: readonly ExploredEdge[]): number {
  return exploredEdges.reduce((minimum, edge) =>
    Math.min(minimum, distanceToSegment(position, edge)), Number.POSITIVE_INFINITY);
}

function distanceToSegment(position: Position, edge: ExploredEdge): number {
  const dx = edge.to.x - edge.from.x;
  const dy = edge.to.y - edge.from.y;
  const dz = edge.to.z - edge.from.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) return Math.hypot(
    position.x - edge.from.x, position.y - edge.from.y, position.z - edge.from.z,
  );
  const projection = Math.max(0, Math.min(1, (
    (position.x - edge.from.x) * dx
      + (position.y - edge.from.y) * dy
      + (position.z - edge.from.z) * dz
  ) / lengthSquared));
  return Math.hypot(
    position.x - (edge.from.x + projection * dx),
    position.y - (edge.from.y + projection * dy),
    position.z - (edge.from.z + projection * dz),
  );
}

function movesTowardParentAnchor(
  current: Position,
  candidate: Position,
  anchors: readonly Position[],
): boolean {
  const parent = anchors.at(-2);
  return parent !== undefined && manhattan(candidate, parent) < manhattan(current, parent);
}

function updateAnchors(
  anchors: Position[],
  visited: Set<string>,
  actual: Position,
  state: { visited_anchor_count: number },
): boolean {
  const existing = anchors.findIndex((anchor) => samePosition(anchor, actual));
  if (existing >= 0) {
    anchors.splice(existing + 1);
    return false;
  }
  anchors.push(actual);
  if (!visited.add(positionKey(actual))) return false;
  state.visited_anchor_count += 1;
  return true;
}

function rejectionKey(origin: Position, target: Position): string {
  return `${positionKey(origin)}>${positionKey(target)}`;
}

function evidenceState(region: SuccessfulRegion, position: Position): string {
  const dx = position.x - region.min.x;
  const dy = position.y - region.min.y;
  const dz = position.z - region.min.z;
  if (dx < 0 || dy < 0 || dz < 0
      || dx >= region.size.x || dy >= region.size.y || dz >= region.size.z) return "UNKNOWN";
  const index = dx + region.size.x * (dy + region.size.y * dz);
  const paletteIndex = region.indices[index];
  return paletteIndex === undefined ? "UNKNOWN" : region.palette[paletteIndex]?.state ?? "UNKNOWN";
}

function nearbyUnknownEvidence(region: SuccessfulRegion, position: Position): number {
  let unknown = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (evidenceState(region, {
          x: position.x + dx, y: position.y + dy, z: position.z + dz,
        }) === "UNKNOWN") unknown += 1;
      }
    }
  }
  return unknown;
}

function headingContinuity(heading: Heading, current: Position, candidate: Position): number {
  const dx = candidate.x - current.x;
  const dz = candidate.z - current.z;
  const headingLength = Math.hypot(heading.x, heading.z);
  const candidateLength = Math.hypot(dx, dz);
  if (headingLength === 0 || candidateLength === 0) return 0;
  return (heading.x * dx + heading.z * dz) / (headingLength * candidateLength);
}

function seededTie(seed: number, origin: Position, candidate: Position): number {
  let hash = seed | 0;
  for (const value of [origin.x, origin.y, origin.z, candidate.x, candidate.y, candidate.z]) {
    hash = Math.imul(hash ^ (value | 0), 0x45d9_f3b);
    hash ^= hash >>> 16;
  }
  return hash >>> 0;
}

function facingHeading(facing: "north" | "east" | "south" | "west"): Heading {
  switch (facing) {
    case "north": return { x: 0, z: -1 };
    case "east": return { x: 1, z: 0 };
    case "south": return { x: 0, z: 1 };
    case "west": return { x: -1, z: 0 };
  }
}

function manhattan(left: Position, right: Position): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) + Math.abs(left.z - right.z);
}

function samePosition(left: Position, right: Position): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function positionKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`;
}

function parsePositionKey(key: string): Position {
  const [x, y, z] = key.split(",").map(Number);
  return { x: x!, y: y!, z: z! };
}
