import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const itemId = "minecraft:iron_pickaxe";
const tableId = "minecraft:crafting_table";
const feet = { x: 0, y: 64, z: 0 };
const near = { x: 3, y: 64, z: 1 };
const far = { x: 40, y: 64, z: 0 };
const placedAt = { x: 1, y: 64, z: 0 };

const none = ok("no Menu", { menu_type: "none" });
const tableMenu = ok("crafting table", { menu_type: "crafting_table", surface: "3x3", can_craft: true });
const crafted = ok("crafted", { crafted: 1, carrying: 1 });
const closed = ok("closed", {});
const needsTable = failed("is a 3x3 recipe", { failure_type: "needs_crafting_table" });

describe("craft Project Composite contract", () => {
  it("crafts on the current surface without touching a table when the recipe fits", async () => {
    const scripted = await craftRuntime({ observe_menu: [none], craft_on_current_surface: [ok("crafted sticks", { crafted: 4, carrying: 4 })] });

    await expect(scripted.runtime.dispatch("craft", { item_id: "minecraft:stick", count: 4 })).resolves.toEqual({
      ok: true,
      message: "crafted sticks",
      data: { item_id: "minecraft:stick", crafted: 4, carrying: 4, table_source: "inventory_grid" },
    });
    expect(scripted.calls).toEqual(["observe_menu", "craft_on_current_surface"]);
    scripted.expectExhausted();
  });

  it("keeps the surface primitive internal to the Composite", async () => {
    const scripted = await craftRuntime({});

    expect(scripted.runtime.names).toContain("craft");
    expect(scripted.runtime.names).not.toContain("craft_on_current_surface");
    expect(scripted.runtime.typescriptSdk()).not.toContain("craft_on_current_surface");
    await expect(scripted.runtime.dispatch("craft_on_current_surface", { item_id: itemId }))
      .rejects.toMatchObject({ name: "ToolCallError", ability: "craft_on_current_surface" });
    expect(scripted.calls).toEqual([]);
  });

  it("walks to the nearest remembered table within distance, crafts, and closes the Menu", async () => {
    const scripted = await craftRuntime({
      observe_menu: [none, tableMenu],
      craft_on_current_surface: [needsTable, crafted],
      observe_self: [ok("self", { feet })],
      find_known_blocks: [ok("found", {
        matches: [
          { position: near, block_state: tableId },
          { position: far, block_state: tableId },
        ],
        truncated: false,
      })],
      goto_and_activate_block: [ok("opened", { position: near, outcome: "menu_opened" })],
      close_menu: [closed],
    });

    await expect(scripted.runtime.dispatch("craft", { item_id: itemId })).resolves.toEqual({
      ok: true,
      message: "crafted",
      data: { item_id: itemId, crafted: 1, carrying: 1, table_source: "remembered_table", table_position: near },
    });
    expect(scripted.invocations.filter(({ name }) => name === "goto_and_activate_block"))
      .toEqual([{ name: "goto_and_activate_block", input: { position: near } }]);
    expect(scripted.calls.at(-1)).toBe("close_menu");
    scripted.expectExhausted();
  });

  it("crafts and places a table nearby when none is remembered or carried", async () => {
    const scripted = await craftRuntime({
      observe_menu: [none, tableMenu],
      craft_on_current_surface: [needsTable, ok("crafted table", { crafted: 1, carrying: 1 }), crafted],
      observe_self: [ok("self", { feet })],
      find_known_blocks: [ok("none", { matches: [], truncated: false })],
      observe_inventory: [ok("inventory", { items: [{ item_id: "minecraft:oak_planks", count: 8 }] })],
      place_block_nearby: [ok("placed", {
        item_id: tableId, origin: feet, attempted_count: 1, successful_position: placedAt,
        placement: ok("placement verified", {
          item_id: tableId, position: placedAt, block_state: tableId, consumed_count: 1,
          placed_blocks: [{ position: placedAt, block_state: tableId }],
        }),
      })],
      goto_and_activate_block: [ok("opened", { position: placedAt, outcome: "menu_opened" })],
      close_menu: [closed],
    });

    await expect(scripted.runtime.dispatch("craft", { item_id: itemId })).resolves.toMatchObject({
      ok: true,
      data: { table_source: "placed_table", table_position: placedAt },
    });
    expect(scripted.invocations.filter(({ name }) => name === "craft_on_current_surface").map(({ input }) => input)).toEqual([
      { item_id: itemId }, { item_id: tableId }, { item_id: itemId },
    ]);
    scripted.expectExhausted();
  });

  it("reports missing ingredients from the recipe instead of searching for a table", async () => {
    const scripted = await craftRuntime({
      observe_menu: [none],
      craft_on_current_surface: [failed("not enough materials", {
        failure_type: "missing_ingredients", missing: ["3x iron ingot (have 1)"],
      })],
    });

    await expect(scripted.runtime.dispatch("craft", { item_id: itemId })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "not enough materials",
      data: { item_id: itemId, step: "craft", failure_type: "missing_ingredients", missing: ["3x iron ingot (have 1)"] },
    });
    expect(scripted.calls).toEqual(["observe_menu", "craft_on_current_surface"]);
    scripted.expectExhausted();
  });

  it("explains a missing table when none is remembered and none can be crafted", async () => {
    const scripted = await craftRuntime({
      observe_menu: [none],
      craft_on_current_surface: [needsTable, failed("not enough materials for crafting_table", {
        failure_type: "missing_ingredients", missing: ["4x planks (have 0)"],
      })],
      observe_self: [ok("self", { feet })],
      find_known_blocks: [ok("far only", { matches: [{ position: far, block_state: tableId }], truncated: false })],
      observe_inventory: [ok("inventory", { items: [] })],
    });

    await expect(scripted.runtime.dispatch("craft", { item_id: itemId })).resolves.toMatchObject({
      ok: false,
      data: { step: "craft_table", failure_type: "missing_ingredients" },
    });
    expect(scripted.calls).not.toContain("goto_and_activate_block");
    scripted.expectExhausted();
  });
});

type ScriptName = "observe_menu" | "close_menu" | "craft_on_current_surface" | "observe_self" | "find_known_blocks"
  | "goto_and_activate_block" | "observe_inventory" | "place_block_nearby";

async function craftRuntime(script: Partial<Record<ScriptName, readonly unknown[]>>) {
  const runtime = new AbilityRuntime();
  const calls: string[] = [];
  const invocations: Array<{ name: string; input: unknown }> = [];
  const queues = Object.fromEntries(Object.entries(script).map(([name, values]) => [name, [...values]]));
  const names: readonly ScriptName[] = [
    "observe_menu", "close_menu", "craft_on_current_surface", "observe_self", "find_known_blocks",
    "goto_and_activate_block", "observe_inventory", "place_block_nearby",
  ];
  for (const name of names) {
    await runtime.register(defineAbility({
      name,
      ...(name === "craft_on_current_surface" ? { visibility: "internal" as const } : {}),
      description: `Scripted ${name} boundary.`,
      concurrency: "safe",
      execution: name.startsWith("observe_") || name === "find_known_blocks" ? "query" : "body",
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
  const composite = projectCompositeAbilities.find(({ name }) => name === "craft");
  if (composite === undefined) throw new Error("craft Project Composite is not registered");
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

function ok(message: string, data: unknown) {
  return { ok: true as const, message, data };
}

function failed(message: string, data: unknown) {
  return { ok: false as const, error: "RUNTIME_FAILED" as const, message, data };
}
