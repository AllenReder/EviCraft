import { describe, expect, it } from "vitest";

import { AbilityRuntime } from "../src/index.js";
import { airSupply, observe_self, observeSelfOutput } from "../src/harness/abilities/built-in/observe_self.js";
import { projectObserveSelfResult } from "../src/harness/turn-observation.js";

const rawSelfSuccess = {
  ok: true,
  message: "observed",
  data: {
    entity_id: 1,
    name: "bot",
    game_mode: "survival",
    hp: 19.5,
    max_hp: 20,
    hunger: 18,
    position: { x: 10.5, y: 64, z: -3.25 },
    dimension: "minecraft:overworld",
    equipment: { mainhand: { item: "minecraft:iron_pickaxe", count: 1 } },
    backpack_slots: { used: 3, total: 36 },
    on_ground: true,
    in_water: false,
    air: "210/300",
    in_lava: false,
    underwater: false,
    on_fire: false,
    suffocating: false,
    intersecting_blocks: [],
    fall_distance: 2.5,
    facing: "east",
    feet: { x: 10, y: 64, z: -4 },
    velocity: { x: 0.1, y: -0.5, z: 0 },
    active_effects: [
      { effect_id: "minecraft:speed", amplifier: 1, duration_ticks: 400 },
    ],
  },
} as const;

describe("airSupply", () => {
  it("parses the Runtime-formatted current/maximum string", () => {
    expect(airSupply("210/300")).toEqual({ current: 210, maximum: 300 });
  });

  it("passes bare tick numbers through with the default maximum", () => {
    expect(airSupply(140)).toEqual({ current: 140, maximum: 300 });
  });

  it("falls back to a full supply for malformed or missing values", () => {
    expect(airSupply("breath")).toEqual({ current: 300, maximum: 300 });
    expect(airSupply(undefined)).toEqual({ current: 300, maximum: 300 });
  });
});

describe("projectObserveSelfResult", () => {
  const data = observeSelfOutput.parse(structuredClone(rawSelfSuccess));
  if (!data.ok) throw new Error("fixture must parse as success");
  const projected = projectObserveSelfResult(data.data);

  it("renames runtime fields onto the Harness body reading vocabulary", () => {
    expect(projected.health).toBe(19.5);
    expect(projected.max_health).toBe(20);
    expect(projected.food).toBe(18);
    expect(projected.dimension).toBe("minecraft:overworld");
    expect(projected.facing).toBe("east");
    expect(projected.feet).toEqual({ x: 10, y: 64, z: -4 });
    expect(projected.position).toEqual({ x: 10.5, y: 64, z: -3.25 });
    expect(projected.velocity).toEqual({ x: 0.1, y: -0.5, z: 0 });
    expect(projected.fall_distance).toBe(2.5);
  });

  it("converts the formatted air supply into tick numbers", () => {
    expect(projected.air).toBe(210);
    expect(projected.max_air).toBe(300);
  });

  it("projects the semantic main hand with zeroed damage fields", () => {
    expect(projected.main_hand).toEqual({
      item_id: "minecraft:iron_pickaxe",
      count: 1,
      damage: 0,
      max_damage: 0,
    });
  });

  it("defaults an unreported stack count to one and an empty hand to null", () => {
    const bare = structuredClone(rawSelfSuccess);
    delete (bare.data.equipment as { mainhand?: unknown }).mainhand;
    const withoutCount = structuredClone(rawSelfSuccess);
    delete (withoutCount.data.equipment.mainhand as { count?: number }).count;
    const empty = observeSelfOutput.parse(bare);
    const uncounted = observeSelfOutput.parse(withoutCount);
    if (!empty.ok || !uncounted.ok) throw new Error("fixtures must parse as success");
    expect(projectObserveSelfResult(empty.data).main_hand).toBeNull();
    expect(projectObserveSelfResult(uncounted.data).main_hand?.count).toBe(1);
  });

  it("completes effect projections with Harness-only presentation flags", () => {
    expect(projected.active_effects).toEqual([
      {
        effect_id: "minecraft:speed",
        amplifier: 1,
        duration_ticks: 400,
        ambient: false,
        visible: true,
      },
    ]);
  });

  it("keeps the embodied state flags verbatim", () => {
    expect(projected.on_ground).toBe(true);
    expect(projected.in_water).toBe(false);
    expect(projected.underwater).toBe(false);
    expect(projected.in_lava).toBe(false);
    expect(projected.on_fire).toBe(false);
  });
});

describe("observe_self raw equipment compatibility", () => {
  it("hides Runtime-only durability facts from the Agent-facing Ability result", async () => {
    const runtime = new AbilityRuntime();
    await runtime.register(observe_self);
    const raw = structuredClone(rawSelfSuccess);
    Object.assign(raw.data.equipment.mainhand, {
      damage: 7, max_damage: 250, custom_name: "exploration durability witness",
    });
    Object.assign(raw.data, {
      selected_hotbar_slot: 0,
      raw_inventory: [{
        slot: 0, item: "minecraft:iron_pickaxe", count: 1, damage: 7, max_damage: 250,
        custom_name: "exploration durability witness",
      }],
    });

    await expect(runtime.dispatch("observe_self", {}, {
      runtime: { call: async () => raw } as never,
    })).resolves.toMatchObject({
      ok: true,
      data: { equipment: { mainhand: { item: "minecraft:iron_pickaxe", count: 1 } } },
    });
    const result = await runtime.dispatch("observe_self", {}, {
      runtime: { call: async () => raw } as never,
    });
    if (!result.ok) throw new Error("raw fixture must remain an Agent-facing success");
    expect(result.data.equipment.mainhand).not.toHaveProperty("damage");
    expect(result.data.equipment.mainhand).not.toHaveProperty("max_damage");
    expect(result.data.equipment.mainhand).not.toHaveProperty("custom_name");
    expect(result.data).not.toHaveProperty("raw_inventory");
    expect(result.data).not.toHaveProperty("selected_hotbar_slot");
  });
});
