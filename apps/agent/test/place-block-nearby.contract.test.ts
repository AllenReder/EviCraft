import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const itemId = "minecraft:cobblestone";
const origin = { x: 10, y: 64, z: -5 };

describe("place_block_nearby Project Composite contract", () => {
  it("freezes the exact 73 candidates from one feet snapshot in layer and distance order", async () => {
    const candidates = expectedCandidates(origin);
    const last = candidates.at(-1)!;
    expect(candidates).toHaveLength(73);
    expect(candidates).not.toContainEqual(origin);
    expect(candidates).not.toContainEqual({ ...origin, y: origin.y + 1 });
    expect(candidates).toContainEqual({ ...origin, y: origin.y - 1 });
    expect(candidates.slice(0, 24).every(({ y }) => y === origin.y)).toBe(true);
    expect(candidates.slice(24, 48).every(({ y }) => y === origin.y + 1)).toBe(true);
    expect(candidates.slice(48).every(({ y }) => y === origin.y - 1)).toBe(true);
    const scripted = await nearbyRuntime({
      observe_self: [selfAt(origin)],
      place_block: candidates.map((position) => localFailure("target not known air", position)),
    });

    const outcome = await scripted.runtime.dispatch("place_block_nearby", { item_id: itemId });
    expect(outcome).toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "no nearby placement candidate was verified",
      data: {
        item_id: itemId,
        origin,
        attempted_count: 73,
        last_attempt: {
          position: last,
          result: localFailure("target not known air", last),
        },
        failure_counts: { target_occupied: 73 },
      },
    });
    expect(scripted.invocations).toEqual([
      { name: "observe_self", input: {} },
      ...candidates.map((position) => ({ name: "place_block", input: { item_id: itemId, position } })),
    ]);
    expect(scripted.calls.filter((name) => name === "observe_self")).toHaveLength(1);
    expect(scripted.calls).not.toContain("goto");
    expect(scripted.calls).not.toContain("goto_and_place_block");
    scripted.expectExhausted();
  });

  it("returns compact success after candidate-local failures without retaining attempt history", async () => {
    const [first, second, third] = expectedCandidates(origin);
    const firstFailure = localFailure("target not known air", first!);
    const secondFailure = localFailure("no support", second!);
    const placed = placementSuccess(third!);
    const scripted = await nearbyRuntime({
      observe_self: [selfAt(origin)],
      place_block: [firstFailure, secondFailure, placed],
    });

    const outcome = await scripted.runtime.dispatch("place_block_nearby", { item_id: itemId });
    expect(outcome).toEqual({
      ok: true,
      message: placed.message,
      data: {
        item_id: itemId,
        origin,
        attempted_count: 3,
        successful_position: third,
        placement: placed,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("attempted_candidates");
    scripted.expectExhausted();
  });

  it.each([
    "menu_open",
    "item_not_found",
    "item_not_block",
    "multi_cell_item",
    "verification_failed",
  ] as const)("stops immediately after %s", async (failureType) => {
    const [first] = expectedCandidates(origin);
    const result = placementFailure(failureType, first!);
    const scripted = await nearbyRuntime({
      observe_self: [selfAt(origin)],
      place_block: [result],
    });

    await expect(scripted.runtime.dispatch("place_block_nearby", { item_id: itemId })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: result.message,
      data: {
        item_id: itemId,
        origin,
        attempted_count: 1,
        last_attempt: { position: first, result },
        failure_counts: { [failureType]: 1 },
      },
    });
    expect(scripted.calls).toEqual(["observe_self", "place_block"]);
    scripted.expectExhausted();
  });

  it("continues after no_effect only with explicit zero consumption and no observed BlockState", async () => {
    const [first, second] = expectedCandidates(origin);
    const noEffect = placementFailure("no_effect", first!, { consumed_count: 0 });
    const placed = placementSuccess(second!);
    const scripted = await nearbyRuntime({
      observe_self: [selfAt(origin)],
      place_block: [noEffect, placed],
    });

    await expect(scripted.runtime.dispatch("place_block_nearby", { item_id: itemId })).resolves.toMatchObject({
      ok: true,
      data: { attempted_count: 2, successful_position: second, placement: placed },
    });
    expect(scripted.calls).toEqual(["observe_self", "place_block", "place_block"]);
    scripted.expectExhausted();
  });

  it.each([
    ["has no verified consumption fact", {}],
    ["consumed an item", { consumed_count: 1 }],
    ["observed a BlockState", { consumed_count: 0, block_state: "minecraft:cobblestone" }],
  ] as const)("stops after unsafe no_effect when it %s", async (_detail, partialFacts) => {
    const [first] = expectedCandidates(origin);
    const noEffect = placementFailure("no_effect", first!, partialFacts);
    const scripted = await nearbyRuntime({
      observe_self: [selfAt(origin)],
      place_block: [noEffect],
    });

    await expect(scripted.runtime.dispatch("place_block_nearby", { item_id: itemId })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      message: noEffect.message,
      data: { attempted_count: 1, last_attempt: { position: first, result: noEffect } },
    });
    expect(scripted.calls).toEqual(["observe_self", "place_block"]);
    scripted.expectExhausted();
  });

  it("propagates a child interruption with its committed last attempt", async () => {
    const [first] = expectedCandidates(origin);
    const canceled = {
      ok: false as const,
      error: "INTERRUPTED" as const,
      message: "placement canceled",
      data: { item_id: itemId, position: first! },
    };
    const scripted = await nearbyRuntime({
      observe_self: [selfAt(origin)],
      place_block: [canceled],
    });

    await expect(scripted.runtime.dispatch("place_block_nearby", { item_id: itemId })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "placement canceled",
      data: {
        item_id: itemId,
        origin,
        attempted_count: 1,
        last_attempt: { position: first, result: canceled },
      },
    });
    expect(scripted.calls).toEqual(["observe_self", "place_block"]);
    scripted.expectExhausted();
  });

  it("stops before the next candidate when its Root is canceled", async () => {
    const controller = new AbortController();
    const [first] = expectedCandidates(origin);
    const firstFailure = localFailure("target not known air", first!);
    const scripted = await nearbyRuntime({
      observe_self: [selfAt(origin)],
      place_block: [firstFailure],
    }, (event) => {
      if (event.type === "ability_call_finished" && event.ability === "place_block") {
        controller.abort(new Error("operator canceled"));
      }
    });

    await expect(scripted.runtime.dispatch("place_block_nearby", { item_id: itemId }, {
      signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: {
        item_id: itemId,
        origin,
        attempted_count: 1,
        last_attempt: { position: first, result: firstFailure },
      },
    });
    expect(scripted.calls).toEqual(["observe_self", "place_block"]);
    scripted.expectExhausted();
  });

  it("returns self-observation failure without an origin or placement call", async () => {
    const observed = {
      ok: false as const,
      error: "RUNTIME_FAILED" as const,
      message: "self observation failed",
      data: {},
    };
    const scripted = await nearbyRuntime({ observe_self: [observed] });

    await expect(scripted.runtime.dispatch("place_block_nearby", { item_id: itemId })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "self observation failed",
      data: { item_id: itemId, attempted_count: 0 },
    });
    expect(scripted.calls).toEqual(["observe_self"]);
    scripted.expectExhausted();
  });

  it("accepts only the exact carried item id input", async () => {
    const scripted = await nearbyRuntime({});

    await expect(scripted.runtime.dispatch("place_block_nearby", {
      item_id: itemId,
      position: origin,
    })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "place_block_nearby",
      message: expect.stringContaining("input.position is not supported"),
    });
    expect(scripted.calls).toEqual([]);
    scripted.expectExhausted();
  });
});

type Script = Readonly<Record<"observe_self" | "place_block", readonly unknown[]>>;

async function nearbyRuntime(
  script: Partial<Script>,
  onEvent?: (event: Readonly<Record<string, unknown> & { type: string }>) => void,
) {
  const runtime = new AbilityRuntime({ onEvent });
  const calls: string[] = [];
  const invocations: Array<{ name: string; input: unknown }> = [];
  const queues = Object.fromEntries(Object.entries(script).map(([name, values]) => [name, [...values]]));
  for (const name of ["observe_self", "place_block"] as const) {
    await runtime.register(defineAbility({
      name,
      description: `Scripted ${name} boundary.`,
      concurrency: "safe",
      execution: name === "observe_self" ? "query" : "body",
      input: s.losslessJson(),
      output: s.losslessJson(),
      async execute(input) {
        calls.push(name);
        invocations.push({ name, input });
        const next = queues[name]?.shift();
        if (next === undefined) throw new Error(`unexpected ${name}`);
        return next;
      },
    }));
  }
  const composite = projectCompositeAbilities.find(({ name }) => name === "place_block_nearby");
  if (composite === undefined) throw new Error("place_block_nearby Project Composite is not registered");
  await runtime.register(composite);
  return {
    runtime,
    calls,
    invocations,
    expectExhausted() {
      expect(Object.fromEntries(Object.entries(queues).filter(([, values]) => values.length > 0)))
        .toEqual({});
    },
  };
}

function expectedCandidates(start: typeof origin) {
  const offsets = [
    [0, 0],
    [-1, 0], [0, -1], [0, 1], [1, 0],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
    [-2, 0], [0, -2], [0, 2], [2, 0],
    [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1],
    [-2, -2], [-2, 2], [2, -2], [2, 2],
  ] as const;
  return [0, 1, -1].flatMap((yOffset) => offsets
    .filter(([x, z]) => yOffset === -1 || x !== 0 || z !== 0)
    .map(([x, z]) => ({ x: start.x + x, y: start.y + yOffset, z: start.z + z })));
}

function selfAt(feet: typeof origin) {
  return { ok: true as const, message: "body status", data: { feet } };
}

function placementSuccess(position: { x: number; y: number; z: number }) {
  return {
    ok: true as const,
    message: "placement verified",
    data: {
      item_id: itemId,
      position,
      block_state: "minecraft:cobblestone",
      consumed_count: 1,
      placed_blocks: [{ position, block_state: "minecraft:cobblestone" }],
    },
  };
}

function localFailure(message: string, position: { x: number; y: number; z: number }) {
  return placementFailure("target_occupied", position, {}, message);
}

function placementFailure(
  failure_type: string,
  position: { x: number; y: number; z: number },
  partialFacts: Readonly<Record<string, unknown>> = {},
  message = failure_type,
) {
  return {
    ok: false as const,
    error: "RUNTIME_FAILED" as const,
    message,
    data: { item_id: itemId, position, failure_type, ...partialFacts },
  };
}
