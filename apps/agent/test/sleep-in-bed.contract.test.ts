import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const bedFoot = { x: 3, y: 64, z: -2 };
const bedHead = { x: 4, y: 64, z: -2 };

describe("sleep_in_bed Project Composite contract", () => {
  it("attempts only the requested exact bed and returns as soon as sleep is verified", async () => {
    const scripted = await sleepingRuntime({
      enter_bed: [success("sleeping verified", { position: bedHead, sleeping: true })],
    });

    await expect(scripted.runtime.dispatch("sleep_in_bed", {
      position: bedFoot,
    })).resolves.toEqual({
      ok: true,
      message: "sleeping verified",
      data: {
        position: bedHead,
        attempted_candidates: [{
          position: bedFoot,
          enter_bed: success("sleeping verified", { position: bedHead, sleeping: true }),
        }],
      },
    });
    expect(scripted.calls).toEqual(["enter_bed"]);
    scripted.expectExhausted();
  });

  it("approaches once after out_of_reach and preserves the verified retry outcome", async () => {
    const outOfReach = failure("bed is out of reach", {
      position: bedHead,
      failure_type: "out_of_reach",
    });
    const approach = success("reached an interaction pose", {
      position: bedFoot,
      feet: { x: 1, y: 64, z: -2 },
    });
    const sleeping = success("sleeping verified", { position: bedHead, sleeping: true });
    const scripted = await sleepingRuntime({
      enter_bed: [outOfReach, sleeping],
      goto_block_interaction_pose: [approach],
    });

    await expect(scripted.runtime.dispatch("sleep_in_bed", {
      position: bedFoot,
    })).resolves.toEqual({
      ok: true,
      message: "sleeping verified",
      data: {
        position: bedHead,
        attempted_candidates: [{
          position: bedFoot,
          enter_bed: outOfReach,
          approach,
          retry: sleeping,
        }],
      },
    });
    expect(scripted.invocations).toEqual([
      { name: "enter_bed", input: { position: bedFoot } },
      { name: "goto_block_interaction_pose", input: { position: bedFoot } },
      { name: "enter_bed", input: { position: bedFoot } },
    ]);
    scripted.expectExhausted();
  });

  it("queries nearby beds once, deduplicates bed halves, and continues after local failure", async () => {
    const start = { x: 0, y: 64, z: 0 };
    const firstFoot = { x: 3, y: 64, z: 0 };
    const firstHead = { x: 4, y: 64, z: 0 };
    const secondFoot = { x: 7, y: 64, z: 0 };
    const secondHead = { x: 8, y: 64, z: 0 };
    const occupied = failure("the first bed is occupied", {
      position: firstHead,
      failure_type: "occupied",
    });
    const sleeping = success("sleeping verified", { position: secondHead, sleeping: true });
    const scripted = await sleepingRuntime({
      observe_self: [selfAt(start)],
      find_known_blocks: [rememberedBlocks([
        bedCandidate(firstFoot, "foot", "east"),
        bedCandidate(firstHead, "head", "east"),
        { position: { x: 2, y: 64, z: 2 }, block_state: "minecraft:stone" },
        bedCandidate({ x: 0, y: 64, z: 40 }, "head", "south"),
        bedCandidate(secondFoot, "foot", "east"),
        bedCandidate(secondHead, "head", "east"),
      ])],
      enter_bed: [occupied, sleeping],
    });

    await expect(scripted.runtime.dispatch("sleep_in_bed", {})).resolves.toEqual({
      ok: true,
      message: "sleeping verified",
      data: {
        position: secondHead,
        attempted_candidates: [
          { position: firstHead, enter_bed: occupied },
          { position: secondHead, enter_bed: sleeping },
        ],
      },
    });
    expect(scripted.invocations).toEqual([
      { name: "observe_self", input: {} },
      { name: "find_known_blocks", input: { block_id_glob: "minecraft:*_bed" } },
      { name: "enter_bed", input: { position: firstHead } },
      { name: "enter_bed", input: { position: secondHead } },
    ]);
    scripted.expectExhausted();
  });

  it("deduplicates a foot-only remembered bed while attempting the remembered half", async () => {
    const foot = { x: 3, y: 64, z: 0 };
    const head = { x: 4, y: 64, z: 0 };
    const sleeping = success("sleeping verified", { position: head, sleeping: true });
    const scripted = await sleepingRuntime({
      observe_self: [selfAt({ x: 0, y: 64, z: 0 })],
      find_known_blocks: [rememberedBlocks([bedCandidate(foot, "foot", "east")])],
      enter_bed: [sleeping],
    });

    await expect(scripted.runtime.dispatch("sleep_in_bed", { distance: 16 }))
      .resolves.toEqual({
        ok: true,
        message: "sleeping verified",
        data: {
          position: head,
          attempted_candidates: [{ position: foot, enter_bed: sleeping }],
        },
      });
    expect(scripted.invocations).toEqual([
      { name: "observe_self", input: {} },
      { name: "find_known_blocks", input: { block_id_glob: "minecraft:*_bed" } },
      { name: "enter_bed", input: { position: foot } },
    ]);
    scripted.expectExhausted();
  });

  it("dispatches no retry after Root cancellation and preserves the approached candidate", async () => {
    const controller = new AbortController();
    const outOfReach = failure("bed is out of reach", {
      position: bedHead,
      failure_type: "out_of_reach",
    });
    const approach = success("reached an interaction pose", {
      position: bedFoot,
      feet: { x: 1, y: 64, z: -2 },
    });
    const scripted = await sleepingRuntime({
      enter_bed: [outOfReach],
      goto_block_interaction_pose: [approach],
    }, (event) => {
      if (event.type === "ability_call_finished"
          && event.ability === "goto_block_interaction_pose") {
        controller.abort(new Error("operator canceled"));
      }
    });

    await expect(scripted.runtime.dispatch("sleep_in_bed", {
      position: bedFoot,
    }, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: {
        attempted_candidates: [{
          position: bedFoot,
          enter_bed: outOfReach,
          approach,
        }],
      },
    });
    expect(scripted.calls).toEqual(["enter_bed", "goto_block_interaction_pose"]);
    scripted.expectExhausted();
  });

  it("dispatches no work when distance mode starts with an already-canceled Root", async () => {
    const controller = new AbortController();
    controller.abort(new Error("operator canceled"));
    const scripted = await sleepingRuntime({});

    await expect(scripted.runtime.dispatch("sleep_in_bed", { distance: 16 }, {
      signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: { attempted_candidates: [] },
    });
    expect(scripted.calls).toEqual([]);
    scripted.expectExhausted();
  });

  it("preserves an interrupted entry and dispatches no later frozen candidate", async () => {
    const first = { x: 4, y: 64, z: 0 };
    const second = { x: 8, y: 64, z: 0 };
    const canceled = {
      ok: false as const,
      error: "INTERRUPTED" as const,
      message: "bed entry canceled",
      data: { position: first },
    };
    const scripted = await sleepingRuntime({
      observe_self: [selfAt({ x: 0, y: 64, z: 0 })],
      find_known_blocks: [rememberedBlocks([
        bedCandidate(first, "head", "east"),
        bedCandidate(second, "head", "east"),
      ])],
      enter_bed: [canceled],
    });

    await expect(scripted.runtime.dispatch("sleep_in_bed", { distance: 16 }))
      .resolves.toEqual({
        ok: false,
        error: "INTERRUPTED",
        message: "bed entry canceled",
        data: {
          attempted_candidates: [{ position: first, enter_bed: canceled }],
        },
      });
    expect(scripted.calls).toEqual(["observe_self", "find_known_blocks", "enter_bed"]);
    scripted.expectExhausted();
  });

  it.each(["obstructed", "target_changed", "unsafe_nearby_monster"] as const)(
    "continues to another frozen bed after local %s failure",
    async (failureType) => {
      const first = { x: 4, y: 64, z: 0 };
      const second = { x: 8, y: 64, z: 0 };
      const localFailure = failure(failureType, { position: first, failure_type: failureType });
      const sleeping = success("sleeping verified", { position: second, sleeping: true });
      const scripted = await sleepingRuntime({
        observe_self: [selfAt({ x: 0, y: 64, z: 0 })],
        find_known_blocks: [rememberedBlocks([
          bedCandidate(first, "head", "east"),
          bedCandidate(second, "head", "east"),
        ])],
        enter_bed: [localFailure, sleeping],
      });

      await expect(scripted.runtime.dispatch("sleep_in_bed", { distance: 16 }))
        .resolves.toMatchObject({
          ok: true,
          data: {
            position: second,
            attempted_candidates: [
              { position: first, enter_bed: localFailure },
              { position: second, enter_bed: sleeping },
            ],
          },
        });
      expect(scripted.calls).toEqual([
        "observe_self", "find_known_blocks", "enter_bed", "enter_bed",
      ]);
      scripted.expectExhausted();
    },
  );

  it("continues after an unreachable frozen bed and preserves its approach failure", async () => {
    const first = { x: 4, y: 64, z: 0 };
    const second = { x: 8, y: 64, z: 0 };
    const outOfReach = failure("bed is out of reach", {
      position: first,
      failure_type: "out_of_reach",
    });
    const unreachable = failure("no interaction pose", {
      position: first,
      failure_type: "no_interaction_pose",
    });
    const sleeping = success("sleeping verified", { position: second, sleeping: true });
    const scripted = await sleepingRuntime({
      observe_self: [selfAt({ x: 0, y: 64, z: 0 })],
      find_known_blocks: [rememberedBlocks([
        bedCandidate(first, "head", "east"),
        bedCandidate(second, "head", "east"),
      ])],
      enter_bed: [outOfReach, sleeping],
      goto_block_interaction_pose: [unreachable],
    });

    await expect(scripted.runtime.dispatch("sleep_in_bed", { distance: 16 }))
      .resolves.toMatchObject({
        ok: true,
        data: {
          position: second,
          attempted_candidates: [
            { position: first, enter_bed: outOfReach, approach: unreachable },
            { position: second, enter_bed: sleeping },
          ],
        },
      });
    expect(scripted.calls).toEqual([
      "observe_self", "find_known_blocks", "enter_bed",
      "goto_block_interaction_pose", "enter_bed",
    ]);
    scripted.expectExhausted();
  });

  it("returns every attempted candidate outcome when the frozen set is exhausted", async () => {
    const first = { x: 4, y: 64, z: 0 };
    const second = { x: 8, y: 64, z: 0 };
    const occupied = failure("occupied", { position: first, failure_type: "occupied" });
    const obstructed = failure("obstructed", { position: second, failure_type: "obstructed" });
    const scripted = await sleepingRuntime({
      observe_self: [selfAt({ x: 0, y: 64, z: 0 })],
      find_known_blocks: [rememberedBlocks([
        bedCandidate(first, "head", "east"),
        bedCandidate(second, "head", "east"),
      ])],
      enter_bed: [occupied, obstructed],
    });

    await expect(scripted.runtime.dispatch("sleep_in_bed", { distance: 16 }))
      .resolves.toEqual({
        ok: false,
        error: "RUNTIME_FAILED",
        message: "all frozen remembered bed candidates failed",
        data: {
          attempted_candidates: [
            { position: first, enter_bed: occupied },
            { position: second, enter_bed: obstructed },
          ],
        },
      });
    scripted.expectExhausted();
  });

  it.each(["not_sleep_time", "bed_not_usable_in_dimension"] as const)(
    "stops immediately after global %s failure",
    async (failureType) => {
      const first = { x: 4, y: 64, z: 0 };
      const second = { x: 8, y: 64, z: 0 };
      const globalFailure = failure(failureType, { position: first, failure_type: failureType });
      const scripted = await sleepingRuntime({
        observe_self: [selfAt({ x: 0, y: 64, z: 0 })],
        find_known_blocks: [rememberedBlocks([
          bedCandidate(first, "head", "east"),
          bedCandidate(second, "head", "east"),
        ])],
        enter_bed: [globalFailure],
      });

      await expect(scripted.runtime.dispatch("sleep_in_bed", { distance: 16 }))
        .resolves.toEqual({
          ok: false,
          error: "RUNTIME_FAILED",
          message: failureType,
          data: {
            attempted_candidates: [{ position: first, enter_bed: globalFailure }],
          },
        });
      expect(scripted.calls).toEqual(["observe_self", "find_known_blocks", "enter_bed"]);
      scripted.expectExhausted();
    },
  );
});

type Script = Readonly<Record<string, unknown[]>>;

async function sleepingRuntime(
  script: Script,
  onEvent?: (event: Readonly<Record<string, unknown> & { type: string }>) => void,
) {
  const runtime = new AbilityRuntime({ onEvent });
  const calls: string[] = [];
  const invocations: Array<{ name: string; input: unknown }> = [];
  const queues = Object.fromEntries(Object.entries(script).map(([name, values]) => [name, [...values]]));
  for (const name of [
    "observe_self", "find_known_blocks", "goto_block_interaction_pose", "enter_bed",
  ]) {
    await runtime.register(defineAbility({
      name,
      description: `Scripted ${name} boundary.`,
      concurrency: "safe",
      execution: name === "observe_self" || name === "find_known_blocks" ? "query" : "body",
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
  const sleep = projectCompositeAbilities.find(({ name }) => name === "sleep_in_bed");
  if (sleep === undefined) throw new Error("sleep_in_bed Project Composite is not registered");
  await runtime.register(sleep);
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

function success(message: string, data: Readonly<Record<string, unknown>>) {
  return { ok: true as const, message, data };
}

function failure(message: string, data: Readonly<Record<string, unknown>>) {
  return { ok: false as const, error: "RUNTIME_FAILED" as const, message, data };
}

function selfAt(feet: typeof bedFoot) {
  return success("body status", {
    entity_id: 1,
    name: "HarnessBot",
    game_mode: "survival",
    hp: 20,
    max_hp: 20,
    hunger: 20,
    position: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 },
    dimension: "minecraft:overworld",
    equipment: {},
    backpack_slots: { used: 0, total: 41 },
    on_ground: true,
    in_water: false,
    air: "300/300",
    in_lava: false,
    underwater: false,
    on_fire: false,
    fall_distance: 0,
    facing: "north",
    feet,
    velocity: { x: 0, y: 0, z: 0 },
    active_effects: [],
  });
}

function bedCandidate(
  position: typeof bedFoot,
  part: "head" | "foot",
  facing: "north" | "east" | "south" | "west",
) {
  return { position, block_state: `minecraft:red_bed[facing=${facing},occupied=false,part=${part}]` };
}

function rememberedBlocks(matches: unknown[]) {
  return success("remembered beds", { matches, truncated: false });
}
