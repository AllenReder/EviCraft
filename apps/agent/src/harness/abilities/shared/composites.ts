import type { ScopedAbilityNamespace } from "../../ability-runtime.js";
import { canonicalBlockId } from "../../canonical-registry-id.js";
import type { break_block } from "../built-in/break_block.js";
import type { observe_block } from "../built-in/observe_block.js";
import type { wait } from "../built-in/wait.js";

type PlannedCellAbilities = ScopedAbilityNamespace<readonly [
  typeof observe_block,
  typeof break_block,
  typeof wait,
]>;

export type ChildResult =
  | { ok: true; message: string; data: unknown }
  | { ok: false; error: "RUNTIME_FAILED" | "INTERRUPTED"; message: string; data: unknown };

export function childFailure<Data>(failed: Extract<ChildResult, { ok: false }>, data: Data) {
  return { ok: false as const, error: failed.error, message: failed.message, data };
}

export function failure<Data>(message: string, data: Data) {
  return { ok: false as const, error: "RUNTIME_FAILED" as const, message, data };
}

export function interrupted<Data>(data: Data) {
  return { ok: false as const, error: "INTERRUPTED" as const, message: "composite interrupted", data };
}

export function failureTypeOf(data: unknown): string | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const failureType = (data as { failure_type?: unknown }).failure_type;
  return typeof failureType === "string" ? failureType : undefined;
}

export type CardinalDirection = "north" | "east" | "south" | "west";

export function direction(value: CardinalDirection) {
  switch (value) {
    case "north": return { x: 0, z: -1 };
    case "east": return { x: 1, z: 0 };
    case "south": return { x: 0, z: 1 };
    case "west": return { x: -1, z: 0 };
  }
}

type BlockPosition = { x: number; y: number; z: number };

/** One evidence cell as returned by observe_block cells or an observe_blocks palette entry. */
export type EvidenceCell =
  | { state: "UNKNOWN" }
  | { state: "KNOWN_AIR" }
  | { state: "KNOWN_BLOCK"; block_state: string; fluid: string };

/**
 * Movement-relevant reading of one evidence cell. Pure water is passable without
 * breaking (it has no outline to break); lava is a hazard; any other known block is
 * an ordinary breakable or standable block.
 */
type CellKind = "unknown" | "air" | "water" | "lava" | "block";

export function cellKind(cell: EvidenceCell): CellKind {
  if (cell.state === "UNKNOWN") return "unknown";
  if (cell.state === "KNOWN_AIR") return "air";
  const block = canonicalBlockId(cell.block_state);
  const fluid = canonicalBlockId(cell.fluid);
  if (block === "minecraft:lava" || fluid === "minecraft:lava" || fluid === "minecraft:flowing_lava") {
    return "lava";
  }
  if (block === "minecraft:water" || block === "minecraft:bubble_column") return "water";
  return "block";
}

export interface EvidenceRegion {
  readonly min: BlockPosition;
  readonly size: BlockPosition;
  readonly palette: readonly unknown[];
  readonly indices: readonly number[];
}

/** Read one position from an observe_blocks region; positions outside it are UNKNOWN. */
export function regionCell(region: EvidenceRegion, position: BlockPosition): EvidenceCell {
  const dx = position.x - region.min.x;
  const dy = position.y - region.min.y;
  const dz = position.z - region.min.z;
  if (dx < 0 || dx >= region.size.x || dy < 0 || dy >= region.size.y || dz < 0 || dz >= region.size.z) {
    return { state: "UNKNOWN" };
  }
  const index = region.indices[dx + region.size.x * (dy + region.size.y * dz)];
  const cell = index === undefined ? undefined : region.palette[index];
  if (cell === undefined) throw new Error("observe_blocks returned an incomplete index region");
  return cell as EvidenceCell;
}

export function samePosition(first: BlockPosition, second: BlockPosition) {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

export function offset(position: BlockPosition, dx: number, dy: number, dz: number): BlockPosition {
  return { x: position.x + dx, y: position.y + dy, z: position.z + dz };
}

/** Why mine_down or tunnel_for_blocks stopped before its planned length. */
type ExcavationFailureType = "open_space_below" | "hazard" | "unknown_evidence" | "blocked";

export type ExcavationStop = {
  ok: false;
  error: "RUNTIME_FAILED" | "INTERRUPTED";
  message: string;
  details: {
    failure_type?: ExcavationFailureType;
    blocking_cell?: { position: BlockPosition; state: string };
  };
};

const UNKNOWN_EVIDENCE_WAIT_SECONDS = [0.1, 0.1] as const;

/** Observe one cell, waiting briefly for an unobserved cell to gain evidence. */
export async function knownCell(
  position: BlockPosition,
  abilities: Pick<PlannedCellAbilities, "observe_block" | "wait">,
): Promise<{ ok: true; cell: EvidenceCell } | ExcavationStop> {
  for (let attempt = 0; ; attempt += 1) {
    const observed = await abilities.observe_block(position);
    if (!observed.ok) return childStop(observed);
    const cell = observed.data.cells[0];
    if (cell === undefined) throw new Error("observe_block returned no planned cell evidence");
    if (cell.state !== "UNKNOWN") return { ok: true, cell };
    const waitSeconds = UNKNOWN_EVIDENCE_WAIT_SECONDS[attempt];
    if (waitSeconds === undefined) {
      return excavationStop("unknown_evidence", position, cell, `cell ${positionLabel(position)} is not currently known`);
    }
    const waited = await abilities.wait({ seconds: waitSeconds });
    if (!waited.ok) return childStop(waited);
  }
}

/**
 * Clear one planned excavation cell: air and water need nothing, lava stops, an unobserved
 * cell waits briefly for evidence, and a known block is broken with one retry after an
 * occluded or changed break.
 */
export async function clearPlannedCell(
  target: BlockPosition,
  initial: EvidenceCell,
  abilities: PlannedCellAbilities,
): Promise<{ ok: true; broken: boolean } | ExcavationStop> {
  let cell = initial;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (cellKind(cell) === "unknown") {
      const known = await knownCell(target, abilities);
      if (!known.ok) return known;
      cell = known.cell;
    }
    const kind = cellKind(cell);
    if (kind === "air" || kind === "water") return { ok: true, broken: false };
    if (kind === "lava") return excavationStop("hazard", target, cell, `stopped before lava at ${positionLabel(target)}`);
    const broken = await abilities.break_block({ position: target });
    if (broken.ok) return { ok: true, broken: true };
    const failureType = failureTypeOf(broken.data);
    const retryable = failureType === "occluded" || failureType === "target_changed";
    if (broken.error === "INTERRUPTED" || !retryable || attempt === 1) {
      return broken.error === "INTERRUPTED" ? childStop(broken) : {
        ...childStop(broken),
        details: { failure_type: "blocked", blocking_cell: { position: target, state: cellLabel(cell) } },
      };
    }
    cell = { state: "UNKNOWN" };
  }
  throw new Error("unreachable planned cell clearing state");
}

export function excavationStop(
  failureType: ExcavationFailureType,
  position: BlockPosition,
  cell: EvidenceCell,
  message: string,
): ExcavationStop {
  return {
    ok: false, error: "RUNTIME_FAILED", message,
    details: { failure_type: failureType, blocking_cell: { position, state: cellLabel(cell) } },
  };
}

export function childStop(failed: Extract<ChildResult, { ok: false }>): ExcavationStop {
  return { ok: false, error: failed.error, message: failed.message, details: {} };
}

function cellLabel(cell: EvidenceCell) {
  return cell.state === "KNOWN_BLOCK" ? cell.block_state : cell.state;
}

export function positionLabel(position: BlockPosition) {
  return `${position.x},${position.y},${position.z}`;
}

export function distanceSquared(first: BlockPosition, second: BlockPosition) {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2 + (first.z - second.z) ** 2;
}

/** Default reach, in blocks, for composites that walk to a remembered workstation. */
export const WORKSTATION_DISTANCE = 32;

/**
 * Remembered blocks of exactly `blockId` within `maxDistance` of `origin`, nearest first with a
 * stable x/y/z tie order. Workstation composites select from find_known_blocks this one way.
 */
export function nearestRememberedBlocks(
  matches: readonly Readonly<{ position: BlockPosition; block_state: string }>[],
  blockId: string,
  origin: BlockPosition,
  maxDistance: number,
): BlockPosition[] {
  return matches
    .filter((match) => canonicalBlockId(match.block_state) === blockId
      && distanceSquared(origin, match.position) <= maxDistance * maxDistance)
    .map(({ position }) => position)
    .sort((left, right) => distanceSquared(origin, left) - distanceSquared(origin, right)
      || left.x - right.x || left.y - right.y || left.z - right.z);
}
