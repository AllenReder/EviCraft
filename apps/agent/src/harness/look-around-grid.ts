export const LOOK_AROUND_RADIUS = 8;
export const LOOK_AROUND_DOWN = 16;
export const LOOK_AROUND_UP = 16;

export interface LookAroundGridCell {
  readonly state: "unknown" | "air" | "block";
  readonly blockId?: string;
  readonly stale: boolean;
}

type GridToken = "@@@" | "???" | "!!!" | "~~~" | "###" | "VVV" | `+${string}` | `-${string}`;

/** Region required to prove landing feet cells, including support below and head clearance above. */
export function lookAroundRegionBounds(
  center: Readonly<{ x: number; y: number; z: number }>,
): Readonly<{
  min: Readonly<{ x: number; y: number; z: number }>;
  max: Readonly<{ x: number; y: number; z: number }>;
}> {
  return {
    min: {
      x: center.x - LOOK_AROUND_RADIUS,
      y: center.y - LOOK_AROUND_DOWN - 1,
      z: center.z - LOOK_AROUND_RADIUS,
    },
    max: {
      x: center.x + LOOK_AROUND_RADIUS,
      y: center.y + LOOK_AROUND_UP + 1,
      z: center.z + LOOK_AROUND_RADIUS,
    },
  };
}

/** Renders the conservative 17x17 North-up relative landing-height view. */
export function renderLookAroundGrid(
  cell: (x: number, y: number, z: number) => LookAroundGridCell,
  center: Readonly<{ x: number; y: number; z: number }>,
): string[] {
  const tokens: GridToken[][] = Array.from(
    { length: LOOK_AROUND_RADIUS * 2 + 1 },
    (_unused, row) => Array.from(
      { length: LOOK_AROUND_RADIUS * 2 + 1 },
      (_unusedColumn, column) => classifyColumn(
        (y) => cell(
          center.x + column - LOOK_AROUND_RADIUS,
          y,
          center.z + row - LOOK_AROUND_RADIUS,
        ),
        center.y,
      ),
    ),
  );
  tokens[LOOK_AROUND_RADIUS]![LOOK_AROUND_RADIUS] = "@@@";
  return tokens.map((row) => row.join(" "));
}

function classifyColumn(cell: (y: number) => LookAroundGridCell, feetY: number): GridToken {
  const currentFeet = cell(feetY);
  const currentHead = cell(feetY + 1);
  if ([currentFeet, currentHead].some((value) => value.blockId !== undefined
    && isHazard(value.blockId))) return "!!!";
  if ([currentFeet, currentHead].some((value) => value.blockId !== undefined
    && isLiquid(value.blockId))) return "~~~";
  if ([currentFeet, currentHead].some((value) => !isUnknown(value) && !isPassable(value))) {
    return "###";
  }
  if ([currentFeet, currentHead].some(isUnknown)) return "???";

  let sawHazard = false;
  let sawLiquid = false;
  let sawBlockedBody = false;
  let sawKnownOpenBody = false;
  for (const deltaY of candidateDeltas()) {
    const support = cell(feetY + deltaY - 1);
    const feet = cell(feetY + deltaY);
    const head = cell(feetY + deltaY + 1);
    if ([support, feet, head].some((value) => value.blockId !== undefined
      && isHazard(value.blockId))) {
      sawHazard = true;
      continue;
    }
    if ([feet, head].some((value) => value.blockId !== undefined
      && isLiquid(value.blockId))) {
      sawLiquid = true;
      continue;
    }

    if ([feet, head].some((value) => !isUnknown(value) && !isPassable(value))) {
      sawBlockedBody = true;
      continue;
    }
    if ([feet, head].some(isUnknown)) continue;
    sawKnownOpenBody = true;
    if (isUnknown(support)) continue;
    if (isSafeSupport(support)) return formatDelta(deltaY);
    if (support.blockId !== undefined && isLiquid(support.blockId)) sawLiquid = true;
  }
  if (sawHazard) return "!!!";
  if (sawLiquid) return "~~~";
  if (sawBlockedBody) return "###";
  if (sawKnownOpenBody && columnBandIsComplete(cell, feetY)) return "VVV";
  return "???";
}

function candidateDeltas(): readonly number[] {
  const values = [0];
  for (let distance = 1; distance <= Math.max(LOOK_AROUND_DOWN, LOOK_AROUND_UP); distance += 1) {
    if (distance <= LOOK_AROUND_DOWN) values.push(-distance);
    if (distance <= LOOK_AROUND_UP) values.push(distance);
  }
  return values;
}

function columnBandIsComplete(cell: (y: number) => LookAroundGridCell, feetY: number): boolean {
  for (let y = feetY - LOOK_AROUND_DOWN - 1; y <= feetY + LOOK_AROUND_UP + 1; y += 1) {
    if (isUnknown(cell(y))) return false;
  }
  return true;
}

function isUnknown(cell: LookAroundGridCell): boolean {
  return cell.stale || cell.state === "unknown";
}

function isPassable(cell: LookAroundGridCell): boolean {
  if (cell.state === "air") return true;
  return cell.blockId !== undefined && (isLiquid(cell.blockId) || isKnownPassableBlock(cell.blockId));
}

function isSafeSupport(cell: LookAroundGridCell): boolean {
  return cell.state === "block" && cell.blockId !== undefined
    && !isHazard(cell.blockId) && !isLiquid(cell.blockId)
    && !isKnownPassableBlock(cell.blockId);
}

function formatDelta(deltaY: number): GridToken {
  const magnitude = Math.abs(deltaY).toString().padStart(2, "0");
  return `${deltaY < 0 ? "-" : "+"}${magnitude}`;
}

function isKnownPassableBlock(block: string): boolean {
  return block === "minecraft:short_grass" || block === "minecraft:tall_grass"
    || block === "minecraft:fern" || block === "minecraft:large_fern"
    || block === "minecraft:dead_bush" || block === "minecraft:vine"
    || block === "minecraft:ladder" || block === "minecraft:scaffolding"
    || block === "minecraft:cobweb" || block.endsWith("_torch")
    || block.endsWith("_flower") || block.endsWith("_sapling")
    || block.endsWith("_button") || block.endsWith("_pressure_plate")
    || block.endsWith("_sign") || block.endsWith("_wall_sign");
}

function isLiquid(block: string): boolean {
  return block === "minecraft:water" || block === "minecraft:bubble_column";
}

function isHazard(block: string): boolean {
  return block === "minecraft:lava" || block === "minecraft:fire" || block === "minecraft:soul_fire"
    || block === "minecraft:cactus" || block === "minecraft:sweet_berry_bush"
    || block === "minecraft:wither_rose" || block === "minecraft:magma_block"
    || block === "minecraft:powder_snow" || block === "minecraft:campfire"
    || block === "minecraft:soul_campfire";
}
