import { describe, expect, it, vi } from "vitest";
import { AbilityRuntime } from "../src/harness/ability-runtime.js";
import { eat } from "../src/harness/abilities/built-in/eat.js";
import { observe_inventory } from "../src/harness/abilities/built-in/observe_inventory.js";
import { RuntimeAdapter, type RuntimeSdkClient } from "../src/harness/runtime-adapter.js";

describe("consumable selection through the Ability interface", () => {
  it("uses the observed Inventory slot and preserves verified consumption and body effects", async () => {
    const client = fakeClient();
    const data = { item: "minecraft:potion", slot: 7, consumed_count: 1,
      returned_container: { item_id: "minecraft:glass_bottle", count: 1 },
      hp: 20, hunger: 20,
      active_effects: [{ effect_id: "minecraft:fire_resistance", amplifier: 0, duration_ticks: 3599 }] };
    client.startToolCall = vi.fn(() => ({ taskId: 1,
      result: Promise.resolve({ success: true, message: "drank selected potion", data }) }));
    const runtime = new AbilityRuntime();
    await runtime.register(eat);

    await expect(runtime.dispatch("eat", { slot: 7 }, { runtime: new RuntimeAdapter(client) }))
      .resolves.toEqual({ ok: true, message: "drank selected potion", data });
    expect(client.startToolCall).toHaveBeenCalledWith("eat", { slot: 7 });
  });

  it.each([{}, { item_id: "minecraft:potion", slot: 7 }, { slot: -1 }, { slot: 41 }])(
    "rejects ambiguous or invalid selectors before starting a body action: %j", async (input) => {
      const client = fakeClient();
      const runtime = new AbilityRuntime();
      await runtime.register(eat);
      await expect(runtime.dispatch("eat", input, { runtime: new RuntimeAdapter(client) })).rejects.toThrow();
      expect(client.startToolCall).not.toHaveBeenCalled();
    },
  );

  it("keeps aggregate counts while exposing distinct potion slots without raw component data", async () => {
    const client = fakeClient();
    client.startToolCall = vi.fn((name: string) => ({ taskId: 2, result: Promise.resolve({
      success: true, message: "inventory", data: name === "get_self_status" ? {
        raw_inventory: [
          { slot: 0, item: "minecraft:potion", count: 1, consumable: true,
            potion: { potion_id: "minecraft:swiftness", effects: [{ effect_id: "minecraft:speed", amplifier: 0, duration_ticks: 3600 }] },
            raw_nbt: "must not reach model" },
          { slot: 7, item: "minecraft:potion", count: 1, consumable: true,
            potion: { potion_id: "minecraft:fire_resistance", effects: [{ effect_id: "minecraft:fire_resistance", amplifier: 0, duration_ticks: 3600 }] } },
        ],
      } : {
        slots: [
          { index: 36, owner: "player", container_slot: 0, item_id: "minecraft:potion", count: 1 },
          { index: 43, owner: "player", container_slot: 7, item_id: "minecraft:potion", count: 1 },
        ],
      },
    }) }));
    const runtime = new AbilityRuntime();
    await runtime.register(observe_inventory);

    const result = await runtime.dispatch("observe_inventory", {}, { runtime: new RuntimeAdapter(client) });
    expect(result).toMatchObject({ ok: true, data: {
      items: [{ item_id: "minecraft:potion", count: 2 }],
      consumables: [
        { slot: 0, item_id: "minecraft:potion", potion: { potion_id: "minecraft:swiftness" } },
        { slot: 7, item_id: "minecraft:potion", potion: { potion_id: "minecraft:fire_resistance" } },
      ],
    } });
    expect(JSON.stringify(result)).not.toContain("raw_nbt");
  });
});

function fakeClient(): RuntimeSdkClient {
  return {
    runtimeInfo: vi.fn(async () => ({ world_knowledge_profile: "grounded_evidence" })),
    ensureBot: vi.fn(), actorGet: vi.fn(), startToolCall: vi.fn(), taskCancel: vi.fn(),
    observe: vi.fn(async () => ({ observation_revision: 8, server_tick: 0, game_time: 0 })),
    afterTicks: vi.fn(() => new Promise<{ server_tick: number }>(() => {})),
    blockGet: vi.fn(), blockFind: vi.fn(), blockRegion: vi.fn(), entityList: vi.fn(),
    onOccurrence: vi.fn(() => () => {}), onDisconnect: vi.fn(() => () => {}), close: vi.fn(),
  };
}
