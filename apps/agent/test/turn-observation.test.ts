import { describe, expect, it } from "vitest";

import {
  normalizeTurnObservation,
  renderTurnObservation,
  type TurnObservationInput,
} from "../src/harness/turn-observation.js";

describe("Turn Observation rendering", () => {
  it("distinguishes incomplete empty evidence and retains its query provenance", () => {
    const complete = observationInput({});
    const incomplete = {
      ...complete,
      perceivedBlocks: { blocks: [], truncated: true, provenance: { dimension: "minecraft:the_nether", min: { x: 1, y: 2, z: 3 } } },
      perceivedEntities: { entities: [], truncated: true },
    };
    const projected = normalizeTurnObservation(incomplete);
    expect(projected.perceivedBlocks.truncated).toBe(true);
    expect(projected.perceivedEntities.truncated).toBe(true);
    expect(renderTurnObservation(projected)).toContain("coverage=incomplete");
    expect(renderTurnObservation(projected)).toContain("minecraft:the_nether");
    expect(renderTurnObservation(projected)).not.toEqual(renderTurnObservation(normalizeTurnObservation(complete)));
  });

  it("renders active effects only when non-empty and never adds velocity or fall distance", () => {
    const empty = renderTurnObservation(normalizeTurnObservation(observationInput({})));
    const active = renderTurnObservation(normalizeTurnObservation(observationInput({
      self: {
        ...observationInput({}).self,
        activeEffects: [{ effectId: "minecraft:speed", amplifier: 1, remainingSeconds: 12.5 }],
      },
    })));

    expect(empty).not.toContain("active_effects=");
    expect(active).toContain("active_effects=minecraft:speed:amplifier=1:remaining_seconds=12.5");
    expect(active).not.toMatch(/velocity|fall_distance/u);
  });

  it("groups every perceived block type with its count and three nearest positions", () => {
    const input: TurnObservationInput = {
      self: {
        dimension: "minecraft:overworld",
        feet: { x: 0, y: 64, z: 0 },
        facing: "north",
        health: 19.5,
        maxHealth: 20,
        food: 18,
        airSeconds: 12.5,
        maxAirSeconds: 15,
        onGround: true,
        inWater: false,
        underwater: false,
        inLava: false,
        onFire: false,
        mainHand: { itemId: "minecraft:wooden_pickaxe", count: 1, durability: { remaining: 52, maximum: 59 } },
      },
      inventory: {
        location: "player_inventory",
        items: [
          { itemId: "minecraft:stick", count: 1 },
          { itemId: "minecraft:oak_log", count: 2 },
          { itemId: "minecraft:stick", count: 3 },
        ],
      },
      menu: { kind: "none" },
      perceivedBlocks: {
        blocks: [
          ...Array.from({ length: 17 }, (_, index) => ({
            blockId: `minecraft:block_${String(index).padStart(2, "0")}`,
            position: { x: index + 1, y: 64, z: 1 },
          })),
          { blockId: "minecraft:crafting_table", position: { x: 10, y: 64, z: 0 } },
          { blockId: "minecraft:furnace", position: { x: 1, y: 64, z: 0 } },
          { blockId: "minecraft:oak_log", position: { x: 5, y: 64, z: 0 } },
          { blockId: "minecraft:oak_log", position: { x: 2, y: 64, z: 0 } },
          { blockId: "minecraft:oak_log", position: { x: 4, y: 64, z: 0 } },
          { blockId: "minecraft:oak_log", position: { x: 3, y: 64, z: 0 } },
          { blockId: "minecraft:oak_log", position: { x: 2, y: 64, z: 0 } },
          { blockId: "minecraft:diamond_ore", position: { x: 20, y: 64, z: 0 } },
        ],
        truncated: false,
      },
      perceivedEntities: {
        entities: [
          { id: "00000000-0000-4000-8000-000000000002", entityType: "minecraft:zombie", trackState: "VISIBLE", position: { x: 4, y: 64, z: 0 }, ageSeconds: 0 },
          { id: "00000000-0000-4000-8000-000000000001", entityType: "minecraft:item", trackState: "VISIBLE", position: { x: 1, y: 64, z: 0 }, ageSeconds: 0, item: { itemId: "minecraft:oak_log", count: 7 } },
        ],
        truncated: false,
      },
      unavailableTools: [
        { error: "MENU_OPEN", tools: ["goto", "break_block", "goto"] },
        { error: "ACTOR_UNAVAILABLE", tools: ["wait"] },
      ],
    };

    const normalized = normalizeTurnObservation(input);

    expect(normalized.perceivedBlocks.groups).toHaveLength(21);
    expect(normalized.perceivedBlocks.groups.slice(0, 4)).toEqual([
      { blockId: "minecraft:furnace", count: 1, positions: [{ x: 1, y: 64, z: 0 }] },
      { blockId: "minecraft:crafting_table", count: 1, positions: [{ x: 10, y: 64, z: 0 }] },
      {
        blockId: "minecraft:oak_log",
        count: 4,
        positions: [
          { x: 2, y: 64, z: 0 },
          { x: 3, y: 64, z: 0 },
          { x: 4, y: 64, z: 0 },
        ],
      },
      { blockId: "minecraft:diamond_ore", count: 1, positions: [{ x: 20, y: 64, z: 0 }] },
    ]);
    const rendered = renderTurnObservation(normalized);
    expect(rendered).toBe(renderTurnObservation(normalizeTurnObservation(input)));
    expect(normalized.inventory.items).toEqual([
      { itemId: "minecraft:oak_log", count: 2 },
      { itemId: "minecraft:stick", count: 4 },
    ]);
    expect(rendered).toContain(
      "minecraft:oak_log count=4 positions=2,64,0;3,64,0;4,64,0",
    );
    expect(rendered).toContain("ACTOR_UNAVAILABLE=wait\nMENU_OPEN=break_block,goto");
    expect(rendered).not.toMatch(/yaw|revision|provenance|visible_now|distance=/);
    expect(rendered.slice(
      rendered.indexOf("PERCEIVED_BLOCKS"), rendered.indexOf("PERCEIVED_ENTITIES"),
    )).not.toContain("truncated=");
  });

  it("groups different BlockStates under their canonical block id", () => {
    const observation = normalizeTurnObservation(observationInput({
      perceivedBlocks: {
        blocks: [
          { blockId: "minecraft:dark_oak_leaves[distance=1,persistent=false,waterlogged=false]", position: { x: 1, y: 64, z: 0 } },
          { blockId: "minecraft:dark_oak_leaves[distance=4,persistent=false,waterlogged=false]", position: { x: 2, y: 64, z: 0 } },
          { blockId: "minecraft:dark_oak_leaves[distance=2,persistent=false,waterlogged=false]", position: { x: 3, y: 64, z: 0 } },
        ],
        truncated: false,
      },
    }));

    expect(observation.perceivedBlocks.groups).toEqual([{
      blockId: "minecraft:dark_oak_leaves",
      count: 3,
      positions: [
        { x: 1, y: 64, z: 0 },
        { x: 2, y: 64, z: 0 },
        { x: 3, y: 64, z: 0 },
      ],
    }]);
    expect(renderTurnObservation(observation)).not.toContain("distance=");
  });

  it("groups every perceived entity kind with its count and three actionable samples", () => {
    const input = observationInput({
      perceivedEntities: {
        entities: [
          entity("00000000-0000-4000-8000-000000000001", "minecraft:cow", 4, "VISIBLE", 0),
          entity("00000000-0000-4000-8000-000000000002", "minecraft:cow", 2, "VISIBLE", 0),
          entity("00000000-0000-4000-8000-000000000003", "minecraft:cow", 1, "RECENT", 1.2),
          entity("00000000-0000-4000-8000-000000000004", "minecraft:cow", 3, "RECENT", 0.8),
          entity("00000000-0000-4000-8000-000000000004", "minecraft:cow", 3, "RECENT", 0.8),
          itemEntity("00000000-0000-4000-8000-000000000005", "minecraft:oak_log", 4, 1),
          itemEntity("00000000-0000-4000-8000-000000000006", "minecraft:oak_log", 7, 5),
          itemEntity("00000000-0000-4000-8000-000000000007", "minecraft:cobblestone", 2, 6),
          entity("00000000-0000-4000-8000-000000000008", "minecraft:pig", 1.5, "VISIBLE", 0),
          ...Array.from({ length: 17 }, (_, index) => entity(
            `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            `minecraft:entity_${String(index).padStart(2, "0")}`,
            index + 10,
            "RECENT",
            index + 1,
          )),
        ],
        truncated: true,
      },
    });

    const normalized = normalizeTurnObservation(input);

    expect(normalized.perceivedEntities.groups).toHaveLength(21);
    expect(normalized.perceivedEntities.groups.slice(0, 4)).toEqual([
      {
        entityType: "minecraft:cow",
        count: 4,
        samples: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            position: { x: 2, y: 64, z: 0 },
            trackState: "VISIBLE",
          },
          {
            id: "00000000-0000-4000-8000-000000000001",
            position: { x: 4, y: 64, z: 0 },
            trackState: "VISIBLE",
          },
          {
            id: "00000000-0000-4000-8000-000000000003",
            position: { x: 1, y: 64, z: 0 },
            trackState: "RECENT",
            ageSeconds: 1.2,
          },
        ],
      },
      {
        entityType: "minecraft:item",
        itemId: "minecraft:oak_log",
        count: 2,
        samples: [
          {
            id: "00000000-0000-4000-8000-000000000005",
            position: { x: 1, y: 64, z: 0 },
            trackState: "VISIBLE",
            itemCount: 4,
          },
          {
            id: "00000000-0000-4000-8000-000000000006",
            position: { x: 5, y: 64, z: 0 },
            trackState: "VISIBLE",
            itemCount: 7,
          },
        ],
      },
      {
        entityType: "minecraft:pig",
        count: 1,
        samples: [{
          id: "00000000-0000-4000-8000-000000000008",
          position: { x: 1.5, y: 64, z: 0 },
          trackState: "VISIBLE",
        }],
      },
      {
        entityType: "minecraft:item",
        itemId: "minecraft:cobblestone",
        count: 1,
        samples: [{
          id: "00000000-0000-4000-8000-000000000007",
          position: { x: 6, y: 64, z: 0 },
          trackState: "VISIBLE",
          itemCount: 2,
        }],
      },
    ]);
    const rendered = renderTurnObservation(normalized);
    expect(rendered).toContain(
      "minecraft:cow count=4 samples="
      + "00000000-0000-4000-8000-000000000002@2,64,0:VISIBLE;"
      + "00000000-0000-4000-8000-000000000001@4,64,0:VISIBLE;"
      + "00000000-0000-4000-8000-000000000003@1,64,0:RECENT/1.2s",
    );
    expect(rendered).toContain(
      "minecraft:item[minecraft:oak_log] count=2 samples="
      + "00000000-0000-4000-8000-000000000005@1,64,0:VISIBLE/items=4;"
      + "00000000-0000-4000-8000-000000000006@5,64,0:VISIBLE/items=7",
    );
    expect(rendered).not.toContain("truncated=");
  });
});

function observationInput(overrides: Partial<TurnObservationInput>): TurnObservationInput {
  return {
    self: {
      dimension: "minecraft:overworld",
      feet: { x: 0, y: 64, z: 0 },
      facing: "north",
      health: 20,
      maxHealth: 20,
      food: 20,
      airSeconds: 15,
      maxAirSeconds: 15,
      onGround: true,
      inWater: false,
      underwater: false,
      inLava: false,
      onFire: false,
      mainHand: null,
    },
    inventory: { location: "player_inventory", items: [] },
    menu: { kind: "none" },
    perceivedBlocks: { blocks: [], truncated: false },
    perceivedEntities: { entities: [], truncated: false },
    unavailableTools: [],
    ...overrides,
  };
}

function entity(
  id: string,
  entityType: string,
  x: number,
  trackState: "VISIBLE" | "RECENT",
  ageSeconds: number,
): TurnObservationInput["perceivedEntities"]["entities"][number] {
  return { id, entityType, position: { x, y: 64, z: 0 }, trackState, ageSeconds };
}

function itemEntity(
  id: string,
  itemId: string,
  count: number,
  x: number,
): TurnObservationInput["perceivedEntities"]["entities"][number] {
  return {
    ...entity(id, "minecraft:item", x, "VISIBLE", 0),
    item: { itemId, count },
  };
}
