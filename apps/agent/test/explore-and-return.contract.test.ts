import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";
import { toolSchema as s } from "../src/harness/tool-schema.js";

const start = { x: 0, y: 64, z: 0 };

describe("explore_and_return Exploration Excursion", () => {
  it("defaults return_to_start to false while accepting an explicit return choice", () => {
    const explore = explorationDefinition();

    expect(explore.input.parse({})).toEqual({});
    expect(explore.input.parse({ max_outbound_displacement: 12 })).toEqual({
      max_outbound_displacement: 12,
    });
    expect(explore.input.parse({
      max_outbound_displacement: 12,
      return_to_start: false,
    })).toEqual({
      max_outbound_displacement: 12,
      return_to_start: false,
    });
    expect(explore.input.parse({
      max_outbound_displacement: 12,
      return_to_start: true,
      route_seed: -9,
    })).toEqual({
      max_outbound_displacement: 12,
      return_to_start: true,
      route_seed: -9,
    });
    expect(() => explore.input.parse({
      max_outbound_displacement: 12,
      return_to_start: true,
      block_id_glob: "minecraft:*_log",
    })).toThrow(/block_id_glob is not supported/u);
  });

  it("defaults max_outbound_displacement to 128", async () => {
    let current = start;
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => frontierEvidence(current, [{
        x: current.x, y: current.y, z: current.z - 4,
      }]),
      goto: async (input) => {
        current = { x: input.x, y: input.y, z: input.z };
        targets.push(current);
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      route_seed: 23,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        final_feet: { x: 0, y: 64, z: -128 },
        outbound_displacement: 128,
        return_displacement: 0,
        visited_anchor_count: 33,
        attempted_target_count: 32,
      },
    });
    expect(targets).toHaveLength(32);
  });

  it("reports a fixed-seed no-progress result through the public Composite seam", async () => {
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(start, "north"),
      observeBlocks: async () => regionEvidence(start, []),
      goto: async () => { throw new Error("no navigation should be attempted"); },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 8,
      return_to_start: true,
      route_seed: 17,
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "no verified outward movement was available",
      data: {
        failure_type: "no_progress",
        route_seed: 17,
        outbound_displacement: 0,
        return_displacement: 0,
        visited_anchor_count: 1,
        attempted_target_count: 0,
        final_feet: start,
      },
    });
  });

  it("makes one evidence-backed outward movement and returns exactly with OPEN-only navigation", async () => {
    const outward = { x: 0, y: 64, z: -4 };
    let current = start;
    const calls: Array<{ name: string; input: unknown }> = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async (input) => {
        calls.push({ name: "observe_blocks", input });
        return regionEvidence(current, [outward]);
      },
      goto: async (input) => {
        calls.push({ name: "goto", input });
        current = { x: input.x, y: input.y, z: input.z };
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 4,
      return_to_start: true,
      route_seed: 23,
    })).resolves.toEqual({
      ok: true,
      message: "completed bounded Exploration Excursion and returned exactly",
      data: {
        start_feet: start,
        final_feet: start,
        route_seed: 23,
        outbound_displacement: 4,
        return_displacement: 4,
        visited_anchor_count: 2,
        attempted_target_count: 1,
      },
    });
    expect(calls).toEqual([
      { name: "observe_blocks", input: { radius: 4 } },
      { name: "goto", input: { ...outward, route_mutation_permissions: ["OPEN"] } },
      { name: "goto", input: { ...start, route_mutation_permissions: ["OPEN"] } },
    ]);
  });

  it("retains the explored position when return_to_start is omitted", async () => {
    const outward = { x: 0, y: 64, z: -4 };
    let current = start;
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => regionEvidence(current, [outward]),
      goto: async (input) => {
        current = { x: input.x, y: input.y, z: input.z };
        targets.push(current);
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 4,
      route_seed: 23,
    })).resolves.toEqual({
      ok: true,
      message: "completed bounded Exploration Excursion",
      data: {
        start_feet: start,
        final_feet: outward,
        route_seed: 23,
        outbound_displacement: 4,
        return_displacement: 0,
        visited_anchor_count: 2,
        attempted_target_count: 1,
      },
    });
    expect(targets).toEqual([outward]);
  });

  it("does not spend novel exploration budget on backtracking and reaches a sibling branch", async () => {
    const first = { x: 0, y: 64, z: -2 };
    const deadEnd = { x: 0, y: 65, z: -4 };
    const otherBranch = { x: 3, y: 64, z: -2 };
    let current = start;
    let firstVisits = 0;
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => {
        const candidates = samePosition(current, start) ? [first]
          : samePosition(current, first) ? (firstVisits++ === 0 ? [deadEnd] : [otherBranch])
          : [];
        return regionEvidence(current, candidates, {
          unknown: candidates.map((candidate) => ({ ...candidate, x: candidate.x + 1 })),
        });
      },
      goto: async (input) => {
        current = { x: input.x, y: input.y, z: input.z };
        targets.push(current);
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 8,
      return_to_start: true,
      route_seed: 41,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        outbound_displacement: 8,
        return_displacement: 5,
        visited_anchor_count: 4,
        attempted_target_count: 3,
      },
    });
    expect(targets).toEqual([first, deadEnd, first, otherBranch, first, start]);
  });

  it("does not retarget intermediate Feet Cells on an already explored cave route", async () => {
    const first = { x: 0, y: 64, z: -4 };
    const deadEnd = { x: 0, y: 64, z: -8 };
    const otherBranch = { x: 3, y: 65, z: -4 };
    const corridorTowardDeadEnd = { x: 0, y: 64, z: -6 };
    const corridorTowardStart = { x: 0, y: 64, z: -2 };
    let current = start;
    let firstVisits = 0;
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => {
        const candidates = samePosition(current, start) ? [first]
          : samePosition(current, first) ? (firstVisits++ === 0
            ? [deadEnd]
            : firstVisits === 2
              ? [otherBranch]
              : [corridorTowardDeadEnd, corridorTowardStart])
          : [];
        return frontierEvidence(current, candidates);
      },
      goto: async (input) => {
        current = { x: input.x, y: input.y, z: input.z };
        targets.push(current);
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 20,
      return_to_start: true,
      route_seed: 5,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        outbound_displacement: 12,
        return_displacement: 0,
        visited_anchor_count: 4,
        attempted_target_count: 3,
        final_feet: start,
      },
    });
    expect(targets).toEqual([first, deadEnd, first, otherBranch, first, start]);
  });

  it("rejects a failed target while retaining its verified partial navigation anchor", async () => {
    const failedTarget = { x: 0, y: 64, z: -4 };
    const partial = { x: 0, y: 64, z: -2 };
    const otherBranch = { x: 3, y: 64, z: -2 };
    let current = start;
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => {
        const candidates = samePosition(current, start) ? [failedTarget]
          : samePosition(current, partial) ? [otherBranch] : [];
        return frontierEvidence(current, candidates);
      },
      goto: async (input) => {
        const target = { x: input.x, y: input.y, z: input.z };
        targets.push(target);
        if (samePosition(target, failedTarget)) {
          current = partial;
          return { ok: false as const, error: "RUNTIME_FAILED" as const,
            message: "speculative frontier", data: {} };
        }
        current = target;
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 5,
      return_to_start: true,
      route_seed: 7,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        outbound_displacement: 5,
        return_displacement: 5,
        visited_anchor_count: 3,
        attempted_target_count: 2,
      },
    });
    expect(targets).toEqual([failedTarget, otherBranch, partial, start]);
  });

  it("rejects a no-movement failure and selects another candidate from the same anchor", async () => {
    const rejected = { x: 0, y: 64, z: -4 };
    const accepted = { x: 4, y: 64, z: 0 };
    let current = start;
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => frontierEvidence(current,
        samePosition(current, start) ? [rejected, accepted] : []),
      goto: async (input) => {
        const target = { x: input.x, y: input.y, z: input.z };
        targets.push(target);
        if (samePosition(target, rejected)) {
          return { ok: false as const, error: "RUNTIME_FAILED" as const,
            message: "blocked", data: {} };
        }
        current = target;
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 4,
      return_to_start: true,
      route_seed: 5,
    })).resolves.toMatchObject({ ok: true, data: { attempted_target_count: 2 } });
    expect(targets).toEqual([rejected, accepted, start]);
  });

  it("makes one direct OPEN-only start attempt when an anchor return fails", async () => {
    const first = { x: 0, y: 64, z: -2 };
    const second = { x: 0, y: 64, z: -4 };
    let current = start;
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => frontierEvidence(current,
        samePosition(current, start) ? [first] : samePosition(current, first) ? [second] : []),
      goto: async (input) => {
        const target = { x: input.x, y: input.y, z: input.z };
        targets.push(target);
        if (samePosition(current, second) && samePosition(target, first)) {
          return { ok: false as const, error: "RUNTIME_FAILED" as const,
            message: "anchor route failed", data: {} };
        }
        current = target;
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 4,
      return_to_start: true,
      route_seed: 13,
    })).resolves.toMatchObject({ ok: true, data: { return_displacement: 4 } });
    expect(targets).toEqual([first, second, first, start]);
  });

  it("returns bounded return_failed after its one direct-start retry also fails", async () => {
    const outward = { x: 0, y: 64, z: -4 };
    let current = start;
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => frontierEvidence(current,
        samePosition(current, start) ? [outward] : []),
      goto: async (input) => {
        const target = { x: input.x, y: input.y, z: input.z };
        targets.push(target);
        if (samePosition(target, outward)) {
          current = target;
          return navigationSuccess(current);
        }
        return { ok: false as const, error: "RUNTIME_FAILED" as const,
          message: "return route failed", data: {} };
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 4,
      return_to_start: true,
      route_seed: 5,
    })).resolves.toMatchObject({
      ok: false, error: "RUNTIME_FAILED",
      data: { failure_type: "return_failed", final_feet: outward, return_displacement: 0 },
    });
    expect(targets).toEqual([outward, start, start]);
  });

  it("returns INTERRUPTED without starting a return after external cancellation", async () => {
    const outward = { x: 0, y: 64, z: -4 };
    const controller = new AbortController();
    const targets: Position[] = [];
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(start, "north"),
      observeBlocks: async () => frontierEvidence(start, [outward]),
      goto: async (input) => {
        targets.push({ x: input.x, y: input.y, z: input.z });
        controller.abort();
        return navigationSuccess(outward);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 4,
      return_to_start: true,
      route_seed: 29,
    }, { signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      error: "INTERRUPTED",
      data: { outbound_displacement: 0, return_displacement: 0, final_feet: start },
    });
    expect(targets).toEqual([outward]);
  });

  it("does not report success when verified outbound movement exceeds the caller bound", async () => {
    const target = { x: 4, y: 64, z: 0 };
    const overshot = { x: 5, y: 64, z: 0 };
    let current = start;
    let calls = 0;
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "east"),
      observeBlocks: async () => regionEvidence(current, [target]),
      goto: async (input) => {
        calls += 1;
        current = calls === 1 ? overshot : { x: input.x, y: input.y, z: input.z };
        return navigationSuccess(current);
      },
    });

    await expect(runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 4,
      return_to_start: true,
      route_seed: 19,
    })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      data: {
        failure_type: "exploration_failed",
        outbound_displacement: 5,
        return_displacement: 5,
        final_feet: start,
      },
    });
  });

  it("requires known feet, head, and support evidence within the fixed local geometry", async () => {
    const valid = { x: 4, y: 64, z: 0 };
    const occupiedFeet = { x: 0, y: 64, z: -4 };
    const occupiedHead = { x: -4, y: 64, z: 0 };
    const unsupported = { x: 0, y: 64, z: 4 };
    const tooNear = { x: 1, y: 64, z: 0 };
    const tooFar = { x: 4, y: 64, z: 1 };
    const tooHigh = { x: 1, y: 67, z: 0 };

    const selected = await selectedCandidate({
      candidates: [valid, occupiedFeet, occupiedHead, unsupported, tooNear, tooFar, tooHigh],
      overrides: [
        [occupiedFeet, "KNOWN_BLOCK"],
        [{ ...occupiedHead, y: occupiedHead.y + 1 }, "KNOWN_BLOCK"],
        [{ ...unsupported, y: unsupported.y - 1 }, "KNOWN_AIR"],
      ],
      seed: 5,
    });

    expect(selected).toEqual(valid);
  });

  it("prefers sustained outward heading over a small local frontier-count difference", async () => {
    const north = { x: 0, y: 64, z: -3 };
    const east = { x: 3, y: 64, z: 0 };

    const selected = await selectedCandidate({
      candidates: [north, east],
      unknown: [
        { x: 1, y: 64, z: -3 },
        { x: 3, y: 64, z: 1 },
        { x: 3, y: 65, z: 1 },
      ],
      seed: 5,
    });

    expect(selected).toEqual(north);
  });

  it("orders novelty before heading continuity after verified outward progress", async () => {
    const first = { x: 0, y: 64, z: -2 };
    const forward = { x: 0, y: 64, z: -4 };
    const novel = { x: 3, y: 64, z: -2 };
    let current = start;
    const targets: Position[] = [];
    const controller = new AbortController();
    const runtime = await explorationRuntime({
      observeSelf: async () => selfEvidence(current, "north"),
      observeBlocks: async () => samePosition(current, start)
        ? regionEvidence(current, [first], { unknown: [{ x: 1, y: 64, z: -2 }] })
        : regionEvidence(current, [forward, novel], {
          unknown: [{ x: 1, y: 64, z: -4 }, { x: 3, y: 64, z: -1 }],
        }),
      goto: async (input) => {
        const target = { x: input.x, y: input.y, z: input.z };
        targets.push(target);
        if (targets.length === 2) controller.abort();
        else current = target;
        return navigationSuccess(target);
      },
    });

    await runtime.dispatch("explore_and_return", {
      max_outbound_displacement: 12,
      return_to_start: true,
      route_seed: 5,
    }, { signal: controller.signal });

    expect(targets).toEqual([first, novel]);
  });

  it("orders heading continuity before seeded tie-breaking", async () => {
    const north = { x: 0, y: 64, z: -3 };
    const east = { x: 3, y: 64, z: 0 };

    const selected = await selectedCandidate({
      candidates: [north, east],
      unknown: [{ x: 1, y: 64, z: -3 }, { x: 3, y: 64, z: 1 }],
      seed: 3,
    });

    expect(selected).toEqual(north);
  });

  it("uses the effective seed only as the final candidate tie-break", async () => {
    const east = { x: 3, y: 64, z: 0 };
    const west = { x: -3, y: 64, z: 0 };
    const evidence = {
      candidates: [east, west],
      unknown: [{ x: 3, y: 64, z: 1 }, { x: -3, y: 64, z: 1 }],
    };

    await expect(selectedCandidate({ ...evidence, seed: 0 })).resolves.toEqual(west);
    await expect(selectedCandidate({ ...evidence, seed: 3 })).resolves.toEqual(east);
  });
});

type Position = { x: number; y: number; z: number };
type Facing = "north" | "east" | "south" | "west";
type ExplorationHandlers = Readonly<{
  observeSelf: () => Promise<unknown>;
  observeBlocks: (input: { radius?: number }) => Promise<unknown>;
  goto: (input: Position & { route_mutation_permissions?: readonly string[] }) => Promise<unknown>;
}>;

async function explorationRuntime(handlers: ExplorationHandlers): Promise<AbilityRuntime> {
  const runtime = new AbilityRuntime();
  await runtime.register(defineAbility({
    name: "observe_self", description: "Scripted exact Feet Cell evidence.",
    concurrency: "safe", execution: "query", input: s.object({}), output: s.losslessJson(),
    execute: handlers.observeSelf,
  }));
  await runtime.register(defineAbility({
    name: "observe_blocks", description: "Scripted bounded block evidence.",
    concurrency: "safe", execution: "query",
    input: s.object({
      radius: s.optional(s.integer({ minimum: 1, maximum: 16 }), { description: "Test radius." }),
    }),
    output: s.losslessJson(), execute: handlers.observeBlocks,
  }));
  await runtime.register(defineAbility({
    name: "goto", description: "Scripted exact navigation.", execution: "body",
    input: s.object({
      x: s.field(s.integer(), { description: "Test X." }),
      y: s.field(s.integer(), { description: "Test Y." }),
      z: s.field(s.integer(), { description: "Test Z." }),
      route_mutation_permissions: s.optional(s.array(s.string()), { description: "Test permission." }),
    }),
    output: s.losslessJson(), execute: handlers.goto,
  }));
  await runtime.register(explorationDefinition());
  return runtime;
}

function explorationDefinition() {
  const explore = projectCompositeAbilities.find(({ name }) => name === "explore_and_return");
  if (explore === undefined) throw new Error("explore_and_return Project Composite is not registered");
  return explore;
}

async function selectedCandidate(input: Readonly<{
  candidates: readonly Position[];
  unknown?: readonly Position[];
  overrides?: readonly (readonly [Position, EvidenceState])[];
  seed: number;
}>): Promise<Position> {
  const controller = new AbortController();
  let selected: Position | undefined;
  const runtime = await explorationRuntime({
    observeSelf: async () => selfEvidence(start, "north"),
    observeBlocks: async () => regionEvidence(start, input.candidates, input),
    goto: async (target) => {
      selected = { x: target.x, y: target.y, z: target.z };
      controller.abort();
      return navigationSuccess(selected);
    },
  });
  await runtime.dispatch("explore_and_return", {
    max_outbound_displacement: 16,
    return_to_start: false,
    route_seed: input.seed,
  }, { signal: controller.signal });
  if (selected === undefined) throw new Error("exploration selected no candidate");
  return selected;
}

function selfEvidence(feet: Position, facing: Facing) {
  return { ok: true as const, message: "self", data: { feet, facing } };
}

function navigationSuccess(feet: Position) {
  return {
    ok: true as const,
    message: "arrived",
    data: {
      position: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 },
      ground_y: feet.y - 1,
    },
  };
}

function frontierEvidence(center: Position, candidates: readonly Position[]) {
  return regionEvidence(center, candidates, {
    unknown: candidates.map((candidate) => ({ ...candidate, x: candidate.x + 1 })),
  });
}

type EvidenceState = "UNKNOWN" | "KNOWN_AIR" | "KNOWN_BLOCK";

function regionEvidence(
  center: Position,
  candidates: readonly Position[],
  options: Readonly<{
    unknown?: readonly Position[];
    overrides?: readonly (readonly [Position, EvidenceState])[];
  }> = {},
) {
  const radius = 4;
  const min = { x: center.x - radius, y: center.y - radius, z: center.z - radius };
  const size = { x: 9, y: 9, z: 9 };
  const palette = [
    { state: "UNKNOWN" as const },
    {
      state: "KNOWN_BLOCK" as const, block_state: "minecraft:stone", fluid: "minecraft:empty",
      source: "vision", observed_tick: 10, observation_revision: 2,
    },
    {
      state: "KNOWN_AIR" as const, source: "vision", observed_tick: 10, observation_revision: 2,
    },
  ];
  const indices = Array<number>(size.x * size.y * size.z).fill(1);
  for (const candidate of candidates) {
    indices[regionIndex(candidate, min, size)] = 2;
    indices[regionIndex({ ...candidate, y: candidate.y + 1 }, min, size)] = 2;
    indices[regionIndex({ ...candidate, y: candidate.y - 1 }, min, size)] = 1;
  }
  for (const position of options.unknown ?? []) indices[regionIndex(position, min, size)] = 0;
  for (const [position, state] of options.overrides ?? []) {
    indices[regionIndex(position, min, size)] = state === "UNKNOWN" ? 0 : state === "KNOWN_BLOCK" ? 1 : 2;
  }
  return {
    ok: true as const,
    message: "bounded region",
    data: {
      operation: "block.region" as const,
      dimension: "minecraft:overworld",
      min, size, palette, indices, complete: false,
    },
  };
}

function regionIndex(position: Position, min: Position, size: Position) {
  return position.x - min.x + size.x * (position.y - min.y + size.y * (position.z - min.z));
}

function samePosition(left: Position, right: Position) {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}
