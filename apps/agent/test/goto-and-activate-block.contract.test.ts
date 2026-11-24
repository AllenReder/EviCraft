import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const position = { x: 4, y: 64, z: -2 };

describe("goto_and_activate_block Composite contract", () => {
  it("returns immediate verified activation without pose search", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedActivation([
      activationSuccess("menu_opened"),
    ], calls));
    await runtime.register(poseMustNotRun());
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_activate_block")!);

    await expect(runtime.dispatch("goto_and_activate_block", { position })).resolves.toEqual(activationSuccess("menu_opened"));
    expect(calls).toEqual([`activate_block:${JSON.stringify({ position })}`]);
  });

  it.each(["out_of_reach", "occluded"] as const)(
    "searches one complete pose after %s and returns the compact retried activation", async (initialFailure) => {
      const calls: string[] = [];
      const runtime = new AbilityRuntime();
      const expected = activationSuccess("block_state_changed");
      await runtime.register(scriptedActivation([activationFailure(initialFailure), expected], calls));
      await runtime.register(scriptedPose([poseSuccess()], calls));
      await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_activate_block")!);

      await expect(runtime.dispatch("goto_and_activate_block", { position })).resolves.toEqual(expected);
      expect(calls).toEqual([
        `activate_block:${JSON.stringify({ position })}`,
        `goto_block_interaction_pose:${JSON.stringify({ position })}`,
        `activate_block:${JSON.stringify({ position })}`,
      ]);
    },
  );

  it.each([
    ["menu_open", "menu_open"],
    ["target_not_known_block", "target_not_known_block"],
    ["target_changed", "target_changed"],
    ["no_effect", "no_effect"],
  ] as const)("returns direct expected %s without navigation", async (source, expected) => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedActivation([activationFailure(source)], calls));
    await runtime.register(poseMustNotRun());
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_activate_block")!);

    await expect(runtime.dispatch("goto_and_activate_block", { position })).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: `activation ${source}`,
      data: { position, failure_type: expected },
    });
    expect(calls).toEqual([`activate_block:${JSON.stringify({ position })}`]);
  });

  it.each(["out_of_reach", "occluded"] as const)(
    "normalizes a retried %s activation to no_effect", async (retryFailure) => {
      const calls: string[] = [];
      const runtime = new AbilityRuntime();
      await runtime.register(scriptedActivation([activationFailure("out_of_reach"), activationFailure(retryFailure)], calls));
      await runtime.register(scriptedPose([poseSuccess()], calls));
      await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_activate_block")!);

      await expect(runtime.dispatch("goto_and_activate_block", { position })).resolves.toEqual({
        ok: false, error: "RUNTIME_FAILED", message: `activation ${retryFailure}`,
        data: { position, failure_type: "no_effect" },
      });
    },
  );

  it("returns the compact no_interaction_pose failure from a complete pose search", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedActivation([activationFailure("occluded")], calls));
    await runtime.register(scriptedPose([poseFailure("no_interaction_pose")], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_activate_block")!);

    await expect(runtime.dispatch("goto_and_activate_block", { position })).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: "pose no_interaction_pose",
      data: { position, failure_type: "no_interaction_pose" },
    });
    expect(calls).toEqual([
      `activate_block:${JSON.stringify({ position })}`,
      `goto_block_interaction_pose:${JSON.stringify({ position })}`,
    ]);
  });

  it("does not dispatch a destructive blocker break", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedActivation([activationFailure("occluded"), activationSuccess("menu_opened")], calls));
    await runtime.register(scriptedPose([poseSuccess()], calls));
    await runtime.register(defineAbility({
      name: "break_block", description: "Prove activation never clears terrain.", execution: "body",
      input: s.losslessJson(), output: s.losslessJson(),
      async execute() { calls.push("break_block"); throw new Error("unexpected destructive fallback"); },
    }));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_activate_block")!);

    await expect(runtime.dispatch("goto_and_activate_block", { position })).resolves.toEqual(activationSuccess("menu_opened"));
    expect(calls).not.toContain("break_block");
  });

  it("projects an interrupted retry without child history", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(scriptedActivation([
      activationFailure("out_of_reach"),
      { ok: false as const, error: "INTERRUPTED" as const, message: "activation interrupted", data: { position } },
    ], calls));
    await runtime.register(scriptedPose([poseSuccess()], calls));
    await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_activate_block")!);

    await expect(runtime.dispatch("goto_and_activate_block", { position })).resolves.toEqual({
      ok: false, error: "INTERRUPTED", message: "composite interrupted", data: { position },
    });
  });
});

function activationSuccess(outcome: "menu_opened" | "block_state_changed") {
  return outcome === "menu_opened"
    ? { ok: true as const, message: "verified activation", data: { position, outcome } }
    : { ok: true as const, message: "verified activation", data: { position, outcome, block_state: "minecraft:oak_door[open=true]" } };
}

function activationFailure(
  failure_type: "menu_open" | "target_not_known_block" | "target_changed" | "no_effect" | "out_of_reach" | "occluded",
) {
  return { ok: false as const, error: "RUNTIME_FAILED" as const, message: `activation ${failure_type}`, data: { position, failure_type } };
}

function scriptedActivation(results: unknown[], calls: string[]) {
  return defineAbility({
    name: "activate_block", description: "Return scripted activation results.", execution: "body",
    input: s.losslessJson(), output: s.losslessJson(),
    async execute(input) {
      calls.push(`activate_block:${JSON.stringify(input)}`);
      const result = results.shift();
      if (result === undefined) throw new Error("activate_block called past scripted results");
      return result;
    },
  });
}

function poseMustNotRun() {
  return defineAbility({
    name: "goto_block_interaction_pose", description: "Must not run.", execution: "body",
    input: s.losslessJson(), output: s.losslessJson(),
    async execute() { throw new Error("unexpected pose search"); },
  });
}

function scriptedPose(results: unknown[], calls: string[]) {
  return defineAbility({
    name: "goto_block_interaction_pose", description: "Return scripted pose-search results.", execution: "body",
    input: s.losslessJson(), output: s.losslessJson(),
    async execute(input) {
      calls.push(`goto_block_interaction_pose:${JSON.stringify(input)}`);
      const result = results.shift();
      if (result === undefined) throw new Error("goto_block_interaction_pose called past scripted results");
      return result;
    },
  });
}

function poseSuccess() {
  return { ok: true as const, message: "verified interaction pose", data: { position, feet: { x: 3, y: 64, z: -2 } } };
}

function poseFailure(failure_type: "no_interaction_pose") {
  return { ok: false as const, error: "RUNTIME_FAILED" as const, message: `pose ${failure_type}`, data: { position, failure_type } };
}
