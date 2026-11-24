import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

import { AbilityRuntime } from "../src/index.js";
import {
  projectCompositeAbilities,
  runtimeAbilities,
} from "../src/harness/abilities/index.js";
import { oreVariantGlobNote } from "../src/harness/canonical-registry-id.js";

describe("Canonical ID Glob Ability contract", () => {
  it("exposes only Glob selectors and sends them through the expanded Runtime contract", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of [...runtimeAbilities, ...projectCompositeAbilities]) {
      await runtime.register(definition);
    }

    const tools = Object.fromEntries(runtime.modelTools().map((tool) => [tool.name, tool.inputSchema]));
    expect(tools.goto).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({ required: ["block_id_glob"] }),
      ]),
    });
    expect(tools.find_known_blocks).toMatchObject({ required: ["block_id_glob"] });
    expect(tools.observe_entities).toMatchObject({
      properties: expect.objectContaining({
        entity_id_glob: expect.anything(),
        item_id_glob: expect.anything(),
      }),
    });
    expect(tools.collect_items).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({ required: ["uuids"] }),
        expect.objectContaining({
          required: ["item_id_glob"],
          properties: expect.objectContaining({ item_id_glob: expect.anything() }),
        }),
      ]),
    });
    expect(tools.lookup_recipe).toMatchObject({ required: ["recipe_or_output_id_glob"] });
    expect(tools.tunnel_for_blocks).toMatchObject({ required: ["block_id_glob", "direction", "max_length"] });

    const call = vi.fn(async (name: string) => {
      if (name === "goto") {
        return {
          ok: true as const,
          message: "arrived",
          data: { position: { x: 0.5, y: 64, z: 0.5 }, ground_y: 63 },
        };
      }
      if (name === "collect_items") {
        return {
          ok: true as const,
          message: "collected",
          data: {
            collected_entities: 1,
            collected_items: 1,
            skipped_entities: 0,
            radius: 8,
            selection: "item_id_glob" as const,
          },
        };
      }
      return { ok: true as const, message: "recipe", data: {} };
    });
    const blockFind = vi.fn(async () => ({
      operation: "block.find" as const,
      matches: [],
      has_more: false,
      complete: false,
    }));
    const entityList = vi.fn(async () => ({
      operation: "entity.list" as const,
      tracks: [],
      has_more: false,
    }));
    const adapter = {
      call,
      blockFind,
      entityList,
    } as never;

    await runtime.dispatch("goto", { block_id_glob: "minecraft:*_log" }, { runtime: adapter });
    expect(call).toHaveBeenCalledWith(
      "goto",
      { goal: { kind: "block", block_id_glob: "minecraft:*_log" } },
      expect.any(AbortSignal),
    );

    await runtime.dispatch("find_known_blocks", { block_id_glob: "minecraft:*_ore" }, {
      runtime: {
        ...adapter,
        async call(name: string) {
          if (name !== "get_self_status") throw new Error(`unexpected Runtime call: ${name}`);
          return selfStatusResult();
        },
      } as never,
    });
    expect(blockFind).toHaveBeenCalledWith(
      "minecraft:overworld",
      "minecraft:*_ore",
      { origin: { x: 0, y: 64, z: 0 }, limit: 32 },
    );

    await runtime.dispatch("observe_entities", {
      entity_id_glob: "minecraft:*",
      item_id_glob: "minecraft:*_ingot",
    }, {
      runtime: {
        ...adapter,
        async call() { return selfStatusResult(); },
      } as never,
    });
    expect(entityList).toHaveBeenCalledWith({
      dimension: "minecraft:overworld",
      entityIdGlob: "minecraft:*",
      itemIdGlob: "minecraft:*_ingot",
    });

    await runtime.dispatch("collect_items", { item_id_glob: "minecraft:*_ingot" }, { runtime: adapter });
    expect(call).toHaveBeenCalledWith(
      "collect_items",
      { item_id_glob: "minecraft:*_ingot" },
      expect.any(AbortSignal),
    );

    await runtime.dispatch("lookup_recipe", {
      recipe_or_output_id_glob: "minecraft:*_planks",
    }, { runtime: adapter });
    expect(call).toHaveBeenCalledWith(
      "lookup_recipe",
      { recipe_or_output_id_glob: "minecraft:*_planks" },
      expect.any(AbortSignal),
    );
  });

  it("teaches Project Skill callers the same Glob language", async () => {
    // Skill snippets are type-checked against the generated SDK in project-skill-library.test.ts.
    const [mining, endPortal] = await Promise.all([
      readFile(new URL("../project-skills/ore_mining/SKILL.md", import.meta.url), "utf8"),
      readFile(new URL("../project-skills/end_portal/SKILL.md", import.meta.url), "utf8"),
    ]);

    expect(mining).toContain('const glob = "minecraft:*iron_ore";');
    expect(endPortal).toContain('entity_id_glob: "minecraft:enderman"');
  });

  it("names the ore variant a block glob leaves out, from the glob text alone", async () => {
    expect(oreVariantGlobNote("minecraft:*_iron_ore")).toBe(
      "note: minecraft:*_iron_ore misses minecraft:iron_ore; minecraft:*iron_ore matches both",
    );
    expect(oreVariantGlobNote("minecraft:diamond_ore")).toContain("misses minecraft:deepslate_diamond_ore");
    expect(oreVariantGlobNote("minecraft:deepslate_*")).toMatch(/; other ores likewise$/u);
    for (const glob of ["minecraft:*iron_ore", "minecraft:*_ore", "minecraft:*_log", "minecraft:stone"]) {
      expect(oreVariantGlobNote(glob), glob).toBeUndefined();
    }

    // G negative control: the note never queries World Knowledge for the missed variant.
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const blockFind = vi.fn(async () => ({ operation: "block.find" as const, matches: [], has_more: false, complete: false }));
    const result = await runtime.dispatch("find_known_blocks", { block_id_glob: "minecraft:diamond_ore" }, {
      runtime: { blockFind, async call() { return selfStatusResult(); } } as never,
    });
    expect(result).toMatchObject({
      ok: true,
      message: "no matching remembered block evidence (note: minecraft:diamond_ore misses minecraft:deepslate_diamond_ore; minecraft:*diamond_ore matches both)",
      data: { matches: [] },
    });
    expect(blockFind.mock.calls).toEqual([
      ["minecraft:overworld", "minecraft:diamond_ore", { origin: { x: 0, y: 64, z: 0 }, limit: 32 }],
    ]);
  });
});

function selfStatusResult() {
  return {
    ok: true as const,
    message: "self",
    data: {
      entity_id: 1,
      name: "bot",
      game_mode: "survival" as const,
      hp: 20,
      max_hp: 20,
      hunger: 20,
      position: { x: 0.5, y: 64, z: 0.5 },
      dimension: "minecraft:overworld",
      equipment: {},
      backpack_slots: { used: 0, total: 36 },
      on_ground: true,
      in_water: false,
      air: "15s",
      in_lava: false,
      underwater: false,
      on_fire: false,
      suffocating: false,
      intersecting_blocks: [],
      fall_distance: 0,
      facing: "north" as const,
      feet: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      active_effects: [],
    },
  };
}
