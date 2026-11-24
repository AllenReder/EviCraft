import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

type Position = { x: number; y: number; z: number };

const AIR = "minecraft:air";
const STONE = "minecraft:stone";
const WATER = "minecraft:water[level=0]";
const LAVA = "minecraft:lava[level=0]";

/** A tiny voxel world: unlisted cells are known stone; listed cells may be air, fluids, ores, or unknown. */
class FakeWorld {
  readonly blocks = new Map<string, string>();
  readonly unknown = new Set<string>();
  readonly calls: string[] = [];
  feet: Position;
  gotoFailure: ((destination: Position) => boolean) | undefined;

  constructor(feet: Position) {
    this.feet = feet;
    this.set(feet, AIR);
    this.set(offset(feet, 0, 1, 0), AIR);
  }

  set(position: Position, state: string) {
    this.blocks.set(key(position), state);
    return this;
  }

  hide(position: Position) {
    this.unknown.add(key(position));
    return this;
  }

  state(position: Position) {
    return this.blocks.get(key(position)) ?? STONE;
  }

  evidence(position: Position) {
    if (this.unknown.has(key(position))) return { state: "UNKNOWN" as const };
    const state = this.state(position);
    if (state === AIR) return { state: "KNOWN_AIR" as const, source: "vision", observed_tick: 1, observation_revision: 1 };
    const fluid = state.startsWith("minecraft:water") ? "minecraft:water[falling=false]"
      : state.startsWith("minecraft:lava") ? "minecraft:lava[falling=false]" : "minecraft:empty";
    return {
      state: "KNOWN_BLOCK" as const, block_state: state, fluid,
      source: "vision", observed_tick: 1, observation_revision: 1,
    };
  }

  passable(position: Position) {
    const state = this.state(position);
    return state === AIR || state.startsWith("minecraft:water");
  }

  floor(position: Position) {
    const state = this.state(position);
    return state !== AIR && !state.startsWith("minecraft:water") && !state.startsWith("minecraft:lava");
  }

  settleFeet() {
    while (this.passable(offset(this.feet, 0, -1, 0)) && this.feet.y > -64) {
      this.feet = offset(this.feet, 0, -1, 0);
    }
  }
}

type Overrides = Partial<Record<string, (value: unknown) => unknown>>;

async function runtimeFor(world: FakeWorld) {
  const runtime = new AbilityRuntime();
  await registerWith(runtime, world, {});
  return runtime;
}

async function registerWith(runtime: AbilityRuntime, world: FakeWorld, overrides: Overrides) {
  const definitions = [
    defineAbility({
      name: "observe_self", description: "Fake self.", concurrency: "safe", execution: "query",
      input: s.object({}), output: s.losslessJson(),
      execute: () => ({ ok: true, message: "self", data: { feet: world.feet, on_ground: true, in_water: false } }),
    }),
    defineAbility({
      name: "observe_block", description: "Fake block.", concurrency: "safe", execution: "query",
      input: s.losslessJson(), output: s.losslessJson(),
      execute: (position) => {
        const target = position as Position;
        world.calls.push(`observe_block ${label(target)}`);
        return { ok: true, message: "block", data: { operation: "block.get", cells: [{ dimension: "minecraft:overworld", position: target, ...world.evidence(target) }] } };
      },
    }),
    defineAbility({
      name: "observe_blocks", description: "Fake region.", concurrency: "safe", execution: "query",
      input: s.losslessJson(), output: s.losslessJson(),
      execute: (value) => {
        const { min, max } = value as { min: Position; max: Position };
        world.calls.push(`observe_blocks ${label(min)}..${label(max)}`);
        const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
        const palette: unknown[] = [];
        const lookup = new Map<string, number>();
        const indices: number[] = [];
        for (let dz = 0; dz < size.z; dz += 1) {
          for (let dy = 0; dy < size.y; dy += 1) {
            for (let dx = 0; dx < size.x; dx += 1) {
              const evidence = world.evidence(offset(min, dx, dy, dz));
              const id = JSON.stringify(evidence);
              if (!lookup.has(id)) {
                lookup.set(id, palette.length);
                palette.push(evidence);
              }
              indices[dx + size.x * (dy + size.y * dz)] = lookup.get(id)!;
            }
          }
        }
        return { ok: true, message: "region", data: { operation: "block.region", dimension: "minecraft:overworld", min, size, palette, indices, complete: true } };
      },
    }),
    defineAbility({
      name: "break_block", description: "Fake break.", execution: "body",
      input: s.losslessJson(), output: s.losslessJson(),
      execute: (value) => {
        const { position } = value as { position: Position };
        world.calls.push(`break ${label(position)}`);
        const evidence = world.evidence(position);
        if (evidence.state !== "KNOWN_BLOCK") {
          return { ok: false, error: "RUNTIME_FAILED", message: "not known block", data: { position, failure_type: "target_not_known_block" } };
        }
        world.set(position, AIR);
        world.settleFeet();
        return { ok: true, message: "broken", data: { position, observed_drop_entities: [] } };
      },
    }),
    defineAbility({
      name: "goto", description: "Fake exact goto.", execution: "body",
      input: s.losslessJson(), output: s.losslessJson(),
      execute: (value) => {
        const destination = value as Position & { exact?: boolean };
        world.calls.push(`goto ${label(destination)}${destination.exact === true ? " exact" : ""}`);
        const standable = world.passable(destination) && world.passable(offset(destination, 0, 1, 0))
          && world.floor(offset(destination, 0, -1, 0));
        if (!standable || world.gotoFailure?.(destination) === true) {
          return { ok: false, error: "RUNTIME_FAILED", message: "blocked: no path", data: {} };
        }
        world.feet = { x: destination.x, y: destination.y, z: destination.z };
        return { ok: true, message: "arrived", data: { position: { x: destination.x + 0.5, y: destination.y, z: destination.z + 0.5 }, ground_y: destination.y - 1 } };
      },
    }),
    defineAbility({
      name: "wait", description: "Fake wait.", concurrency: "safe", execution: "query",
      input: s.losslessJson(), output: s.losslessJson(),
      execute: () => ({ ok: true, message: "wait completed", data: {} }),
    }),
    defineAbility({
      name: "find_known_blocks", description: "Fake remembered blocks.", concurrency: "safe", execution: "query",
      input: s.losslessJson(), output: s.losslessJson(),
      execute: (value) => {
        const { block_id_glob } = value as { block_id_glob: string };
        const pattern = new RegExp(`^${block_id_glob.replace(/[.]/gu, "\\.").replace(/\*/gu, ".*")}$`, "u");
        const matches = [...world.blocks.entries()]
          .filter(([cell, state]) => !world.unknown.has(cell) && pattern.test(state.split("[")[0]!))
          .map(([cell, block_state]) => ({ position: parse(cell), block_state }));
        return { ok: true, message: "found", data: { matches, truncated: false } };
      },
    }),
  ];
  for (const definition of definitions) {
    const override = overrides[definition.name];
    await runtime.register(override === undefined ? definition : defineAbility({
      name: definition.name, description: definition.description, execution: "body",
      input: s.losslessJson(), output: s.losslessJson(), execute: override,
    }));
  }
  for (const name of ["mine_down", "tunnel_for_blocks"]) {
    await runtime.register(projectCompositeAbilities.find((definition) => definition.name === name)!);
  }
}

describe("adaptive mine_down Project Composite", () => {
  it("excavates a supported staircase with exact steps and reports the verified final feet", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    const runtime = await runtimeFor(world);

    const result = await runtime.dispatch("mine_down", { depth: 2, direction: "north" });

    expect(result).toEqual({
      ok: true, message: "completed bounded descent",
      data: {
        completed_depth: 2,
        broken: [
          { x: 0, y: 65, z: -1 }, { x: 0, y: 64, z: -1 }, { x: 0, y: 63, z: -1 },
          { x: 0, y: 64, z: -2 }, { x: 0, y: 63, z: -2 }, { x: 0, y: 62, z: -2 },
        ],
        feet: { x: 0, y: 62, z: -2 },
      },
    });
    expect(world.calls.filter((call) => call.startsWith("goto"))).toEqual([
      "goto 0,63,-1 exact", "goto 0,62,-2 exact",
    ]);
    expect(world.calls.filter((call) => call.startsWith("observe_block "))).toEqual([]);
  });

  it("turns to a perpendicular step when the planned step is over open space and keeps that heading", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    for (let y = 50; y <= 62; y += 1) world.set({ x: 0, y, z: -1 }, AIR);
    const runtime = await runtimeFor(world);

    const result = await runtime.dispatch("mine_down", { depth: 2, direction: "north" });

    expect(result).toMatchObject({ ok: true, data: { completed_depth: 2, feet: { x: 2, y: 62, z: 0 } } });
    expect(world.calls.filter((call) => call.startsWith("goto"))).toEqual([
      "goto 1,63,0 exact", "goto 2,62,0 exact",
    ]);
  });

  it("stops with open_space_below and partial progress when every tried step is open", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    for (const [x, z] of [[0, -1], [1, 0], [-1, 0]] as const) {
      for (let y = 55; y <= 62; y += 1) world.set({ x, y, z }, AIR);
    }
    const runtime = await runtimeFor(world);

    const result = await runtime.dispatch("mine_down", { depth: 4, direction: "north" });

    expect(result).toMatchObject({
      ok: false, error: "RUNTIME_FAILED",
      data: {
        completed_depth: 0,
        feet: { x: 0, y: 64, z: 0 },
        failure_type: "open_space_below",
        blocking_cell: { position: { x: 0, y: 62, z: -1 }, state: "KNOWN_AIR" },
        known_air_below: 4,
      },
    });
    expect(world.calls.some((call) => call.startsWith("goto"))).toBe(false);
  });

  it("takes a short known drop onto a known floor instead of stopping", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    world.set({ x: 0, y: 62, z: -1 }, AIR).set({ x: 0, y: 61, z: -1 }, AIR);
    const runtime = await runtimeFor(world);

    const result = await runtime.dispatch("mine_down", { depth: 3, direction: "north" });

    expect(result).toMatchObject({ ok: true, data: { completed_depth: 3, feet: { x: 0, y: 61, z: -1 } } });
    expect(world.calls.filter((call) => call.startsWith("goto"))).toEqual(["goto 0,61,-1 exact"]);
  });

  it("passes water without breaking and stops before lava without breaking", async () => {
    const watery = new FakeWorld({ x: 0, y: 64, z: 0 });
    watery.set({ x: 0, y: 64, z: -1 }, WATER);
    const wateryResult = await (await runtimeFor(watery)).dispatch("mine_down", { depth: 1, direction: "north" });
    expect(wateryResult).toMatchObject({
      ok: true, data: { completed_depth: 1, broken: [{ x: 0, y: 65, z: -1 }, { x: 0, y: 63, z: -1 }] },
    });

    const lava = new FakeWorld({ x: 0, y: 64, z: 0 });
    lava.set({ x: 0, y: 62, z: -1 }, LAVA);
    const lavaResult = await (await runtimeFor(lava)).dispatch("mine_down", { depth: 1, direction: "north" });
    expect(lavaResult).toMatchObject({
      ok: false,
      data: { completed_depth: 0, broken: [], failure_type: "hazard", blocking_cell: { position: { x: 0, y: 62, z: -1 }, state: LAVA } },
    });
    expect(lava.calls.some((call) => call.startsWith("break"))).toBe(false);
  });

  it("reports unknown evidence and blocked exact navigation as distinct stops", async () => {
    const hidden = new FakeWorld({ x: 0, y: 64, z: 0 });
    hidden.hide({ x: 0, y: 65, z: -1 });
    const hiddenResult = await (await runtimeFor(hidden)).dispatch("mine_down", { depth: 1, direction: "north" });
    expect(hiddenResult).toMatchObject({
      ok: false, data: { failure_type: "unknown_evidence", blocking_cell: { position: { x: 0, y: 65, z: -1 }, state: "UNKNOWN" } },
    });

    const blocked = new FakeWorld({ x: 0, y: 64, z: 0 });
    blocked.gotoFailure = () => true;
    const blockedResult = await (await runtimeFor(blocked)).dispatch("mine_down", { depth: 1, direction: "north" });
    expect(blockedResult).toMatchObject({
      ok: false, message: "blocked: no path", data: { completed_depth: 0, failure_type: "blocked", feet: { x: 0, y: 64, z: 0 } },
    });
  });

  it("waits briefly for unobserved step evidence and retries one target_changed break", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    world.hide({ x: 0, y: 64, z: -1 });
    const original = world.evidence.bind(world);
    let reads = 0;
    world.evidence = (position: Position) => {
      if (position.x === 0 && position.y === 64 && position.z === -1 && (reads += 1) >= 2) world.unknown.clear();
      return original(position);
    };
    let changed = true;
    const runtime = await runtimeFor(world);
    const result = await runtime.dispatch("mine_down", { depth: 1, direction: "north" });
    expect(result).toMatchObject({ ok: true, data: { completed_depth: 1 } });
    expect(world.calls.filter((call) => call === "observe_block 0,64,-1").length).toBeGreaterThanOrEqual(1);

    const retried = new FakeWorld({ x: 0, y: 64, z: 0 });
    const retryRuntime = new AbilityRuntime();
    await registerWith(retryRuntime, retried, {
      break_block: (value) => {
        const { position } = value as { position: Position };
        retried.calls.push(`break ${label(position)}`);
        if (changed && position.y === 64) {
          changed = false;
          return { ok: false, error: "RUNTIME_FAILED", message: "changed", data: { position, failure_type: "target_changed" } };
        }
        retried.set(position, AIR);
        return { ok: true, message: "broken", data: { position, observed_drop_entities: [] } };
      },
    });
    expect(await retryRuntime.dispatch("mine_down", { depth: 1, direction: "north" })).toMatchObject({
      ok: true, data: { completed_depth: 1, broken: [{ x: 0, y: 65, z: -1 }, { x: 0, y: 64, z: -1 }, { x: 0, y: 63, z: -1 }] },
    });
    expect(retried.calls.filter((call) => call === "break 0,64,-1")).toHaveLength(2);
  });

  it("digs a direct shaft, accepts a short fall, and refuses a known deep drop", async () => {
    const shaft = new FakeWorld({ x: 0, y: 64, z: 0 });
    shaft.set({ x: 0, y: 62, z: 0 }, AIR);
    const shaftResult = await (await runtimeFor(shaft)).dispatch("mine_down", { depth: 2, direction: "down" });
    expect(shaftResult).toMatchObject({
      ok: true, data: { completed_depth: 2, broken: [{ x: 0, y: 63, z: 0 }], feet: { x: 0, y: 62, z: 0 } },
    });

    const deep = new FakeWorld({ x: 0, y: 64, z: 0 });
    for (let y = 55; y <= 62; y += 1) deep.set({ x: 0, y, z: 0 }, AIR);
    const deepResult = await (await runtimeFor(deep)).dispatch("mine_down", { depth: 2, direction: "down" });
    expect(deepResult).toMatchObject({
      ok: false, data: { completed_depth: 0, broken: [], failure_type: "open_space_below", known_air_below: 4 },
    });
  });
});

describe("tunnel_for_blocks Project Composite", () => {
  it("succeeds with found=false after digging the full length without a match", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    const runtime = await runtimeFor(world);

    const result = await runtime.dispatch("tunnel_for_blocks", { block_id_glob: "minecraft:iron_ore", direction: "east", max_length: 2 });

    expect(result).toEqual({
      ok: true,
      message: "tunnelled 2 blocks without finding a matching block"
        + " (note: minecraft:iron_ore misses minecraft:deepslate_iron_ore; minecraft:*iron_ore matches both)",
      data: {
        found: false, completed_length: 2,
        broken: [{ x: 1, y: 65, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 65, z: 0 }, { x: 2, y: 64, z: 0 }],
        feet: { x: 2, y: 64, z: 0 },
      },
    });
    expect(world.calls.filter((call) => call.startsWith("goto"))).toEqual(["goto 1,64,0 exact", "goto 2,64,0 exact"]);
    expect(world.calls.filter((call) => call.startsWith("observe_blocks"))).toHaveLength(3);
  });

  it("returns an initial remembered match without digging", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    world.set({ x: 9, y: 20, z: 3 }, "minecraft:iron_ore");
    const runtime = await runtimeFor(world);

    expect(await runtime.dispatch("tunnel_for_blocks", { block_id_glob: "minecraft:iron_ore", direction: "west", max_length: 8 })).toEqual({
      ok: true, message: "found matching remembered block",
      data: { found: true, target: { position: { x: 9, y: 20, z: 3 }, block_state: "minecraft:iron_ore" }, completed_length: 0, broken: [], feet: { x: 0, y: 64, z: 0 } },
    });
    expect(world.calls.filter((call) => call.startsWith("break") || call.startsWith("goto"))).toEqual([]);
  });

  it("queries remembered blocks again when the frontier opens onto known air", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    world.set({ x: 1, y: 64, z: 1 }, AIR).set({ x: 6, y: 60, z: 6 }, "minecraft:iron_ore").hide({ x: 6, y: 60, z: 6 });
    const original = world.evidence.bind(world);
    world.evidence = (position: Position) => {
      if (world.feet.x >= 1) world.unknown.clear();
      return original(position);
    };
    const runtime = await runtimeFor(world);

    expect(await runtime.dispatch("tunnel_for_blocks", { block_id_glob: "minecraft:iron_ore", direction: "east", max_length: 4 })).toMatchObject({
      ok: true, message: "found matching remembered block",
      data: { found: true, target: { position: { x: 6, y: 60, z: 6 } }, completed_length: 1 },
    });
  });

  it("waits twice for unobserved clearance before stopping with unknown_evidence", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    world.hide({ x: 2, y: 64, z: 0 });
    const runtime = await runtimeFor(world);

    expect(await runtime.dispatch("tunnel_for_blocks", { block_id_glob: "minecraft:iron_ore", direction: "east", max_length: 3 })).toMatchObject({
      ok: false,
      data: { completed_length: 1, feet: { x: 1, y: 64, z: 0 }, failure_type: "unknown_evidence", blocking_cell: { position: { x: 2, y: 64, z: 0 }, state: "UNKNOWN" } },
    });
    expect(world.calls.filter((call) => call === "observe_block 2,64,0")).toHaveLength(3);
  });

  it("stops at a matching Tunnel Frontier block", async () => {
    const world = new FakeWorld({ x: 0, y: 64, z: 0 });
    world.set({ x: 2, y: 64, z: 1 }, "minecraft:iron_ore").hide({ x: 2, y: 64, z: 1 });
    const runtime = await runtimeFor(world);
    // The ore is only seen once the tunnel reaches it.
    const original = world.evidence.bind(world);
    world.evidence = (position: Position) => {
      if (world.feet.x >= 2) world.unknown.delete("2,64,1");
      return original(position);
    };

    const result = await runtime.dispatch("tunnel_for_blocks", { block_id_glob: "minecraft:iron_ore", direction: "east", max_length: 5 });

    expect(result).toMatchObject({
      ok: true, message: "found matching Tunnel Frontier block",
      data: { found: true, target: { position: { x: 2, y: 64, z: 1 }, block_state: "minecraft:iron_ore" }, completed_length: 2, feet: { x: 2, y: 64, z: 0 } },
    });
  });

  it("passes water, stops before lava, and reports open space under the next step", async () => {
    const watery = new FakeWorld({ x: 0, y: 64, z: 0 });
    watery.set({ x: 1, y: 64, z: 0 }, WATER);
    expect(await (await runtimeFor(watery)).dispatch("tunnel_for_blocks", { block_id_glob: "minecraft:iron_ore", direction: "east", max_length: 1 }))
      .toMatchObject({ ok: true, data: { found: false, completed_length: 1, broken: [{ x: 1, y: 65, z: 0 }] } });

    const lava = new FakeWorld({ x: 0, y: 64, z: 0 });
    lava.set({ x: 2, y: 65, z: 0 }, LAVA);
    expect(await (await runtimeFor(lava)).dispatch("tunnel_for_blocks", { block_id_glob: "minecraft:iron_ore", direction: "east", max_length: 3 }))
      .toMatchObject({ ok: false, data: { completed_length: 1, failure_type: "hazard", blocking_cell: { position: { x: 2, y: 65, z: 0 } } } });

    const cave = new FakeWorld({ x: 0, y: 64, z: 0 });
    cave.set({ x: 2, y: 63, z: 0 }, AIR);
    expect(await (await runtimeFor(cave)).dispatch("tunnel_for_blocks", { block_id_glob: "minecraft:iron_ore", direction: "east", max_length: 3 }))
      .toMatchObject({ ok: false, data: { completed_length: 1, feet: { x: 1, y: 64, z: 0 }, failure_type: "open_space_below" } });
  });
});

function offset(position: Position, dx: number, dy: number, dz: number): Position {
  return { x: position.x + dx, y: position.y + dy, z: position.z + dz };
}

function key(position: Position) {
  return `${position.x},${position.y},${position.z}`;
}

function parse(cell: string): Position {
  const [x, y, z] = cell.split(",").map(Number);
  return { x: x!, y: y!, z: z! };
}

function label(position: Position) {
  return `${position.x},${position.y},${position.z}`;
}
