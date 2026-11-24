import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { break_block } from "../src/harness/abilities/built-in/break_block.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";
import type { InferToolSchema } from "../src/harness/tool-schema.js";

const position = { x: 4, y: 64, z: -2 };

describe("goto_and_break_block Composite contract", () => {
  it("returns an immediate exact target break as a compact outcome without pose search", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([success(position, [])], calls));
    await runtime.register(defineAbility({
      name: "goto_block_interaction_pose", description: "Must not run for immediate success.",
      execution: "body", input: s.losslessJson(), output: s.losslessJson(),
      async execute() { throw new Error("unexpected pose search"); },
    }));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: true,
      message: "verified exact target disappearance",
      data: { position, observed_drop_entities: [], cleared_occluding_blocks: [] },
    });
    expect(calls).toEqual([`break_block:${JSON.stringify({ position })}`]);
    await expect(runtime.dispatch("goto_and_break_block", {
      position, max_occluding_blocks: 1,
    })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "goto_and_break_block",
      message: expect.stringContaining("input.max_occluding_blocks is not supported"),
    });
  });

  it("clears one structured Pose-local Occluding Block exactly, then retries the frozen target", async () => {
    const blocker = { x: 4, y: 65, z: -2 };
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([
      failure(position, "occluded", { position: blocker, block_state: "minecraft:oak_leaves[persistent=false]" }),
      success(blocker, [drop("00000000-0000-4000-8000-000000000001", "minecraft:oak_leaves")]),
      success(position, [drop("00000000-0000-4000-8000-000000000002", "minecraft:oak_log")]),
    ], calls));
    await runtime.register(poseMustNotRun());
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: true,
      message: "verified exact target disappearance",
      data: {
        position,
        observed_drop_entities: [drop("00000000-0000-4000-8000-000000000002", "minecraft:oak_log")],
        cleared_occluding_blocks: [{
          position: blocker,
          block_state: "minecraft:oak_leaves[persistent=false]",
          observed_drop_entities: [drop("00000000-0000-4000-8000-000000000001", "minecraft:oak_leaves")],
        }],
      },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position: blocker })}`,
      `break_block:${JSON.stringify({ position })}`,
    ]);
  });

  it("keeps clearing sequential structured Occluding Blocks without switching the frozen target", async () => {
    const blockers = [
      { x: 4, y: 65, z: -2 },
      { x: 4, y: 66, z: -2 },
      { x: 4, y: 67, z: -2 },
      { x: 4, y: 68, z: -2 },
    ];
    const calls: string[] = [];
    const results: unknown[] = [];
    for (const [index, blocker] of blockers.entries()) {
      results.push(failure(position, "occluded", { position: blocker, block_state: `minecraft:oak_leaves[distance=${index}]` }));
      results.push(success(blocker, []));
    }
    results.push(success(position, []));
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak(results, calls));
    await runtime.register(poseMustNotRun());
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toMatchObject({
      ok: true,
      data: {
        position,
        observed_drop_entities: [],
        cleared_occluding_blocks: blockers.map((blocker, index) => ({
          position: blocker,
          block_state: `minecraft:oak_leaves[distance=${index}]`,
          observed_drop_entities: [],
        })),
      },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      ...blockers.flatMap((blocker) => [
        `break_block:${JSON.stringify({ position: blocker })}`,
        `break_block:${JSON.stringify({ position })}`,
      ]),
    ]);
  });

  it("uses one complete interaction-pose search for an out-of-reach frozen target", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([
      failure(position, "out_of_reach"),
      success(position, []),
    ], calls));
    await runtime.register(scriptedPose([poseSuccess(position)], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: true, message: "verified exact target disappearance",
      data: { position, observed_drop_entities: [], cleared_occluding_blocks: [] },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `goto_block_interaction_pose:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position })}`,
    ]);
  });

  it("probes from the final no-pose state and clears an actionable Occluding Block there", async () => {
    const blocker = { x: 4, y: 65, z: -2 };
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([
      failure(position, "out_of_reach"),
      failure(position, "occluded", { position: blocker, block_state: "minecraft:oak_leaves" }),
      success(blocker, []),
      success(position, []),
    ], calls));
    await runtime.register(scriptedPose([poseNoInteractionPose(position)], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toMatchObject({
      ok: true,
      data: { position, observed_drop_entities: [], cleared_occluding_blocks: [{
        position: blocker, block_state: "minecraft:oak_leaves", observed_drop_entities: [],
      }] },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `goto_block_interaction_pose:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position: blocker })}`,
      `break_block:${JSON.stringify({ position })}`,
    ]);
  });

  it("normalizes a final-Pose out-of-reach probe to no_interaction_pose without repeating search", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([failure(position, "out_of_reach"), failure(position, "out_of_reach")], calls));
    await runtime.register(scriptedPose([poseNoInteractionPose(position)], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: "exact break out_of_reach",
      data: { position, cleared_occluding_blocks: [], failure_type: "no_interaction_pose" },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `goto_block_interaction_pose:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position })}`,
    ]);
  });

  it.each(["target_not_known_block", "target_changed"] as const)(
    "projects interaction-pose %s as the stable frozen-target failure", async (failureType) => {
      const calls: string[] = [];
      const runtime = new AbilityRuntime();
      await runtime.register(scriptedBreak([failure(position, "out_of_reach")], calls));
      await runtime.register(scriptedPose([poseFailure(failureType)], calls));
      await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

      await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
        ok: false, error: "RUNTIME_FAILED", message: `pose ${failureType}`,
        data: { position, cleared_occluding_blocks: [], failure_type: failureType },
      });
      expect(calls).toEqual([
        `break_block:${JSON.stringify({ position })}`,
        `goto_block_interaction_pose:${JSON.stringify({ position })}`,
      ]);
    },
  );

  it("does not recursively clear a failed Occluding Block and allows one original-target pose search", async () => {
    const blocker = { x: 4, y: 65, z: -2 };
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([
      failure(position, "occluded", { position: blocker, block_state: "minecraft:oak_leaves" }),
      failure(blocker, "occluded", { position: { x: 4, y: 66, z: -2 }, block_state: "minecraft:vine" }),
      failure(position, "out_of_reach"),
    ], calls));
    await runtime.register(scriptedPose([poseSuccess(position)], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: "exact break out_of_reach",
      data: { position, cleared_occluding_blocks: [], failure_type: "occluding_block_not_cleared" },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position: blocker })}`,
      `goto_block_interaction_pose:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position })}`,
    ]);
  });

  it("does not repeat a failed blocker break after a no-progress pose search final probe", async () => {
    const blocker = { x: 4, y: 65, z: -2 };
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([
      failure(position, "occluded", { position: blocker, block_state: "minecraft:oak_leaves" }),
      failure(blocker, "unbreakable"),
      failure(position, "occluded", { position: blocker, block_state: "minecraft:oak_leaves" }),
    ], calls));
    await runtime.register(scriptedPose([poseNoInteractionPose(position)], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: "exact break occluded",
      data: { position, cleared_occluding_blocks: [], failure_type: "occluding_block_not_cleared" },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position: blocker })}`,
      `goto_block_interaction_pose:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position })}`,
    ]);
  });

  it("clears a different final-probe Occluding Block after an earlier blocker break fails", async () => {
    const failedBlocker = { x: 4, y: 65, z: -2 };
    const finalBlocker = { x: 4, y: 66, z: -2 };
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([
      failure(position, "occluded", { position: failedBlocker, block_state: "minecraft:oak_leaves" }),
      failure(failedBlocker, "unbreakable"),
      failure(position, "occluded", { position: finalBlocker, block_state: "minecraft:vine" }),
      success(finalBlocker, []),
      success(position, []),
    ], calls));
    await runtime.register(scriptedPose([poseNoInteractionPose(position)], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: true, message: "verified exact target disappearance",
      data: { position, observed_drop_entities: [], cleared_occluding_blocks: [{
        position: finalBlocker, block_state: "minecraft:vine", observed_drop_entities: [],
      }] },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position: failedBlocker })}`,
      `goto_block_interaction_pose:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position: finalBlocker })}`,
      `break_block:${JSON.stringify({ position })}`,
    ]);
  });

  it.each([
    ["menu_open", "menu_open"],
    ["target_not_known_block", "target_not_known_block"],
    ["target_changed", "target_changed"],
    ["unbreakable", "target_not_breakable"],
    ["unsupported_shape", "target_not_breakable"],
    ["no_effect", "target_not_breakable"],
  ] as const)("normalizes exact target %s to stable %s without navigation", async (source, expected) => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([failure(position, source)], calls));
    await runtime.register(poseMustNotRun());
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: `exact break ${source}`,
      data: { position, cleared_occluding_blocks: [], failure_type: expected },
    });
    expect(calls).toEqual([`break_block:${JSON.stringify({ position })}`]);
  });

  it("normalizes an unstructured occlusion after its one pose search to target_not_breakable", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([failure(position, "occluded"), failure(position, "occluded")], calls));
    await runtime.register(scriptedPose([poseNoInteractionPose(position)], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: "exact break occluded",
      data: { position, cleared_occluding_blocks: [], failure_type: "target_not_breakable" },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `goto_block_interaction_pose:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position })}`,
    ]);
  });

  it("rejects malformed structured Occluding Block output at the break_block child boundary", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([{
      ok: false as const,
      error: "RUNTIME_FAILED" as const,
      message: "exact break occluded",
      data: {
        position,
        failure_type: "occluded",
        occluding_block: {
          position: { x: 4, y: 65, z: -2 },
          block_state: 42,
        },
      },
    }], calls));
    await runtime.register(poseMustNotRun());
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "break_block",
      message: expect.stringContaining("block_state"),
    });
    expect(calls).toEqual([`break_block:${JSON.stringify({ position })}`]);
  });

  it("retains committed clearings when the later frozen-target break is interrupted", async () => {
    const blocker = { x: 4, y: 65, z: -2 };
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedBreak([
      failure(position, "occluded", { position: blocker, block_state: "minecraft:oak_leaves" }),
      success(blocker, [drop("00000000-0000-4000-8000-000000000001", "minecraft:oak_leaves")]),
      { ok: false as const, error: "INTERRUPTED" as const, message: "exact break interrupted", data: { position } },
    ], calls));
    await runtime.register(poseMustNotRun());
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position })).resolves.toEqual({
      ok: false, error: "INTERRUPTED", message: "composite interrupted",
      data: { position, cleared_occluding_blocks: [{
        position: blocker,
        block_state: "minecraft:oak_leaves",
        observed_drop_entities: [drop("00000000-0000-4000-8000-000000000001", "minecraft:oak_leaves")],
      }] },
    });
  });

  it("retains a committed clearing when the Root is canceled before the target retry", async () => {
    const blocker = { x: 4, y: 65, z: -2 };
    const calls: string[] = [];
    const controller = new AbortController();
    let breakCalls = 0;
    const runtime = new AbilityRuntime({
      onEvent(event) {
        if (event.type === "ability_call_finished" && event.ability === "break_block") {
          breakCalls += 1;
          if (breakCalls === 2) controller.abort(new Error("operator canceled after clearing"));
        }
      },
    });
    await runtime.register(scriptedBreak([
      failure(position, "occluded", { position: blocker, block_state: "minecraft:oak_leaves" }),
      success(blocker, []),
    ], calls));
    await runtime.register(poseMustNotRun());
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_break_block")!);

    await expect(runtime.dispatch("goto_and_break_block", { position }, { signal: controller.signal })).resolves.toEqual({
      ok: false, error: "INTERRUPTED", message: "composite interrupted",
      data: { position, cleared_occluding_blocks: [{
        position: blocker, block_state: "minecraft:oak_leaves", observed_drop_entities: [],
      }] },
    });
    expect(calls).toEqual([
      `break_block:${JSON.stringify({ position })}`,
      `break_block:${JSON.stringify({ position: blocker })}`,
    ]);
  });
});

function drop(uuid: string, item_id: string) {
  return { uuid, item_id, count: 1 };
}

function success(target: typeof position, observed_drop_entities: ReturnType<typeof drop>[]) {
  return { ok: true as const, message: "verified exact target disappearance", data: { position: target, observed_drop_entities } };
}

function failure(
  target: typeof position,
  failure_type: "occluded" | "out_of_reach" | "unbreakable" | "unsupported_shape" | "no_effect" | "menu_open" | "target_not_known_block" | "target_changed",
  occluding_block?: { position: typeof position; block_state: string },
) {
  return {
    ok: false as const, error: "RUNTIME_FAILED" as const, message: `exact break ${failure_type}`,
    data: { position: target, failure_type, ...(occluding_block === undefined ? {} : { occluding_block }) },
  };
}

function scriptedBreak(results: unknown[], calls: string[]) {
  return defineAbility({
    name: "break_block", description: "Return scripted exact break results.", execution: "body",
    input: break_block.input, output: break_block.output,
    async execute(input) {
      calls.push(`break_block:${JSON.stringify(input)}`);
      const result = results.shift();
      if (result === undefined) throw new Error("break_block called past scripted results");
      return result as InferToolSchema<typeof break_block.output>;
    },
  });
}

function poseMustNotRun() {
  return defineAbility({
    name: "goto_block_interaction_pose", description: "Must not run.",
    execution: "body", input: s.losslessJson(), output: s.losslessJson(),
    async execute() { throw new Error("unexpected pose search"); },
  });
}

function scriptedPose(results: unknown[], calls: string[]) {
  return defineAbility({
    name: "goto_block_interaction_pose", description: "Return scripted complete pose-search results.",
    execution: "body", input: s.losslessJson(), output: s.losslessJson(),
    async execute(input) {
      calls.push(`goto_block_interaction_pose:${JSON.stringify(input)}`);
      const result = results.shift();
      if (result === undefined) throw new Error("goto_block_interaction_pose called past scripted results");
      return result;
    },
  });
}

function poseSuccess(target: typeof position) {
  return { ok: true as const, message: "verified interaction pose", data: { position: target, feet: { x: 3, y: 64, z: -2 } } };
}

function poseNoInteractionPose(target: typeof position) {
  return poseFailure("no_interaction_pose", target);
}

function poseFailure(
  failure_type: "target_not_known_block" | "target_changed" | "no_interaction_pose",
  target: typeof position = position,
) {
  return {
    ok: false as const, error: "RUNTIME_FAILED" as const, message: `pose ${failure_type}`,
    data: { position: target, failure_type },
  };
}
