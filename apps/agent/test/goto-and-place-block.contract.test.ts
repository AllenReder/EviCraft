import { describe, expect, it } from "vitest";

import { AbilityRuntime, type AbilityRuntimeOptions, type RuntimeAdapter } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";
import { goto_block_placement_pose } from "../src/harness/abilities/built-in/goto_block_placement_pose.js";
import { place_block } from "../src/harness/abilities/built-in/place_block.js";

const itemId = "minecraft:cobblestone";
const position = { x: 9, y: 64, z: -3 };
const input = { item_id: itemId, position };

describe("goto_and_place_block Project Composite contract", () => {
  it("returns immediate verified placement success without navigation", async () => {
    const initial = placed("placed from the current pose");
    const calls: ScriptCall[] = [];
    const script: readonly ScriptStep[] = [{ name: "place_block", result: initial }];
    const runtime = await compositeRuntime();

    await expect(runtime.dispatch("goto_and_place_block", input, {
      runtime: scriptedAdapter(script, calls),
    })).resolves.toEqual({
      ok: true,
      message: initial.message,
      data: { ...input, action: "place_block", initial },
    });
    expect(calls).toEqual([{ name: "place_block", input }]);
  });

  it.each(["out_of_reach", "occluded", "body_in_target", "target_unknown"] as const)(
    "approaches after an initial %s failure and retries exactly once",
    async (failureType) => {
      const initial = placementFailure(failureType, `initial ${failureType}`);
      const approach = placementPose("verified placement pose");
      const retry = placed("placed after approach");
      const calls: ScriptCall[] = [];
      const script: readonly ScriptStep[] = [
        { name: "place_block", result: initial },
        { name: "goto_block_placement_pose", result: approach },
        { name: "place_block", result: retry },
      ];
      const runtime = await compositeRuntime();

      await expect(runtime.dispatch("goto_and_place_block", input, {
        runtime: scriptedAdapter(script, calls),
      })).resolves.toEqual({
        ok: true,
        message: retry.message,
        data: { ...input, action: "place_block", initial, approach, retry },
      });
      expect(calls).toEqual([
        { name: "place_block", input },
        { name: "goto_block_placement_pose", input },
        { name: "place_block", input },
      ]);
    },
  );

  it.each([
    "menu_open", "target_occupied", "second_cell_not_free", "target_changed",
    "item_not_found", "item_not_block", "multi_cell_item", "no_support", "entity_blocked",
    "unsupported_shape", "no_effect", "verification_failed",
  ] as const)("returns initial %s placement failures without navigation", async (failureType) => {
    const initial = placementFailure(failureType, `initial ${failureType}`);
    const calls: ScriptCall[] = [];
    const script: readonly ScriptStep[] = [{ name: "place_block", result: initial }];
    const runtime = await compositeRuntime();

    await expect(runtime.dispatch("goto_and_place_block", input, {
      runtime: scriptedAdapter(script, calls),
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: initial.message,
      data: { ...input, action: "place_block", initial },
    });
    expect(calls).toEqual([{ name: "place_block", input }]);
  });

  it("surfaces other-entity occupancy without navigation or retry", async () => {
    // Occupancy by another entity is passed up as-is, with no approach-and-retry: a retry would hit the same entity.
    const initial = placementFailure(
      "entity_blocked", "an entity blocks the target placement volume",
      "target_volume_other:minecraft:zombie@(9.50,64.50,-2.50)");
    const calls: ScriptCall[] = [];
    const script: readonly ScriptStep[] = [{ name: "place_block", result: initial }];
    const runtime = await compositeRuntime();

    await expect(runtime.dispatch("goto_and_place_block", input, {
      runtime: scriptedAdapter(script, calls),
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: initial.message,
      data: { ...input, action: "place_block", initial },
    });
    expect(calls).toEqual([{ name: "place_block", input }]);
  });

  it("propagates an approach error and preserves the committed initial result", async () => {
    const initial = placementFailure("out_of_reach", "target is out of reach");
    const approach = {
      ok: false as const,
      error: "RUNTIME_FAILED" as const,
      message: "no placement pose is available",
      data: { ...input, failure_type: "no_placement_pose" },
    };
    const calls: ScriptCall[] = [];
    const script: readonly ScriptStep[] = [
      { name: "place_block", result: initial },
      { name: "goto_block_placement_pose", result: approach },
    ];
    const runtime = await compositeRuntime();

    await expect(runtime.dispatch("goto_and_place_block", input, {
      runtime: scriptedAdapter(script, calls),
    })).resolves.toEqual({
      ok: false,
      error: approach.error,
      message: approach.message,
      data: { ...input, action: "place_block", initial, approach },
    });
    expect(calls).toEqual([
      { name: "place_block", input },
      { name: "goto_block_placement_pose", input },
    ]);
  });

  it("propagates a retry interruption and preserves every committed child result", async () => {
    const initial = placementFailure("occluded", "target is occluded");
    const approach = placementPose("verified placement pose");
    const retry = {
      ok: false as const,
      error: "INTERRUPTED" as const,
      message: "placement retry interrupted",
      data: { ...input },
    };
    const calls: ScriptCall[] = [];
    const script: readonly ScriptStep[] = [
      { name: "place_block", result: initial },
      { name: "goto_block_placement_pose", result: approach },
      { name: "place_block", result: retry },
    ];
    const runtime = await compositeRuntime();

    await expect(runtime.dispatch("goto_and_place_block", input, {
      runtime: scriptedAdapter(script, calls),
    })).resolves.toEqual({
      ok: false,
      error: retry.error,
      message: retry.message,
      data: { ...input, action: "place_block", initial, approach, retry },
    });
    expect(calls).toEqual([
      { name: "place_block", input },
      { name: "goto_block_placement_pose", input },
      { name: "place_block", input },
    ]);
  });

  it.each([
    {
      title: "initial placement",
      script: [{ name: "place_block", result: { malformed: true } }],
      calls: ["place_block"],
      ability: "place_block",
    },
    {
      title: "placement-pose approach",
      script: [
        { name: "place_block", result: placementFailure("out_of_reach", "target is out of reach") },
        { name: "goto_block_placement_pose", result: { malformed: true } },
      ],
      calls: ["place_block", "goto_block_placement_pose"],
      ability: "goto_block_placement_pose",
    },
    {
      title: "placement retry",
      script: [
        { name: "place_block", result: placementFailure("out_of_reach", "target is out of reach") },
        { name: "goto_block_placement_pose", result: placementPose("verified placement pose") },
        { name: "place_block", result: { malformed: true } },
      ],
      calls: ["place_block", "goto_block_placement_pose", "place_block"],
      ability: "place_block",
    },
  ] as const)("rejects malformed $title results before starting another child", async ({
    script, calls: expectedCalls, ability,
  }) => {
    const calls: ScriptCall[] = [];
    const runtime = await compositeRuntime();

    await expect(runtime.dispatch("goto_and_place_block", input, {
      runtime: scriptedAdapter(script, calls),
    })).rejects.toMatchObject({ name: "ToolCallError", ability });
    expect(calls.map((call) => call.name)).toEqual(expectedCalls);
  });

  it("returns INTERRUPTED after the initial result when the Root is canceled", async () => {
    const initial = placementFailure("out_of_reach", "target is out of reach");
    const controller = new AbortController();
    const calls: ScriptCall[] = [];
    const script: readonly ScriptStep[] = [{ name: "place_block", result: initial }];
    const runtime = await compositeRuntime({
      onEvent(event) {
        if (event.type === "ability_call_finished" && event.ability === "place_block") {
          controller.abort(new Error("operator canceled"));
        }
      },
    });

    await expect(runtime.dispatch("goto_and_place_block", input, {
      runtime: scriptedAdapter(script, calls), signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: { ...input, action: "place_block", initial },
    });
    expect(calls).toEqual([{ name: "place_block", input }]);
  });

  it("returns INTERRUPTED after the approach result when the Root is canceled", async () => {
    const initial = placementFailure("occluded", "target is occluded");
    const approach = placementPose("verified placement pose");
    const controller = new AbortController();
    const calls: ScriptCall[] = [];
    const script: readonly ScriptStep[] = [
      { name: "place_block", result: initial },
      { name: "goto_block_placement_pose", result: approach },
    ];
    const runtime = await compositeRuntime({
      onEvent(event) {
        if (event.type === "ability_call_finished" && event.ability === "goto_block_placement_pose") {
          controller.abort(new Error("operator canceled"));
        }
      },
    });

    await expect(runtime.dispatch("goto_and_place_block", input, {
      runtime: scriptedAdapter(script, calls), signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: { ...input, action: "place_block", initial, approach },
    });
    expect(calls).toEqual([
      { name: "place_block", input },
      { name: "goto_block_placement_pose", input },
    ]);
  });

  it("accepts only its exact carried BlockItem and target-position input", async () => {
    const calls: ScriptCall[] = [];
    const runtime = await compositeRuntime();

    await expect(runtime.dispatch("goto_and_place_block", {
      item_id: itemId, position, distance: 3,
    })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "goto_and_place_block",
      message: expect.stringContaining("input.distance is not supported"),
    });
    await expect(runtime.dispatch("goto_and_place_block", { position })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "goto_and_place_block",
      message: expect.stringContaining("input.item_id is required"),
    });
    expect(calls).toEqual([]);
  });
});

type ScriptStep = Readonly<{ name: "place_block" | "goto_block_placement_pose"; result: unknown }>;
type ScriptCall = Readonly<{ name: string; input: typeof input }>;

function placed(message: string) {
  return {
    ok: true as const,
    message,
    data: {
      ...input,
      block_state: "minecraft:cobblestone",
      consumed_count: 1,
      placed_blocks: [{ position, block_state: "minecraft:cobblestone" }],
    },
  };
}

function placementFailure(
  failure_type: "menu_open" | "target_unknown" | "target_occupied" | "second_cell_not_free"
    | "target_changed" | "item_not_found" | "item_not_block" | "multi_cell_item" | "no_support"
    | "body_in_target" | "entity_blocked" | "out_of_reach"
    | "occluded" | "unsupported_shape" | "no_effect" | "verification_failed",
  message: string,
  occluding_detail?: string,
) {
  return {
    ok: false as const,
    error: "RUNTIME_FAILED" as const,
    message,
    data: { ...input, failure_type, ...(occluding_detail !== undefined ? { occluding_detail } : {}) },
  };
}

function placementPose(message: string) {
  return {
    ok: true as const,
    message,
    data: { ...input, feet: { x: 7, y: 64, z: -3 } },
  };
}

async function compositeRuntime(options: AbilityRuntimeOptions = {}) {
  const runtime = new AbilityRuntime(options);
  await runtime.register(place_block);
  await runtime.register(goto_block_placement_pose);
  const composite = projectCompositeAbilities.find(({ name }) => name === "goto_and_place_block");
  if (composite === undefined) throw new Error("goto_and_place_block Project Composite is not registered");
  await runtime.register(composite);
  return runtime;
}

function scriptedAdapter(script: readonly ScriptStep[], calls: ScriptCall[]): RuntimeAdapter {
  let cursor = 0;
  return {
    async call(name: string, value: Record<string, unknown>) {
      const step = script[cursor];
      if (step === undefined) throw new Error(`unexpected Runtime call ${name}`);
      if (step.name !== name) throw new Error(`expected ${step.name}, received ${name}`);
      cursor += 1;
      calls.push({ name, input: value as typeof input });
      return step.result;
    },
  } as unknown as RuntimeAdapter;
}
