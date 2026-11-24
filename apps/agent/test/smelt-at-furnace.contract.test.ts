import { describe, expect, it } from "vitest";

import { AbilityRuntime, defineAbility, toolSchema as s } from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const furnace = { x: 4, y: 64, z: -2 };

describe("smelt_at_furnace Project Composite contract", () => {

  it("uses existing fuel before caller fuel, observes real progress, collects output, and closes", async () => {
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [
        furnaceMenu({ fuel: item("minecraft:oak_planks", 1) }),
        furnaceMenu({ input: item("minecraft:raw_iron", 2), burning: true }),
        furnaceMenu({ input: item("minecraft:raw_iron", 1), output: item("minecraft:iron_ingot", 1) }),
        furnaceMenu({ input: item("minecraft:raw_iron", 1) }),
        furnaceMenu({ input: item("minecraft:raw_iron", 1), burning: true }),
        furnaceMenu({ output: item("minecraft:iron_ingot", 1) }),
        furnaceMenu(),
      ],
      transfer_item: [
        transfer("minecraft:raw_iron", 2, "player_inventory", "menu_input"),
        transfer("minecraft:iron_ingot", 1, "menu_output", "player_inventory"),
        transfer("minecraft:stick", 1, "player_inventory", "menu_fuel"),
        transfer("minecraft:iron_ingot", 1, "menu_output", "player_inventory"),
      ],
      wait: [success("waited", {}), success("waited", {})],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 2,
      fuel_item: "minecraft:stick",
      fuel_count: 2,
      position: furnace,
    })).resolves.toEqual({
      ok: true,
      message: "smelted requested furnace input",
      data: {
        position: furnace,
        requested_input: { item_id: "minecraft:raw_iron", count: 2 },
        inserted_input: 2,
        processed_input: 2,
        collected_output: { item_id: "minecraft:iron_ingot", count: 2 },
        inserted_fuel: 1,
        remaining_fuel_budget: 1,
        remaining_input: 0,
      },
    });
    expect(scripted.calls).toEqual([
      "observe_block", "goto_and_activate_block", "observe_menu", "transfer_item", "observe_menu",
      "wait", "observe_menu", "transfer_item", "observe_menu", "transfer_item", "observe_menu",
      "wait", "observe_menu", "transfer_item", "observe_menu", "close_menu",
    ]);
    scripted.expectExhausted();
  });

  it("freezes nearby remembered furnaces once and closes a candidate whose leftovers cannot be emptied", async () => {
    const occupied = { x: 2, y: 64, z: 0 };
    const clean = { x: 3, y: 64, z: 0 };
    const outsideDefaultDistance = { x: 40, y: 64, z: 0 };
    const scripted = await smeltingRuntime({
      observe_self: [selfAt({ x: 0, y: 64, z: 0 })],
      find_known_blocks: [success("remembered furnaces", {
        matches: [
          furnaceCandidate(occupied),
          furnaceCandidate(clean),
          furnaceCandidate(outsideDefaultDistance),
        ],
        truncated: false,
      })],
      observe_block: [knownFurnace(occupied), knownFurnace(clean)],
      goto_and_activate_block: [
        success("opened occupied furnace", { position: occupied }),
        success("opened clean furnace", { position: clean }),
      ],
      observe_menu: [
        furnaceMenu({ input: item("minecraft:cobblestone", 1) }),
        furnaceMenu(),
        furnaceMenu({ input: item("minecraft:raw_iron", 1) }),
        furnaceMenu({ input: item("minecraft:raw_iron", 1), burning: true }),
        furnaceMenu({ output: item("minecraft:iron_ingot", 1) }),
        furnaceMenu(),
      ],
      transfer_item: [
        failureResult("player_inventory is full"),
        transfer("minecraft:raw_iron", 1, "player_inventory", "menu_input"),
        transfer("minecraft:coal", 1, "player_inventory", "menu_fuel"),
        transfer("minecraft:iron_ingot", 1, "menu_output", "player_inventory"),
      ],
      wait: [success("waited", {})],
      close_menu: [success("closed occupied", {}), success("closed clean", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 1,
      fuel_item: "minecraft:coal",
      fuel_count: 1,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        position: clean,
        inserted_input: 1,
        processed_input: 1,
        collected_output: { item_id: "minecraft:iron_ingot", count: 1 },
        inserted_fuel: 1,
        remaining_fuel_budget: 0,
        remaining_input: 0,
      },
    });
    expect(scripted.calls.filter((name) => name === "find_known_blocks")).toHaveLength(1);
    expect(scripted.invocations
      .filter(({ name }) => name === "goto_and_activate_block")
      .map(({ input }) => input)).toEqual([{ position: occupied }, { position: clean }]);
    scripted.expectExhausted();
  });

  it("recovers verified output and remaining caller input after an ordinary failure without touching fuel", async () => {
    const recoverable = furnaceMenu({
      input: item("minecraft:raw_iron", 2),
      fuel: item("minecraft:oak_planks", 1),
      output: item("minecraft:iron_ingot", 1),
    });
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [
        furnaceMenu(),
        furnaceMenu({ input: item("minecraft:raw_iron", 3), burning: true }),
        recoverable,
        recoverable,
      ],
      transfer_item: [
        transfer("minecraft:raw_iron", 3, "player_inventory", "menu_input"),
        failureResult("output transfer failed"),
        transfer("minecraft:iron_ingot", 1, "menu_output", "player_inventory"),
        transfer("minecraft:raw_iron", 2, "menu_input", "player_inventory"),
      ],
      wait: [success("waited", {})],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 3,
      fuel_item: "minecraft:coal",
      fuel_count: 2,
      position: furnace,
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "output transfer failed",
      data: {
        position: furnace,
        requested_input: { item_id: "minecraft:raw_iron", count: 3 },
        inserted_input: 3,
        processed_input: 1,
        collected_output: { item_id: "minecraft:iron_ingot", count: 1 },
        inserted_fuel: 0,
        remaining_fuel_budget: 2,
        remaining_input: 0,
      },
    });
    expect(scripted.invocations
      .filter(({ name }) => name === "transfer_item")
      .map(({ input }) => input)).toEqual([
        { item_id: "minecraft:raw_iron", count: 3, source: "player_inventory", target: "menu_input" },
        { item_id: "minecraft:iron_ingot", count: 1, source: "menu_output", target: "player_inventory" },
        { item_id: "minecraft:iron_ingot", count: 1, source: "menu_output", target: "player_inventory" },
        { item_id: "minecraft:raw_iron", count: 2, source: "menu_input", target: "player_inventory" },
      ]);
    expect(JSON.stringify(scripted.invocations)).not.toContain("menu_fuel\",\"target\":\"player_inventory");
    scripted.expectExhausted();
  });

  it("rejects an exact furnace whose leftovers cannot be emptied and closes its Menu", async () => {
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [furnaceMenu({ output: item("minecraft:iron_ingot", 4) })],
      transfer_item: [failureResult("player_inventory is full")],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 1,
      fuel_item: "minecraft:coal",
      fuel_count: 1,
      position: furnace,
    })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "exact furnace input or output is occupied",
      data: { inserted_input: 0, processed_input: 0, inserted_fuel: 0, remaining_input: 0 },
    });
    expect(scripted.calls).toEqual([
      "observe_block", "goto_and_activate_block", "observe_menu", "transfer_item", "close_menu",
    ]);
    scripted.expectExhausted();
  });

  it("moves leftover output and input into the inventory before smelting in that furnace", async () => {
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [
        furnaceMenu({ input: item("minecraft:cod", 2), output: item("minecraft:iron_ingot", 4) }),
        furnaceMenu(),
        furnaceMenu({ input: item("minecraft:raw_iron", 1), burning: true }),
        furnaceMenu({ output: item("minecraft:iron_ingot", 1), burning: true }),
        furnaceMenu({ burning: true }),
      ],
      transfer_item: [
        transfer("minecraft:iron_ingot", 4, "menu_output", "player_inventory"),
        transfer("minecraft:cod", 2, "menu_input", "player_inventory"),
        transfer("minecraft:raw_iron", 1, "player_inventory", "menu_input"),
        transfer("minecraft:iron_ingot", 1, "menu_output", "player_inventory"),
      ],
      wait: [success("waited", {})],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron", count: 1, fuel_item: "minecraft:coal", fuel_count: 1, position: furnace,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        position: furnace, inserted_input: 1, processed_input: 1, inserted_fuel: 0,
        collected_output: { item_id: "minecraft:iron_ingot", count: 1 },
        recovered_items: [{ item_id: "minecraft:iron_ingot", count: 4 }, { item_id: "minecraft:cod", count: 2 }],
      },
    });
    scripted.expectExhausted();
  });

  it("chooses carried fuel and smelts every carried unit when fuel is omitted and fewer inputs are carried", async () => {
    const scripted = await smeltingRuntime({
      observe_inventory: [success("inventory", {
        location: "player_inventory",
        items: [{ item_id: "minecraft:raw_iron", count: 2 }, { item_id: "minecraft:oak_planks", count: 9 }, { item_id: "minecraft:coal", count: 3 }],
        consumables: [], total_slots: 41, occupied_slots: 3, empty_slots: 38,
      })],
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [
        furnaceMenu(),
        furnaceMenu({ input: item("minecraft:raw_iron", 2) }),
        furnaceMenu({ input: item("minecraft:raw_iron", 2), fuel: null, burning: true }),
        furnaceMenu({ output: item("minecraft:iron_ingot", 2), burning: true }),
        furnaceMenu({ burning: true }),
      ],
      transfer_item: [
        { ok: false, error: "RUNTIME_FAILED", message: "source contains 2, fewer than requested 3", data: { item_id: "minecraft:raw_iron", requested_count: 3, available_count: 2 } },
        transfer("minecraft:raw_iron", 2, "player_inventory", "menu_input"),
        transfer("minecraft:coal", 1, "player_inventory", "menu_fuel"),
        transfer("minecraft:iron_ingot", 2, "menu_output", "player_inventory"),
      ],
      wait: [success("waited", {})],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron", count: 3, position: furnace,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        requested_input: { item_id: "minecraft:raw_iron", count: 3 },
        inserted_input: 2, processed_input: 2, inserted_fuel: 1, remaining_fuel_budget: 2,
        collected_output: { item_id: "minecraft:iron_ingot", count: 2 },
      },
    });
    expect(scripted.invocations.filter(({ name }) => name === "transfer_item").map(({ input }) => input)).toContainEqual(
      { item_id: "minecraft:coal", count: 1, source: "player_inventory", target: "menu_fuel" },
    );
    scripted.expectExhausted();
  });

  it("preserves verified partial facts when Inventory-full cleanup cannot recover output or input", async () => {
    const recoverable = furnaceMenu({
      input: item("minecraft:raw_iron", 2),
      fuel: item("minecraft:oak_planks", 1),
      output: item("minecraft:iron_ingot", 1),
    });
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [
        furnaceMenu(),
        furnaceMenu({ input: item("minecraft:raw_iron", 3), burning: true }),
        recoverable,
        recoverable,
      ],
      transfer_item: [
        transfer("minecraft:raw_iron", 3, "player_inventory", "menu_input"),
        failureResult("Inventory is full"),
        failureResult("Inventory is still full"),
        failureResult("Inventory is still full"),
      ],
      wait: [success("waited", {})],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 3,
      fuel_item: "minecraft:coal",
      fuel_count: 2,
      position: furnace,
    })).resolves.toMatchObject({
      ok: false,
      message: "Inventory is full",
      data: {
        inserted_input: 3,
        processed_input: 1,
        collected_output: null,
        inserted_fuel: 0,
        remaining_fuel_budget: 2,
        remaining_input: 2,
      },
    });
    expect(JSON.stringify(scripted.invocations)).not.toContain("menu_fuel\",\"target\":\"player_inventory");
    scripted.expectExhausted();
  });

  it("starts no compensation call after Root cancellation and reports only committed input", async () => {
    const controller = new AbortController();
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [furnaceMenu()],
      transfer_item: [transfer("minecraft:raw_iron", 1, "player_inventory", "menu_input")],
    }, (event) => {
      if (event.type === "ability_call_finished" && event.ability === "transfer_item") {
        controller.abort(new Error("operator canceled"));
      }
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 1,
      fuel_item: "minecraft:coal",
      fuel_count: 1,
      position: furnace,
    }, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: {
        position: furnace,
        requested_input: { item_id: "minecraft:raw_iron", count: 1 },
        inserted_input: 1,
        processed_input: 0,
        collected_output: null,
        inserted_fuel: 0,
        remaining_fuel_budget: 1,
        remaining_input: 1,
      },
    });
    expect(scripted.calls).toEqual([
      "observe_block", "goto_and_activate_block", "observe_menu", "transfer_item",
    ]);
    scripted.expectExhausted();
  });

  it("does not treat unexplained input disappearance as processed furnace work", async () => {
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [
        furnaceMenu(),
        furnaceMenu({ input: item("minecraft:raw_iron", 1), burning: true }),
        furnaceMenu(),
        furnaceMenu(),
      ],
      transfer_item: [transfer("minecraft:raw_iron", 1, "player_inventory", "menu_input")],
      wait: [success("waited", {})],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 1,
      fuel_item: "minecraft:coal",
      fuel_count: 1,
      position: furnace,
    })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "furnace input decreased without fresh output evidence",
      data: {
        inserted_input: 1,
        processed_input: 0,
        collected_output: null,
        remaining_input: 0,
      },
    });
    scripted.expectExhausted();
  });

  it("rejects invalid input before caller fuel and closes without cleanup transfers", async () => {
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [furnaceMenu()],
      transfer_item: [failureResult("furnace rejected input")],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:cobblestone",
      count: 1,
      fuel_item: "minecraft:coal",
      fuel_count: 1,
      position: furnace,
    })).resolves.toMatchObject({
      ok: false,
      message: "furnace rejected input",
      data: {
        inserted_input: 0,
        processed_input: 0,
        inserted_fuel: 0,
        remaining_fuel_budget: 1,
        remaining_input: 0,
      },
    });
    expect(scripted.calls).toEqual([
      "observe_block", "goto_and_activate_block", "observe_menu", "transfer_item", "close_menu",
    ]);
    scripted.expectExhausted();
  });

  it("recovers loaded input when caller fuel is rejected", async () => {
    const loaded = furnaceMenu({ input: item("minecraft:raw_iron", 1) });
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [furnaceMenu(), loaded, loaded],
      transfer_item: [
        transfer("minecraft:raw_iron", 1, "player_inventory", "menu_input"),
        failureResult("furnace rejected caller fuel"),
        transfer("minecraft:raw_iron", 1, "menu_input", "player_inventory"),
      ],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 1,
      fuel_item: "minecraft:iron_ingot",
      fuel_count: 1,
      position: furnace,
    })).resolves.toMatchObject({
      ok: false,
      message: "furnace rejected caller fuel",
      data: {
        inserted_input: 1,
        processed_input: 0,
        inserted_fuel: 0,
        remaining_fuel_budget: 1,
        remaining_input: 0,
      },
    });
    expect(scripted.invocations.filter(({ name }) => name === "transfer_item").map(({ input }) => input))
      .toEqual([
        { item_id: "minecraft:raw_iron", count: 1, source: "player_inventory", target: "menu_input" },
        { item_id: "minecraft:iron_ingot", count: 1, source: "player_inventory", target: "menu_fuel" },
        { item_id: "minecraft:raw_iron", count: 1, source: "menu_input", target: "player_inventory" },
      ]);
    scripted.expectExhausted();
  });

  it("returns committed progress and recovers input when the fuel budget is exhausted", async () => {
    const remaining = furnaceMenu({ input: item("minecraft:raw_iron", 1) });
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [
        furnaceMenu(),
        furnaceMenu({ input: item("minecraft:raw_iron", 2) }),
        furnaceMenu({ input: item("minecraft:raw_iron", 2), burning: true }),
        furnaceMenu({ input: item("minecraft:raw_iron", 1), output: item("minecraft:iron_ingot", 1) }),
        remaining,
        remaining,
      ],
      transfer_item: [
        transfer("minecraft:raw_iron", 2, "player_inventory", "menu_input"),
        transfer("minecraft:stick", 1, "player_inventory", "menu_fuel"),
        transfer("minecraft:iron_ingot", 1, "menu_output", "player_inventory"),
        transfer("minecraft:raw_iron", 1, "menu_input", "player_inventory"),
      ],
      wait: [success("waited", {})],
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 2,
      fuel_item: "minecraft:stick",
      fuel_count: 1,
      position: furnace,
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "caller-authorized furnace fuel budget was exhausted",
      data: {
        position: furnace,
        requested_input: { item_id: "minecraft:raw_iron", count: 2 },
        inserted_input: 2,
        processed_input: 1,
        collected_output: { item_id: "minecraft:iron_ingot", count: 1 },
        inserted_fuel: 1,
        remaining_fuel_budget: 0,
        remaining_input: 0,
      },
    });
    scripted.expectExhausted();
  });

  it("stops after 300 bounded progress waits and recovers the remaining input", async () => {
    const waiting = furnaceMenu({ input: item("minecraft:raw_iron", 1), burning: true });
    const scripted = await smeltingRuntime({
      observe_block: [knownFurnace(furnace)],
      goto_and_activate_block: [success("opened furnace", { position: furnace })],
      observe_menu: [
        furnaceMenu({ burning: true }),
        waiting,
        ...Array.from({ length: 300 }, () => waiting),
        waiting,
      ],
      transfer_item: [
        transfer("minecraft:raw_iron", 1, "player_inventory", "menu_input"),
        transfer("minecraft:raw_iron", 1, "menu_input", "player_inventory"),
      ],
      wait: Array.from({ length: 300 }, () => success("waited", {})),
      close_menu: [success("closed", {})],
    });

    await expect(scripted.runtime.dispatch("smelt_at_furnace", {
      input_item: "minecraft:raw_iron",
      count: 1,
      fuel_item: "minecraft:coal",
      fuel_count: 1,
      position: furnace,
    })).resolves.toMatchObject({
      ok: false,
      message: "furnace progress wait bound was exhausted",
      data: {
        inserted_input: 1,
        processed_input: 0,
        inserted_fuel: 0,
        remaining_input: 0,
      },
    });
    expect(scripted.calls.filter((name) => name === "wait")).toHaveLength(300);
    expect(scripted.calls.filter((name) => name === "observe_menu")).toHaveLength(303);
    scripted.expectExhausted();
  });
});

type Script = Readonly<Record<string, unknown[]>>;

async function smeltingRuntime(
  script: Script,
  onEvent?: (event: Readonly<Record<string, unknown> & { type: string }>) => void,
) {
  const runtime = new AbilityRuntime({ onEvent });
  const calls: string[] = [];
  const invocations: Array<{ name: string; input: unknown }> = [];
  const queues = Object.fromEntries(Object.entries(script).map(([name, values]) => [name, [...values]]));
  for (const name of [
    "observe_self", "observe_inventory", "find_known_blocks", "observe_block", "goto_and_activate_block",
    "observe_menu", "transfer_item", "wait", "close_menu",
  ]) {
    await runtime.register(defineAbility({
      name,
      description: `Scripted ${name} boundary.`,
      concurrency: "safe",
      execution: name.startsWith("observe") || name === "find_known_blocks" || name === "wait"
        ? "query" : "body",
      input: s.losslessJson(),
      output: s.losslessJson(),
      async execute(input) {
        calls.push(name);
        invocations.push({ name, input });
        const next = queues[name]?.shift();
        if (next === undefined) throw new Error(`unexpected ${name}: ${JSON.stringify(input)}`);
        return typeof next === "function" ? await next(input) : next;
      },
    }));
  }
  const smelt = projectCompositeAbilities.find(({ name }) => name === "smelt_at_furnace");
  if (smelt === undefined) throw new Error("smelt_at_furnace Project Composite is not registered");
  await runtime.register(smelt);
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

function item(item_id: string, count: number) {
  return { item_id, count };
}

function knownFurnace(position: typeof furnace) {
  return success("known furnace", {
    operation: "block.get",
    cells: [{
      dimension: "minecraft:overworld",
      position,
      state: "KNOWN_BLOCK",
      block_state: "minecraft:furnace[facing=north,lit=false]",
      fluid: "minecraft:empty",
      source: "visual",
      observed_tick: 1,
      observation_revision: 1,
    }],
  });
}

function furnaceCandidate(position: typeof furnace) {
  return { position, block_state: "minecraft:furnace[facing=north,lit=false]" };
}

function selfAt(feet: typeof furnace) {
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
    backpack_slots: { used: 2, total: 41 },
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

function furnaceMenu(overrides: Readonly<Record<string, unknown>> = {}) {
  return success("fresh furnace Menu", {
    menu_type: "furnace",
    input: null,
    fuel: null,
    output: null,
    burning: false,
    burn_remaining_seconds: 0,
    cook_progress_seconds: 0,
    cook_total_seconds: 10,
    locations: ["player_inventory", "menu_input", "menu_fuel", "menu_output"],
    ...overrides,
  });
}

function transfer(item_id: string, count: number, source: string, target: string) {
  return success("transferred", { item_id, count, source, target });
}

function failureResult(message: string) {
  return { ok: false as const, error: "RUNTIME_FAILED" as const, message, data: {} };
}
