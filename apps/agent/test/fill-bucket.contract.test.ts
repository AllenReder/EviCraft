import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const near = { x: 2, y: 63, z: 0 };
const covered = { x: 1, y: 62, z: 0 };
const far = { x: 6, y: 63, z: 0 };

function found(matches: { position: { x: number; y: number; z: number }; block_state: string }[]) {
  return { ok: true, message: "found", data: { matches, truncated: false } };
}

function filled(position: { x: number; y: number; z: number }) {
  return {
    ok: true, message: "verified item use",
    data: { item_id: "minecraft:bucket", position, face: "up", outcome: "target_block_changed", effect_position: position, block_state: "minecraft:air", consumed_count: 0, durability_used: 0, resulting_item_id: "minecraft:water_bucket" },
  };
}

function useFailure(failure_type: string, position: { x: number; y: number; z: number }) {
  return { ok: false, error: "RUNTIME_FAILED", message: failure_type, data: { item_id: "minecraft:bucket", position, failure_type } };
}

async function scripted(script: Record<string, unknown[]>) {
  const runtime = new AbilityRuntime();
  const calls: Array<[string, unknown]> = [];
  for (const name of ["find_known_blocks", "goto_and_use_item_on_block"]) {
    await runtime.register(defineAbility({
      name, description: `Scripted ${name}.`, execution: name === "find_known_blocks" ? "query" : "body",
      concurrency: name === "find_known_blocks" ? "safe" : "exclusive",
      input: s.losslessJson(), output: s.losslessJson(),
      execute: (input: unknown) => {
        calls.push([name, input]);
        const next = script[name]?.shift();
        if (next === undefined) throw new Error(`unexpected ${name}`);
        return next;
      },
    }));
  }
  await runtime.register(projectCompositeAbilities.find(({ name }) => name === "fill_bucket")!);
  return { runtime, calls };
}

describe("fill_bucket Project Composite", () => {
  it("skips flowing cells and tries uncovered sources before covered ones", async () => {
    const run = await scripted({
      find_known_blocks: [found([
        { position: covered, block_state: "minecraft:water[level=0]" },
        { position: { ...covered, y: 63 }, block_state: "minecraft:water[level=0]" },
        { position: { x: 0, y: 63, z: 0 }, block_state: "minecraft:water[level=3]" },
        { position: far, block_state: "minecraft:water[level=0]" },
      ])],
      goto_and_use_item_on_block: [useFailure("occluded", { ...covered, y: 63 }), filled(far)],
    });
    const result = await run.runtime.dispatch("fill_bucket", { fluid: "water" });
    expect(result).toMatchObject({
      ok: true,
      data: { fluid: "water", position: far, resulting_item_id: "minecraft:water_bucket", tried: [{ position: { ...covered, y: 63 }, failure_type: "occluded" }] },
    });
    expect(run.calls).toEqual([
      ["find_known_blocks", { block_id_glob: "minecraft:water" }],
      ["goto_and_use_item_on_block", { item_id: "minecraft:bucket", position: { ...covered, y: 63 } }],
      ["goto_and_use_item_on_block", { item_id: "minecraft:bucket", position: far }],
    ]);
  });

  it("never reports a fill whose bucket holds another fluid", async () => {
    const lavaBucket = filled(near);
    lavaBucket.data.resulting_item_id = "minecraft:lava_bucket";
    const run = await scripted({
      find_known_blocks: [found([{ position: near, block_state: "minecraft:water[level=0]" }])],
      goto_and_use_item_on_block: [lavaBucket],
    });
    expect(await run.runtime.dispatch("fill_bucket", { fluid: "water" })).toMatchObject({
      ok: false, data: { failure_type: "all_sources_failed", tried: [{ position: near, message: "the bucket became minecraft:lava_bucket, not minecraft:water_bucket" }] },
    });
  });

  it("reports when no known cell is a source", async () => {
    const run = await scripted({
      find_known_blocks: [found([{ position: near, block_state: "minecraft:water[level=2]" }])],
    });
    expect(await run.runtime.dispatch("fill_bucket", { fluid: "water" })).toMatchObject({
      ok: false, error: "RUNTIME_FAILED", data: { fluid: "water", failure_type: "no_known_source", tried: [] },
    });
    expect(run.calls.map(([name]) => name)).toEqual(["find_known_blocks"]);
  });

  it("stops at a failure no other source can fix and bounds the sources it tries", async () => {
    const missing = await scripted({
      find_known_blocks: [found([{ position: near, block_state: "minecraft:lava[level=0]" }, { position: far, block_state: "minecraft:lava[level=0]" }])],
      goto_and_use_item_on_block: [useFailure("item_not_found", near)],
    });
    expect(await missing.runtime.dispatch("fill_bucket", { fluid: "lava" })).toMatchObject({
      ok: false, data: { fluid: "lava", failure_type: "item_not_found" },
    });
    expect(missing.calls).toHaveLength(2);

    const bounded = await scripted({
      find_known_blocks: [found([{ position: near, block_state: "minecraft:water[level=0]" }, { position: far, block_state: "minecraft:water[level=0]" }])],
      goto_and_use_item_on_block: [useFailure("out_of_reach", near)],
    });
    expect(await bounded.runtime.dispatch("fill_bucket", { fluid: "water", max_sources: 1 })).toMatchObject({
      ok: false, data: { failure_type: "all_sources_failed", tried: [{ position: near, failure_type: "out_of_reach" }] },
    });
    expect(bounded.calls).toHaveLength(2);
  });
});
