import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const position = { x: 4, y: 63, z: -2 };
const used = {
  ok: true, message: "verified item use",
  data: { item_id: "minecraft:bucket", position, face: "up", outcome: "item_changed", consumed_count: 0, durability_used: 0, resulting_item_id: "minecraft:water_bucket" },
};

function useFailure(failure_type: string) {
  return { ok: false, error: "RUNTIME_FAILED", message: failure_type, data: { item_id: "minecraft:bucket", position, failure_type } };
}

async function scripted(script: Record<string, unknown[]>, poses: unknown[] = []) {
  const runtime = new AbilityRuntime();
  const calls: string[] = [];
  for (const name of ["use_item_on_block", "goto_block_interaction_pose"]) {
    await runtime.register(defineAbility({
      name, description: `Scripted ${name}.`, execution: "body", concurrency: "exclusive",
      input: s.losslessJson(), output: s.losslessJson(),
      execute: (input: unknown) => {
        calls.push(name);
        if (name === "goto_block_interaction_pose") poses.push(input);
        const next = script[name]?.shift();
        if (next === undefined) throw new Error(`unexpected ${name}`);
        return next;
      },
    }));
  }
  await runtime.register(projectCompositeAbilities.find(({ name }) => name === "goto_and_use_item_on_block")!);
  return { runtime, calls };
}

describe("goto_and_use_item_on_block Project Composite", () => {
  it("returns an immediate use or a non-reach failure without moving", async () => {
    const immediate = await scripted({ use_item_on_block: [used] });
    expect(await immediate.runtime.dispatch("goto_and_use_item_on_block", { item_id: "minecraft:bucket", position })).toEqual(used);
    expect(immediate.calls).toEqual(["use_item_on_block"]);

    const missing = await scripted({ use_item_on_block: [useFailure("item_not_found")] });
    expect(await missing.runtime.dispatch("goto_and_use_item_on_block", { item_id: "minecraft:bucket", position }))
      .toMatchObject({ ok: false, data: { failure_type: "item_not_found" } });
    expect(missing.calls).toEqual(["use_item_on_block"]);
  });

  it("approaches through an item-aware interaction pose and retries once", async () => {
    const poses: unknown[] = [];
    const run = await scripted({
      use_item_on_block: [useFailure("occluded"), used],
      goto_block_interaction_pose: [{ ok: true, message: "pose", data: { position, feet: { x: 6, y: 64, z: -2 } } }],
    }, poses);
    expect(await run.runtime.dispatch("goto_and_use_item_on_block", { item_id: "minecraft:bucket", position })).toEqual(used);
    expect(run.calls).toEqual(["use_item_on_block", "goto_block_interaction_pose", "use_item_on_block"]);
    expect(poses).toEqual([{ position, item_id: "minecraft:bucket" }]);
  });

  it("returns the first failure with the pose's reason when no pose reaches the target", async () => {
    const run = await scripted({
      use_item_on_block: [useFailure("out_of_reach")],
      goto_block_interaction_pose: [{ ok: false, error: "RUNTIME_FAILED", message: "no pose", data: { position, failure_type: "no_interaction_pose" } }],
    });
    expect(await run.runtime.dispatch("goto_and_use_item_on_block", { item_id: "minecraft:water_bucket", position }))
      .toMatchObject({ ok: false, message: "out_of_reach; no pose reaches it: no pose", data: { failure_type: "out_of_reach" } });
    expect(run.calls).toEqual(["use_item_on_block", "goto_block_interaction_pose"]);
  });
});
