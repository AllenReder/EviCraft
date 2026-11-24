import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility } from "../src/harness/ability-runtime.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";
import { observe_blocks } from "../src/harness/abilities/built-in/observe_blocks.js";
import { toolSchema as s } from "../src/harness/tool-schema.js";

const anchor = { x: 10, y: 64, z: -3 };

describe("look_around Look-Around Projection", () => {
  it("anchors one North-up 17x17 map and requests the complete explicit Region once", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const runtime = await lookAroundRuntime({
      observeSelf: async () => self(anchor, "east"),
      observeBlocks: async (input) => {
        calls.push({ name: "observe_blocks", input });
        return region(anchor, [
          [{ x: 10, y: 62, z: -4 }, knownBlock("minecraft:stone")],
          [{ x: 10, y: 63, z: -4 }, knownAir()],
          [{ x: 10, y: 64, z: -4 }, knownAir()],
          [{ x: 10, y: 65, z: -4 }, knownAir()],
        ]);
      },
    });

    const result = await runtime.dispatch("look_around", {});
    if (!isLookAroundResult(result)) throw new Error("look_around did not return a successful projection");
    expect(result).toMatchObject({
      ok: true,
      data: { center: anchor, facing: "east", grid: expect.any(Array) },
    });
    const { grid } = result.data;
    expect(grid).toHaveLength(17);
    expect(grid.every((row) => row.split(" ").length === 17)).toBe(true);
    expect(grid.flatMap((row) => row.split(" ")).every((token) => token.length === 3)).toBe(true);
    expect(grid[8]!.split(" ")[8]).toBe("@@@");
    expect(grid[7]!.split(" ")[8]).toBe("-01");
    expect(calls).toEqual([{
      name: "observe_blocks",
      input: {
        min: { x: 2, y: 47, z: -11 },
        max: { x: 18, y: 81, z: 5 },
      },
    }]);
  });

  it("returns unknown cells successfully when Block Knowledge is incomplete or has malformed BlockState data", async () => {
    const runtime = await lookAroundRuntime({
      observeSelf: async () => self(anchor, "north"),
      observeBlocks: async () => region(anchor, [
        [{ x: 11, y: 63, z: -3 }, knownBlock("MALFORMED")],
        [{ x: 11, y: 64, z: -3 }, knownAir()],
        [{ x: 11, y: 65, z: -3 }, knownAir()],
      ]),
    });

    const result = await runtime.dispatch("look_around", {});
    if (!isLookAroundResult(result)) throw new Error("look_around did not return a successful incomplete projection");
    expect(result.data.grid[8]!.split(" ")[9]).toBe("???");
  });

  it("preserves expected Map Anchor failure and interruption without querying a Region", async () => {
    const calls: string[] = [];
    const runtimeFailure = await lookAroundRuntime({
      observeSelf: async () => ({
        ok: false as const,
        error: "RUNTIME_FAILED" as const,
        message: "Map Anchor unavailable",
        data: {},
      }),
      observeBlocks: async () => {
        calls.push("observe_blocks");
        throw new Error("unexpected Region query");
      },
    });
    const interrupted = await lookAroundRuntime({
      observeSelf: async () => ({
        ok: false as const,
        error: "INTERRUPTED" as const,
        message: "Map Anchor interrupted",
        data: {},
      }),
      observeBlocks: async () => {
        calls.push("observe_blocks");
        throw new Error("unexpected Region query");
      },
    });

    await expect(runtimeFailure.dispatch("look_around", {})).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: "Map Anchor unavailable", data: {},
    });
    await expect(interrupted.dispatch("look_around", {})).resolves.toEqual({
      ok: false, error: "INTERRUPTED", message: "Map Anchor interrupted", data: {},
    });
    expect(calls).toEqual([]);
  });

  it("returns interruption when cancellation occurs after the Map Anchor", async () => {
    const controller = new AbortController();
    const runtime = await lookAroundRuntime({
      observeSelf: async () => self(anchor, "north"),
      observeBlocks: async () => {
        controller.abort();
        return region(anchor, []);
      },
    });

    await expect(runtime.dispatch("look_around", {}, { signal: controller.signal })).resolves.toEqual({
      ok: false, error: "INTERRUPTED", message: "Look-Around Projection interrupted", data: {},
    });
  });

  it("rejects a Region from a different dimension than the Map Anchor", async () => {
    const selectedRegion = region(anchor, []);
    const runtime = await lookAroundRuntime({
      observeSelf: async () => self(anchor, "north"),
      observeBlocks: async () => ({
        ...selectedRegion,
        data: { ...selectedRegion.data, dimension: "minecraft:the_nether" },
      }),
    });

    await expect(runtime.dispatch("look_around", {})).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "Block Knowledge Region dimension changed after Map Anchor",
      data: {},
    });
  });

  it("keeps centered observations while forwarding an inclusive Explicit Block Region in the sampled dimension", async () => {
    const calls: Array<{ dimension: string; min: Position; max: Position }> = [];
    const runtime = new AbilityRuntime();
    const selfResult = self(anchor, "north");
    await runtime.register(observe_blocks);
    const adapter = {
      call: async () => selfResult,
      blockRegion: async (dimension: string, min: Position, max: Position) => {
        calls.push({ dimension, min, max });
        return regionData(min, {
          x: max.x - min.x + 1,
          y: max.y - min.y + 1,
          z: max.z - min.z + 1,
        });
      },
    };

    await expect(runtime.dispatch("observe_blocks", {}, { runtime: adapter as never })).resolves.toMatchObject({ ok: true });
    await expect(runtime.dispatch("observe_blocks", {
      min: { x: -20, y: 5, z: 7 },
      max: { x: 4, y: 9, z: 18 },
    }, { runtime: adapter as never })).resolves.toMatchObject({ ok: true });
    await expect(runtime.dispatch("observe_blocks", {
      radius: 2,
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    }, { runtime: adapter as never })).rejects.toThrow(/exactly one supported shape/u);

    expect(calls).toEqual([
      {
        dimension: "minecraft:overworld",
        min: { x: 6, y: 60, z: -7 },
        max: { x: 14, y: 68, z: 1 },
      },
      {
        dimension: "minecraft:overworld",
        min: { x: -20, y: 5, z: 7 },
        max: { x: 4, y: 9, z: 18 },
      },
    ]);
  });
});

type Position = { x: number; y: number; z: number };
type Facing = "north" | "east" | "south" | "west";
type RegionInput = { min: Position; max: Position };
type LookAroundHandlers = Readonly<{
  observeSelf: () => Promise<unknown>;
  observeBlocks: (input: RegionInput) => Promise<unknown>;
}>;

async function lookAroundRuntime(handlers: LookAroundHandlers): Promise<AbilityRuntime> {
  const runtime = new AbilityRuntime();
  await runtime.register(defineAbility({
    name: "observe_self", description: "Scripted Look-Around Map Anchor.",
    concurrency: "safe", execution: "query", input: s.object({}), output: s.losslessJson(),
    execute: handlers.observeSelf,
  }));
  await runtime.register(defineAbility({
    name: "observe_blocks", description: "Scripted Explicit Block Region.",
    concurrency: "safe", execution: "query", input: s.object({
      min: s.field(positionSchema(), { description: "Inclusive Region minimum." }),
      max: s.field(positionSchema(), { description: "Inclusive Region maximum." }),
    }), output: s.losslessJson(), execute: handlers.observeBlocks,
  }));
  await runtime.register(lookAroundDefinition());
  return runtime;
}

function lookAroundDefinition() {
  const definition = projectCompositeAbilities.find(({ name }) => name === "look_around");
  if (definition === undefined) throw new Error("look_around Project Composite is not registered");
  return definition;
}

function self(feet: Position, facing: Facing) {
  return {
    ok: true as const,
    message: "sampled Map Anchor",
    data: {
      entity_id: 1, name: "HarnessBot", game_mode: "survival" as const,
      hp: 20, max_hp: 20, hunger: 20,
      position: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 },
      dimension: "minecraft:overworld", equipment: {},
      backpack_slots: { used: 0, total: 41 }, on_ground: true, in_water: false,
      air: "300/300", in_lava: false, underwater: false, on_fire: false,
      suffocating: false, intersecting_blocks: [], fall_distance: 0, facing, feet,
      velocity: { x: 0, y: 0, z: 0 }, active_effects: [],
    },
  };
}

function region(center: Position, changes: readonly (readonly [Position, unknown])[]) {
  const min = { x: center.x - 8, y: center.y - 17, z: center.z - 8 };
  const size = { x: 17, y: 35, z: 17 };
  const palette: unknown[] = [{ state: "UNKNOWN" }];
  const indices = Array<number>(size.x * size.y * size.z).fill(0);
  for (const [position, cell] of changes) {
    const index = palette.push(cell) - 1;
    indices[regionIndex(position, min, size)] = index;
  }
  return {
    ok: true as const,
    message: "selected Block Knowledge",
    data: { operation: "block.region", dimension: "minecraft:overworld", min, size, palette, indices, complete: false },
  };
}

function knownAir() {
  return { state: "KNOWN_AIR", source: "test", observed_tick: 1, observation_revision: 1 };
}

function knownBlock(block_state: string) {
  return {
    state: "KNOWN_BLOCK", block_state, fluid: "minecraft:empty",
    source: "test", observed_tick: 1, observation_revision: 1,
  };
}

function positionSchema() {
  return s.object({
    x: s.field(s.integer(), { description: "Test X." }),
    y: s.field(s.integer(), { description: "Test Y." }),
    z: s.field(s.integer(), { description: "Test Z." }),
  });
}

function regionData(min: Position, size: Position) {
  return {
    operation: "block.region" as const,
    dimension: "minecraft:overworld",
    min,
    size,
    palette: [{ state: "UNKNOWN" as const }],
    indices: Array<number>(size.x * size.y * size.z).fill(0),
    complete: false,
  };
}

function regionIndex(position: Position, min: Position, size: Position): number {
  return position.x - min.x + size.x * (position.y - min.y + size.y * (position.z - min.z));
}

function isLookAroundResult(value: unknown): value is { ok: true; data: { grid: string[] } } {
  if (value === null || typeof value !== "object" || !("ok" in value) || value.ok !== true) return false;
  if (!("data" in value) || value.data === null || typeof value.data !== "object") return false;
  return "grid" in value.data && Array.isArray(value.data.grid)
    && value.data.grid.every((row) => typeof row === "string");
}
