import { describe, expect, it } from "vitest";

import {
  lookAroundRegionBounds,
  renderLookAroundGrid,
  type LookAroundGridCell,
} from "../src/harness/look-around-grid.js";

const CENTER = { x: 0, y: 79, z: 0 } as const;

describe("look_around relative landing-height projection", () => {
  it("keeps a fixed North-up text matrix with one three-character token per cell", () => {
    const cells = new Map<string, LookAroundGridCell>();
    fillLandingColumn(cells, 0, 0, 79, "minecraft:stone");
    set(cells, 0, 78, -1, { state: "air", stale: false });
    fillLandingColumn(cells, 0, -1, 74, "minecraft:grass_block");
    for (let y = 75; y <= 80; y += 1) {
      set(cells, 0, y, -1, { state: "air", stale: false });
    }

    const grid = renderLookAroundGrid(cellFrom(cells), CENTER);

    expect(grid).toHaveLength(17);
    expect(grid.every((row) => row.split(" ").length === 17)).toBe(true);
    expect(grid.flatMap((row) => row.split(" ")).every((token) => token.length === 3)).toBe(true);
    expect(grid[8]?.split(" ")[8]).toBe("@@@");
    expect(grid[7]?.split(" ")[8]).toBe("-05");
  });

  it("uses conservative non-numeric tokens for unknown, stale, hazards, liquids, and blockers", () => {
    const cells = new Map<string, LookAroundGridCell>();
    fillLandingColumn(cells, 0, 0, 79, "minecraft:stone");
    set(cells, 1, 79, 0, { state: "air", stale: true });
    set(cells, 2, 78, 0, { state: "block", blockId: "minecraft:magma_block", stale: false });
    set(cells, 2, 79, 0, { state: "air", stale: false });
    set(cells, 2, 80, 0, { state: "air", stale: false });
    set(cells, 3, 79, 0, { state: "block", blockId: "minecraft:water", stale: false });
    set(cells, 3, 80, 0, { state: "air", stale: false });
    for (let y = 14; y <= 96; y += 1) {
      set(cells, 4, y, 0, { state: "block", blockId: "minecraft:oak_log", stale: false });
    }

    const tokens = renderLookAroundGrid(cellFrom(cells), CENTER)[8]!.split(" ");

    expect(tokens.slice(9, 13)).toEqual(["???", "!!!", "~~~", "###"]);
  });

  it("prefers the nearest lower landing before a higher hazard", () => {
    const cells = new Map<string, LookAroundGridCell>();
    set(cells, 1, 78, 0, { state: "block", blockId: "minecraft:short_grass", stale: false });
    for (let y = 79; y <= 81; y += 1) {
      set(cells, 1, y, 0, { state: "air", stale: false });
    }
    set(cells, 1, 77, 0, { state: "block", blockId: "minecraft:stone", stale: false });
    set(cells, 1, 82, 0, { state: "block", blockId: "minecraft:lava", stale: false });

    expect(renderLookAroundGrid(cellFrom(cells), CENTER)[8]!.split(" ")[9]).toBe("-01");
  });

  it("requests the complete relative-height band plus support and head clearance", () => {
    expect(lookAroundRegionBounds(CENTER)).toEqual({
      min: { x: -8, y: 62, z: -8 },
      max: { x: 8, y: 96, z: 8 },
    });
  });
});

function fillLandingColumn(
  cells: Map<string, LookAroundGridCell>,
  x: number,
  z: number,
  feetY: number,
  supportBlock: string,
): void {
  set(cells, x, feetY - 1, z, { state: "block", blockId: supportBlock, stale: false });
  set(cells, x, feetY, z, { state: "air", stale: false });
  set(cells, x, feetY + 1, z, { state: "air", stale: false });
}

function cellFrom(cells: ReadonlyMap<string, LookAroundGridCell>) {
  return (x: number, y: number, z: number): LookAroundGridCell =>
    cells.get(key(x, y, z)) ?? { state: "unknown", stale: false };
}

function set(
  cells: Map<string, LookAroundGridCell>,
  x: number,
  y: number,
  z: number,
  cell: LookAroundGridCell,
): void {
  cells.set(key(x, y, z), cell);
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}
