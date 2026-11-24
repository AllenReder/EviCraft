import { describe, expect, it } from "vitest";

import {
  AbilityRuntime,
  defineAbility,
  defineCompositeAbility,
  toolSchema as s,
  type ScopedAbilityNamespace,
} from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const first = { x: 4, y: 64, z: -2 };
const second = { x: 7, y: 64, z: 3 };

describe("bounded collect_blocks Project Composite contract", () => {
  it("publishes both bounded input branches and the closed canonical progress result", async () => {
    const runtime = new AbilityRuntime();
    const collectBlocks = projectCompositeAbilities.find(({ name }) => name === "collect_blocks");
    expect(collectBlocks).toBeDefined();
    await runtime.register(collectBlocks!);

    expect(collectBlocks!.input.parse({
      positions: [first, second],
    })).toEqual({ positions: [first, second] });
    expect(collectBlocks!.input.parse({
      block_id_glob: "minecraft:*_ore",
      count: 2,
    })).toEqual({ block_id_glob: "minecraft:*_ore", count: 2 });
    expect(collectBlocks!.input.parse({
      block_id_glob: "minecraft:*_ore",
    })).toEqual({ block_id_glob: "minecraft:*_ore" });
    const modelTool = runtime.modelTools().find(({ name }) => name === "collect_blocks");
    expect(modelTool).toMatchObject({
      inputSchema: {
        oneOf: [
          expect.objectContaining({
            required: ["block_id_glob"],
            properties: expect.not.objectContaining({
              positions: expect.anything(),
              distance: expect.anything(),
            }),
          }),
          expect.objectContaining({
            required: ["positions"],
            properties: expect.not.objectContaining({ block_id_glob: expect.anything() }),
          }),
        ],
      },
    });
    for (const invalid of [
      { positions: [first, first] },
      { positions: [] },
      { block_id_glob: "minecraft:*_log", count: 0 },
      { block_id_glob: "minecraft:*_log", count: 33 },
      { block_id_glob: "minecraft:*_log", count: 1, distance: 1 },
      { positions: [{ x: 1.5, y: 64, z: 2 }] },
      { block_id_glob: "minecraft:(oak|birch)_log" },
      { block_id_glob: "minecraft:*_log", positions: [first], count: 1 },
    ]) {
      expect(() => collectBlocks!.input.parse(invalid)).toThrow();
    }

    const sdk = runtime.typescriptSdk();
    expect(sdk).toContain("readonly collect_blocks:");
    expect(sdk).toContain("readonly positions:");
    const collectBlocksDeclaration = sdk.slice(
      sdk.indexOf("readonly collect_blocks:"), sdk.indexOf("readonly collect_items:"),
    );
    expect(collectBlocksDeclaration).not.toContain("readonly distance?: number");
    expect(sdk).toContain("readonly requested_blocks: number");
    expect(sdk).toContain("readonly unresolved_observed_drops:");
  });

  it("breaks coordinate-mode positions in dynamic nearest-first order without id matching", async () => {
    const far = { x: 8, y: 64, z: 0 };
    const near = { x: 2, y: 64, z: 0 };
    const middle = { x: 5, y: 64, z: 0 };
    const calls: string[] = [];
    const selfPositions = [
      { x: 0, y: 64, z: 0 },
      { x: 7, y: 64, z: 0 },
      { x: 6, y: 64, z: 0 },
    ];
    const runtime = await collectBlocksRuntime({
      observeSelf() {
        calls.push("observe_self");
        const position = selfPositions.shift();
        if (position === undefined) throw new Error("unexpected self observation");
        return selfAt(position);
      },
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:stone");
      },
      observeInventory() {
        calls.push("observe_inventory");
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return verifiedBreak(position, []);
      },
      collectItems() {
        throw new Error("zero-drop breaks must not invoke collect_items");
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [far, near, middle],
    })).resolves.toEqual({
      ok: true,
      message: "completed requested block collection",
      data: {
        requested_blocks: 3,
        completed_blocks: 3,
        broken_blocks: 3,
        collected_items: {},
        completed_positions: [near, far, middle],
        skipped_positions: [],
        unresolved_observed_drops: [],
      },
    });
    expect(calls).toEqual([
      "observe_self",
      `observe_block:${key(near)}`,
      "observe_inventory",
      `goto_and_break_block:${key(near)}`,
      "observe_self",
      `observe_block:${key(far)}`,
      "observe_inventory",
      `goto_and_break_block:${key(far)}`,
      "observe_self",
      `observe_block:${key(middle)}`,
      "observe_inventory",
      `goto_and_break_block:${key(middle)}`,
    ]);
  });

  it("retries unknown coordinate evidence three times before breaking", async () => {
    let observations = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeSelf() { return selfAt({ x: 0, y: 64, z: 0 }); },
      observeBlock(position) {
        observations += 1;
        calls.push(`observe_block:${key(position)}`);
        return observations < 3 ? unknownBlock(position) : knownBlock(position, "minecraft:stone");
      },
      observeInventory() {
        calls.push("observe_inventory");
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return verifiedBreak(position, []);
      },
      collectItems() { throw new Error("zero-drop breaks must not invoke collect_items"); },
      wait(seconds) {
        calls.push(`wait:${seconds}`);
        return { ok: true as const, message: "waited", data: {} };
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [first],
    })).resolves.toMatchObject({
      ok: true,
      data: { completed_positions: [first] },
    });
    expect(calls).toEqual([
      `observe_block:${key(first)}`,
      "wait:0.1",
      `observe_block:${key(first)}`,
      "wait:0.1",
      `observe_block:${key(first)}`,
      "observe_inventory",
      `goto_and_break_block:${key(first)}`,
    ]);
  });

  it("collects the nearest remembered match when called with block_id_glob alone", async () => {
    const target = { x: 3, y: 64, z: 0 };
    const runtime = await collectBlocksRuntime({
      observeSelf() { return selfAt({ x: 0, y: 64, z: 0 }); },
      findKnownBlocks() {
        return rememberedBlocks([{ position: target, block_state: "minecraft:iron_ore" }]);
      },
      observeBlock(position) { return knownBlock(position, "minecraft:iron_ore"); },
      observeInventory() { return inventory({}); },
      gotoAndBreak(position) { return verifiedBreak(position, []); },
      collectItems() { throw new Error("zero-drop breaks must not invoke collect_items"); },
    });

    await expect(runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:iron_ore",
    })).resolves.toMatchObject({
      ok: true,
      data: {
        requested_blocks: 1,
        completed_blocks: 1,
        completed_positions: [target],
      },
    });
  });

  it("requeries current-feet-ordered remembered candidates after every completed target", async () => {
    const initialNearest = { x: 3, y: 64, z: 0 };
    const nextCurrentNearest = { x: 32, y: 60, z: 0 };
    const staleNearest = { x: 4, y: 64, z: 0 };
    const calls: string[] = [];
    let query = 0;
    const runtime = await collectBlocksRuntime({
      findKnownBlocks(input) {
        calls.push(`find_known_blocks:${input.block_id_glob}`);
        query += 1;
        return rememberedBlocks(query === 1
          ? [
              { position: initialNearest, block_state: "minecraft:iron_ore" },
              { position: staleNearest, block_state: "minecraft:iron_ore" },
            ]
          : [
              { position: nextCurrentNearest, block_state: "minecraft:deepslate_iron_ore" },
              { position: staleNearest, block_state: "minecraft:iron_ore" },
            ]);
      },
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, same(position, nextCurrentNearest)
          ? "minecraft:deepslate_iron_ore" : "minecraft:iron_ore");
      },
      observeInventory() {
        calls.push("observe_inventory");
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return verifiedBreak(position, []);
      },
      collectItems() {
        throw new Error("zero-drop breaks must not invoke collect_items");
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:*iron_ore",
      count: 2,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        requested_blocks: 2,
        completed_blocks: 2,
        completed_positions: [initialNearest, nextCurrentNearest],
      },
    });
    expect(calls).toEqual([
      "find_known_blocks:minecraft:*iron_ore",
      `observe_block:${key(initialNearest)}`,
      "observe_inventory",
      `goto_and_break_block:${key(initialNearest)}`,
      "find_known_blocks:minecraft:*iron_ore",
      `observe_block:${key(nextCurrentNearest)}`,
      "observe_inventory",
      `goto_and_break_block:${key(nextCurrentNearest)}`,
    ]);
  });

  it("excludes a failed exact target from later ID-mode queries in the same call", async () => {
    const failed = { x: 1, y: 64, z: 0 };
    const next = { x: 2, y: 64, z: 0 };
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      findKnownBlocks(input) {
        calls.push(`find_known_blocks:${input.block_id_glob}`);
        return rememberedBlocks([
          { position: failed, block_state: "minecraft:oak_log" },
          { position: next, block_state: "minecraft:oak_log" },
        ]);
      },
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:oak_log");
      },
      observeInventory() {
        calls.push("observe_inventory");
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return same(position, failed) ? unreachableBreak(position) : verifiedBreak(position, []);
      },
      collectItems() { throw new Error("zero-drop breaks must not invoke collect_items"); },
    });

    await expect(runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:*_log",
      count: 1,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        completed_positions: [next],
        skipped_positions: [{ position: failed, failure_type: "unreachable" }],
      },
    });
    expect(calls).toEqual([
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(failed)}`,
      "observe_inventory",
      `goto_and_break_block:${key(failed)}`,
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(next)}`,
      "observe_inventory",
      `goto_and_break_block:${key(next)}`,
    ]);
  });

  it("keeps a selected ID-mode target fixed until its break workflow settles", async () => {
    const target = { x: 9, y: 64, z: 0 };
    const calls: string[] = [];
    let releaseBreak!: () => void;
    let startedBreak!: () => void;
    const breakStarted = new Promise<void>((resolve) => { startedBreak = resolve; });
    const runtime = await collectBlocksRuntime({
      findKnownBlocks(input) {
        calls.push(`find_known_blocks:${input.block_id_glob}`);
        return rememberedBlocks([{ position: target, block_state: "minecraft:oak_log" }]);
      },
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:oak_log");
      },
      observeInventory() {
        calls.push("observe_inventory");
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        startedBreak();
        return new Promise((resolve) => {
          releaseBreak = () => resolve(verifiedBreak(position, []));
        });
      },
      collectItems() { throw new Error("zero-drop breaks must not invoke collect_items"); },
    });

    const pending = runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:*_log",
      count: 1,
    });
    await breakStarted;
    expect(calls).toEqual([
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(target)}`,
      "observe_inventory",
      `goto_and_break_block:${key(target)}`,
    ]);

    releaseBreak();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { completed_positions: [target] },
    });
    expect(calls).toHaveLength(4);
  });

  it("freshly revalidates candidates, records pre-commit skips, and returns exhausted progress", async () => {
    const unknown = { x: 1, y: 64, z: 0 };
    const changed = { x: 2, y: 64, z: 0 };
    const mismatched = { x: 3, y: 64, z: 0 };
    const unreachable = { x: 4, y: 64, z: 0 };
    const nonInteractable = { x: 5, y: 64, z: 0 };
    const completed = { x: 6, y: 64, z: 0 };
    const positions = [unknown, changed, mismatched, unreachable, nonInteractable, completed];
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeSelf() {
        calls.push("observe_self");
        return selfAt({ x: 0, y: 64, z: 0 });
      },
      findKnownBlocks(input) {
        calls.push(`find_known_blocks:${input.block_id_glob}`);
        return rememberedBlocks(positions.map((position) => ({
          position, block_state: "minecraft:oak_log[axis=y]",
        })));
      },
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        if (same(position, unknown)) return unknownBlock(position);
        if (same(position, changed)) return knownAir(position);
        if (same(position, mismatched)) return knownBlock(position, "minecraft:stone");
        return knownBlock(position, "minecraft:oak_log[axis=y]");
      },
      observeInventory() {
        calls.push("observe_inventory");
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        if (same(position, unreachable)) return unreachableBreak(position);
        if (same(position, nonInteractable)) return unbreakableBreak(position);
        return verifiedBreak(position, []);
      },
      collectItems() {
        throw new Error("zero-drop breaks must not invoke collect_items");
      },
      wait(seconds) {
        calls.push(`wait:${seconds}`);
        return { ok: true as const, message: "waited", data: {} };
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:*_log",
      count: 6,
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "completed 1 of 6 requested block targets",
      data: {
        requested_blocks: 6,
        completed_blocks: 1,
        broken_blocks: 1,
        collected_items: {},
        completed_positions: [completed],
        skipped_positions: [
          { position: unknown, failure_type: "target_not_known" },
          { position: changed, failure_type: "changed" },
          { position: mismatched, failure_type: "mismatched" },
          { position: unreachable, failure_type: "unreachable" },
          { position: nonInteractable, failure_type: "non_interactable" },
        ],
        unresolved_observed_drops: [],
      },
    });
    expect(calls).toEqual([
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(unknown)}`,
      "wait:0.1",
      `observe_block:${key(unknown)}`,
      "wait:0.1",
      `observe_block:${key(unknown)}`,
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(changed)}`,
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(mismatched)}`,
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(unreachable)}`,
      "observe_inventory",
      `goto_and_break_block:${key(unreachable)}`,
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(nonInteractable)}`,
      "observe_inventory",
      `goto_and_break_block:${key(nonInteractable)}`,
      "find_known_blocks:minecraft:*_log",
      `observe_block:${key(completed)}`,
      "observe_inventory",
      `goto_and_break_block:${key(completed)}`,
      "find_known_blocks:minecraft:*_log",
    ]);
  });

  it("collects every observed UUID before reconciling a target-lost UUID with immediate Inventory gains", async () => {
    const firstDrop = "00000000-0000-4000-8000-000000000001";
    const secondDrop = "00000000-0000-4000-8000-000000000002";
    const thirdDrop = "00000000-0000-4000-8000-000000000003";
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:oak_log[axis=y]");
      },
      observeInventory() {
        inventoryObservation += 1;
        calls.push(`observe_inventory:${inventoryObservation}`);
        return inventory(inventoryObservation === 1
          ? { "minecraft:oak_log": 4 }
          : { "minecraft:oak_log": 5 });
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return verifiedBreak(position, [
          { uuid: firstDrop, item_id: "minecraft:oak_log", count: 1 },
          { uuid: secondDrop, item_id: "minecraft:oak_log", count: 2 },
          { uuid: thirdDrop, item_id: "minecraft:stick", count: 1 },
        ]);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        if (input.uuids[0] === firstDrop) {
          return {
            ok: false as const,
            error: "RUNTIME_FAILED" as const,
            message: "the exact drop was already picked up",
            data: {
              collected_entities: 0,
              collected_items: 0,
              skipped_entities: 1,
              radius: 8,
              selection: "uuids" as const,
              failure_type: "target_lost" as const,
            },
          };
        }
        return collectedItems(1, input.uuids[0] === secondDrop ? 2 : 1);
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [first],
    })).resolves.toEqual({
      ok: true,
      message: "completed requested block collection",
      data: {
        requested_blocks: 1,
        completed_blocks: 1,
        broken_blocks: 1,
        collected_items: {
          "minecraft:oak_log": 3,
          "minecraft:stick": 1,
        },
        completed_positions: [first],
        skipped_positions: [],
        unresolved_observed_drops: [],
      },
    });
    expect(calls).toEqual([
      `observe_block:${key(first)}`,
      "observe_inventory:1",
      `goto_and_break_block:${key(first)}`,
      "observe_inventory:2",
      `collect_items:${firstDrop}`,
      "observe_inventory:3",
      `collect_items:${secondDrop}`,
      "observe_inventory:4",
      `collect_items:${thirdDrop}`,
      "observe_inventory:5",
    ]);
  });

  it("reconciles target and ordered Occluding Block receipts before collecting remaining exact UUIDs", async () => {
    const targetDrop = {
      uuid: "00000000-0000-4000-8000-000000000021",
      item_id: "minecraft:oak_log",
      count: 1,
    };
    const blockerDrop = {
      uuid: "00000000-0000-4000-8000-000000000022",
      item_id: "minecraft:apple",
      count: 1,
    };
    const blocker = { x: 4, y: 65, z: -2 };
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:oak_log");
      },
      observeInventory() {
        inventoryObservation += 1;
        calls.push(`observe_inventory:${inventoryObservation}`);
        return inventory(inventoryObservation === 1 ? {} : { "minecraft:oak_log": 1 });
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return verifiedBreakWithClearings(position, [targetDrop], [{
          position: blocker,
          block_state: "minecraft:oak_leaves[persistent=false]",
          observed_drop_entities: [blockerDrop],
        }]);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        return collectedItems(1, 1);
      },
    });

    await expect(runtime.dispatch("collect_blocks", { positions: [first] })).resolves.toEqual({
      ok: true,
      message: "completed requested block collection",
      data: {
        requested_blocks: 1,
        completed_blocks: 1,
        broken_blocks: 1,
        collected_items: {
          "minecraft:oak_log": 1,
          "minecraft:apple": 1,
        },
        completed_positions: [first],
        skipped_positions: [],
        unresolved_observed_drops: [],
      },
    });
    expect(calls).toEqual([
      `observe_block:${key(first)}`,
      "observe_inventory:1",
      `goto_and_break_block:${key(first)}`,
      "observe_inventory:2",
      `collect_items:${blockerDrop.uuid}`,
      "observe_inventory:3",
      `collect_items:${targetDrop.uuid}`,
      "observe_inventory:4",
    ]);
  });

  it("collects the target UUID after a same-id Occluding Block was immediately picked up", async () => {
    const blockerDrop = {
      uuid: "00000000-0000-4000-8000-000000000031",
      item_id: "minecraft:oak_log",
      count: 1,
    };
    const targetDrop = {
      uuid: "00000000-0000-4000-8000-000000000032",
      item_id: "minecraft:oak_log",
      count: 1,
    };
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) { return knownBlock(position, "minecraft:oak_log"); },
      observeInventory() {
        inventoryObservation += 1;
        return inventory(inventoryObservation === 1 ? {} : { "minecraft:oak_log": 1 });
      },
      gotoAndBreak(position) {
        return verifiedBreakWithClearings(position, [targetDrop], [{
          position: { x: position.x, y: position.y + 1, z: position.z },
          block_state: "minecraft:oak_leaves[persistent=false]",
          observed_drop_entities: [blockerDrop],
        }]);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        if (input.uuids[0] === blockerDrop.uuid) return targetLostCollection();
        if (input.uuids[0] === targetDrop.uuid) return collectedItems(1, 1);
        throw new Error("unexpected UUID");
      },
    });

    await expect(runtime.dispatch("collect_blocks", { positions: [first] })).resolves.toMatchObject({
      ok: true,
      data: { collected_items: { "minecraft:oak_log": 2 }, unresolved_observed_drops: [] },
    });
    expect(calls).toEqual([
      `collect_items:${blockerDrop.uuid}`,
      `collect_items:${targetDrop.uuid}`,
    ]);
  });

  it("reconciles a same-id target UUID only after its exact collection reports it missing", async () => {
    const blockerDrop = {
      uuid: "00000000-0000-4000-8000-000000000033",
      item_id: "minecraft:oak_log",
      count: 1,
    };
    const targetDrop = {
      uuid: "00000000-0000-4000-8000-000000000034",
      item_id: "minecraft:oak_log",
      count: 1,
    };
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) { return knownBlock(position, "minecraft:oak_log"); },
      observeInventory() {
        inventoryObservation += 1;
        return inventory(inventoryObservation === 1 ? {} : {
          "minecraft:oak_log": inventoryObservation < 3 ? 1 : 2,
        });
      },
      gotoAndBreak(position) {
        return verifiedBreakWithClearings(position, [targetDrop], [{
          position: { x: position.x, y: position.y + 1, z: position.z },
          block_state: "minecraft:oak_leaves[persistent=false]",
          observed_drop_entities: [blockerDrop],
        }]);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        if (input.uuids[0] === blockerDrop.uuid) return collectedItems(1, 1);
        if (input.uuids[0] === targetDrop.uuid) return targetLostCollection();
        throw new Error("unexpected UUID");
      },
    });

    await expect(runtime.dispatch("collect_blocks", { positions: [first] })).resolves.toMatchObject({
      ok: true,
      data: { collected_items: { "minecraft:oak_log": 2 }, unresolved_observed_drops: [] },
    });
    expect(calls).toEqual([
      `collect_items:${blockerDrop.uuid}`,
      `collect_items:${targetDrop.uuid}`,
    ]);
  });

  it.each([
    ["different item ids", "minecraft:oak_leaves", "minecraft:oak_log"],
    ["the same item id", "minecraft:oak_log", "minecraft:oak_log"],
  ] as const)("reconciles a cross-pickup of %s after the first exact UUID collection", async (
    _label, blockerItemId, targetItemId,
  ) => {
    const blockerDrop = {
      uuid: "00000000-0000-4000-8000-000000000035",
      item_id: blockerItemId,
      count: 1,
    };
    const targetDrop = {
      uuid: "00000000-0000-4000-8000-000000000036",
      item_id: targetItemId,
      count: 1,
    };
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) { return knownBlock(position, "minecraft:oak_log"); },
      observeInventory() {
        inventoryObservation += 1;
        calls.push(`observe_inventory:${inventoryObservation}`);
        return inventory(inventoryObservation < 3 ? {} : {
          [blockerItemId]: blockerItemId === targetItemId ? 2 : 1,
          ...(blockerItemId === targetItemId ? {} : { [targetItemId]: 1 }),
        });
      },
      gotoAndBreak(position) {
        return verifiedBreakWithClearings(position, [targetDrop], [{
          position: { x: position.x, y: position.y + 1, z: position.z },
          block_state: "minecraft:oak_leaves[persistent=false]",
          observed_drop_entities: [blockerDrop],
        }]);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        if (input.uuids[0] === blockerDrop.uuid) return collectedItems(1, 1);
        if (input.uuids[0] === targetDrop.uuid) return targetLostCollection();
        throw new Error("unexpected UUID");
      },
    });

    await expect(runtime.dispatch("collect_blocks", { positions: [first] })).resolves.toMatchObject({
      ok: true,
      data: {
        collected_items: {
          [blockerItemId]: blockerItemId === targetItemId ? 2 : 1,
          ...(blockerItemId === targetItemId ? {} : { [targetItemId]: 1 }),
        },
        unresolved_observed_drops: [],
      },
    });
    expect(calls).toEqual([
      "observe_inventory:1",
      "observe_inventory:2",
      `collect_items:${blockerDrop.uuid}`,
      "observe_inventory:3",
      `collect_items:${targetDrop.uuid}`,
      "observe_inventory:4",
    ]);
  });

  it("continues later target mutation when an observed Occluding Block drop remains unresolved", async () => {
    const blockerDrop = {
      uuid: "00000000-0000-4000-8000-000000000023",
      item_id: "minecraft:oak_sapling",
      count: 1,
    };
    const secondTarget = { x: 8, y: 64, z: -2 };
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:oak_log");
      },
      observeInventory() {
        inventoryObservation += 1;
        calls.push(`observe_inventory:${inventoryObservation}`);
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return verifiedBreakWithClearings(position, [], [{
          position: { x: position.x, y: position.y + 1, z: position.z },
          block_state: "minecraft:oak_leaves[persistent=false]",
          observed_drop_entities: [blockerDrop],
        }]);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        return {
          ok: false as const,
          error: "RUNTIME_FAILED" as const,
          message: "observed drop target was lost",
          data: {
            collected_entities: 0,
            collected_items: 0,
            skipped_entities: 1,
            radius: 8,
            selection: "uuids" as const,
            failure_type: "target_lost" as const,
          },
        };
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [first, secondTarget],
    })).resolves.toMatchObject({
      ok: true,
      message: "completed requested block collection with unresolved observed drops",
      data: {
        requested_blocks: 2,
        completed_blocks: 2,
        broken_blocks: 2,
        completed_positions: [first, secondTarget],
        unresolved_observed_drops: [blockerDrop],
      },
    });
    expect(calls).toEqual([
      `observe_block:${key(first)}`,
      "observe_inventory:1",
      `goto_and_break_block:${key(first)}`,
      "observe_inventory:2",
      `collect_items:${blockerDrop.uuid}`,
      "observe_inventory:3",
      `observe_block:${key(secondTarget)}`,
      "observe_inventory:4",
      `goto_and_break_block:${key(secondTarget)}`,
      "observe_inventory:5",
    ]);
  });

  it("does not preallocate immediate same-item gains before exact UUID collection", async () => {
    const liveDrop = "00000000-0000-4000-8000-000000000011";
    const pickedDrop = "00000000-0000-4000-8000-000000000012";
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) {
        return knownBlock(position, "minecraft:oak_log[axis=y]");
      },
      observeInventory() {
        inventoryObservation += 1;
        return inventory(inventoryObservation === 1 ? {} : { "minecraft:oak_log": 1 });
      },
      gotoAndBreak(position) {
        return verifiedBreak(position, [
          { uuid: liveDrop, item_id: "minecraft:oak_log", count: 1 },
          { uuid: pickedDrop, item_id: "minecraft:oak_log", count: 1 },
        ]);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        if (input.uuids[0] === liveDrop) return {
          ok: false as const,
          error: "RUNTIME_FAILED" as const,
          message: "the exact drop was already picked up",
          data: {
            collected_entities: 0,
            collected_items: 0,
            skipped_entities: 1,
            radius: 8,
            selection: "uuids" as const,
            failure_type: "target_lost" as const,
          },
        };
        if (input.uuids[0] === pickedDrop) return collectedItems(1, 1);
        throw new Error("unexpected UUID");
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [first],
    })).resolves.toEqual({
      ok: true,
      message: "completed requested block collection",
      data: {
        requested_blocks: 1,
        completed_blocks: 1,
        broken_blocks: 1,
        collected_items: { "minecraft:oak_log": 2 },
        completed_positions: [first],
        skipped_positions: [],
        unresolved_observed_drops: [],
      },
    });
    expect(calls).toEqual([
      `collect_items:${liveDrop}`,
      `collect_items:${pickedDrop}`,
    ]);
  });

  it("continues later targets after a requested target drop remains unresolved", async () => {
    const drop = {
      uuid: "00000000-0000-4000-8000-000000000004",
      item_id: "minecraft:cobblestone",
      count: 1,
    };
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:stone");
      },
      observeInventory() {
        inventoryObservation += 1;
        calls.push(`observe_inventory:${inventoryObservation}`);
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return verifiedBreak(position, [drop]);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        return {
          ok: false as const,
          error: "RUNTIME_FAILED" as const,
          message: "observed drop target was lost",
          data: {
            collected_entities: 0,
            collected_items: 0,
            skipped_entities: 1,
            radius: 8,
            selection: "uuids" as const,
            failure_type: "target_lost" as const,
          },
        };
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [first, second],
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "completed 0 of 2 requested block targets",
      data: {
        requested_blocks: 2,
        completed_blocks: 0,
        broken_blocks: 2,
        collected_items: {},
        completed_positions: [],
        skipped_positions: [],
        unresolved_observed_drops: [drop],
      },
    });
    expect(calls).toEqual([
      `observe_block:${key(first)}`,
      "observe_inventory:1",
      `goto_and_break_block:${key(first)}`,
      "observe_inventory:2",
      `collect_items:${drop.uuid}`,
      "observe_inventory:3",
      `observe_block:${key(second)}`,
      "observe_inventory:4",
      `goto_and_break_block:${key(second)}`,
      "observe_inventory:5",
    ]);
  });

  it("uses an ID-mode replacement after an unreachable requested drop and succeeds with its unresolved summary", async () => {
    const drop = {
      uuid: "00000000-0000-4000-8000-000000000050",
      item_id: "minecraft:cobblestone",
      count: 1,
    };
    const replacement = { x: 9, y: 64, z: -2 };
    const calls: string[] = [];
    let queries = 0;
    const runtime = await collectBlocksRuntime({
      findKnownBlocks() {
        queries += 1;
        calls.push(`find_known_blocks:${queries}`);
        return rememberedBlocks([
          { position: first, block_state: "minecraft:stone" },
          { position: replacement, block_state: "minecraft:stone" },
        ]);
      },
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:stone");
      },
      observeInventory() {
        calls.push("observe_inventory");
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return same(position, first) ? verifiedBreak(position, [drop]) : verifiedBreak(position, []);
      },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        return {
          ok: false as const,
          error: "RUNTIME_FAILED" as const,
          message: "the exact drop remained unreachable",
          data: {
            collected_entities: 0,
            collected_items: 0,
            skipped_entities: 1,
            radius: 8,
            selection: "uuids" as const,
            failure_type: "unreachable" as const,
          },
        };
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:stone",
      count: 1,
    })).resolves.toEqual({
      ok: true,
      message: "completed requested block collection with unresolved observed drops",
      data: {
        requested_blocks: 1,
        completed_blocks: 1,
        broken_blocks: 2,
        collected_items: {},
        completed_positions: [replacement],
        skipped_positions: [],
        unresolved_observed_drops: [drop],
      },
    });
    expect(calls).toEqual([
      "find_known_blocks:1",
      `observe_block:${key(first)}`,
      "observe_inventory",
      `goto_and_break_block:${key(first)}`,
      "observe_inventory",
      `collect_items:${drop.uuid}`,
      "observe_inventory",
      "find_known_blocks:2",
      `observe_block:${key(replacement)}`,
      "observe_inventory",
      `goto_and_break_block:${key(replacement)}`,
    ]);
  });

  it("retains partial verified collection and only leaves the remaining drop count unresolved", async () => {
    const drop = {
      uuid: "00000000-0000-4000-8000-000000000051",
      item_id: "minecraft:cobblestone",
      count: 3,
    };
    const replacement = { x: 10, y: 64, z: -2 };
    const runtime = await collectBlocksRuntime({
      findKnownBlocks() {
        return rememberedBlocks([
          { position: first, block_state: "minecraft:stone" },
          { position: replacement, block_state: "minecraft:stone" },
        ]);
      },
      observeBlock(position) { return knownBlock(position, "minecraft:stone"); },
      observeInventory() { return inventory({}); },
      gotoAndBreak(position) {
        return same(position, first) ? verifiedBreak(position, [drop]) : verifiedBreak(position, []);
      },
      collectItems() {
        return collectedItems(1, 1);
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:stone",
      count: 1,
    })).resolves.toEqual({
      ok: true,
      message: "completed requested block collection with unresolved observed drops",
      data: {
        requested_blocks: 1,
        completed_blocks: 1,
        broken_blocks: 2,
        collected_items: { "minecraft:cobblestone": 1 },
        completed_positions: [replacement],
        skipped_positions: [],
        unresolved_observed_drops: [{ ...drop, count: 2 }],
      },
    });
  });

  it("caps ID-mode attempts at 32 exact positions including skipped targets", async () => {
    const candidates = Array.from({ length: 33 }, (_, index) => ({
      position: { x: index + 1, y: 64, z: 0 },
      block_state: "minecraft:stone",
    }));
    const attempted: Position[] = [];
    const runtime = await collectBlocksRuntime({
      findKnownBlocks() { return rememberedBlocks(candidates); },
      observeBlock(position) { return knownBlock(position, "minecraft:stone"); },
      observeInventory() { return inventory({}); },
      gotoAndBreak(position) {
        attempted.push(position);
        return unreachableBreak(position);
      },
      collectItems() { throw new Error("unreachable targets must not collect drops"); },
    });

    await expect(runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:stone",
      count: 32,
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "completed 0 of 32 requested block targets",
      data: {
        requested_blocks: 32,
        completed_blocks: 0,
        broken_blocks: 0,
        collected_items: {},
        completed_positions: [],
        skipped_positions: candidates.slice(0, 32).map(({ position }) => ({
          position, failure_type: "unreachable" as const,
        })),
        unresolved_observed_drops: [],
      },
    });
    expect(attempted).toHaveLength(32);
    expect(new Set(attempted.map(key)).size).toBe(32);
  });

  it("retains completed exact collection and marks later drops unresolved when collection is interrupted", async () => {
    const firstDrop = {
      uuid: "00000000-0000-4000-8000-000000000040",
      item_id: "minecraft:oak_log",
      count: 1,
    };
    const secondDrop = {
      uuid: "00000000-0000-4000-8000-000000000041",
      item_id: "minecraft:stick",
      count: 1,
    };
    const controller = new AbortController();
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) { return knownBlock(position, "minecraft:oak_log"); },
      observeInventory() { return inventory({}); },
      gotoAndBreak(position) { return verifiedBreak(position, [firstDrop, secondDrop]); },
      collectItems(input) {
        calls.push(`collect_items:${input.uuids.join(",")}`);
        controller.abort(new Error("operator canceled"));
        return collectedItems(1, 1);
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [first],
    }, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: {
        requested_blocks: 1,
        completed_blocks: 0,
        broken_blocks: 1,
        collected_items: { "minecraft:oak_log": 1 },
        completed_positions: [],
        skipped_positions: [],
        unresolved_observed_drops: [secondDrop],
      },
    });
    expect(calls).toEqual([`collect_items:${firstDrop.uuid}`]);
  });

  it.each(["target_lost", "unreachable"] as const)(
    "preserves partial collection before cancellation after a %s collect_items failure",
    async (failure_type) => {
      const drop = {
        uuid: `00000000-0000-4000-8000-${failure_type === "target_lost" ? "000000000052" : "000000000053"}`,
        item_id: "minecraft:oak_log",
        count: 2,
      };
      const controller = new AbortController();
      const calls: string[] = [];
      const runtime = await collectBlocksRuntime({
        observeBlock(position) { return knownBlock(position, "minecraft:oak_log"); },
        observeInventory() { return inventory({}); },
        gotoAndBreak(position) { return verifiedBreak(position, [drop]); },
        collectItems(input) {
          calls.push(`collect_items:${input.uuids.join(",")}`);
          controller.abort(new Error("operator canceled"));
          return {
            ok: false as const,
            error: "RUNTIME_FAILED" as const,
            message: "the exact drop was only partially collected",
            data: {
              collected_entities: 1,
              collected_items: 1,
              skipped_entities: 1,
              radius: 8,
              selection: "uuids" as const,
              failure_type,
            },
          };
        },
      });

      await expect(runtime.dispatch("collect_blocks", {
        positions: [first],
      }, { signal: controller.signal })).resolves.toEqual({
        ok: false,
        error: "INTERRUPTED",
        message: "composite interrupted",
        data: {
          requested_blocks: 1,
          completed_blocks: 0,
          broken_blocks: 1,
          collected_items: { "minecraft:oak_log": 1 },
          completed_positions: [],
          skipped_positions: [],
          unresolved_observed_drops: [{ ...drop, count: 1 }],
        },
      });
      expect(calls).toEqual([`collect_items:${drop.uuid}`]);
    },
  );

  it("preserves no unassigned immediate gain when cancellation follows after-break Inventory observation", async () => {
    const drop = {
      uuid: "00000000-0000-4000-8000-000000000043",
      item_id: "minecraft:oak_log",
      count: 1,
    };
    const controller = new AbortController();
    let inventoryObservation = 0;
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) { return knownBlock(position, "minecraft:oak_log"); },
      observeInventory() {
        inventoryObservation += 1;
        calls.push(`observe_inventory:${inventoryObservation}`);
        if (inventoryObservation === 2) controller.abort(new Error("operator canceled"));
        return inventory(inventoryObservation === 1 ? {} : { "minecraft:oak_log": 1 });
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return verifiedBreak(position, [drop]);
      },
      collectItems() { throw new Error("collection started after cancellation"); },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [first],
    }, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: {
        requested_blocks: 1,
        completed_blocks: 0,
        broken_blocks: 1,
        collected_items: {},
        completed_positions: [],
        skipped_positions: [],
        unresolved_observed_drops: [drop],
      },
    });
    expect(calls).toEqual([
      "observe_inventory:1",
      `goto_and_break_block:${key(first)}`,
      "observe_inventory:2",
    ]);
  });

  it("returns committed clearing receipts as unresolved when the child break workflow is interrupted", async () => {
    const blockerDrop = {
      uuid: "00000000-0000-4000-8000-000000000042",
      item_id: "minecraft:oak_sapling",
      count: 1,
    };
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        return knownBlock(position, "minecraft:oak_log");
      },
      observeInventory() {
        calls.push("observe_inventory");
        return inventory({});
      },
      gotoAndBreak(position) {
        calls.push(`goto_and_break_block:${key(position)}`);
        return interruptedBreakWithClearings(position, [{
          position: { x: position.x, y: position.y + 1, z: position.z },
          block_state: "minecraft:oak_leaves[persistent=false]",
          observed_drop_entities: [blockerDrop],
        }]);
      },
      collectItems() { throw new Error("nested collection started after child interruption"); },
    });

    await expect(runtime.dispatch("collect_blocks", { positions: [first] })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "child interrupted",
      data: {
        requested_blocks: 1,
        completed_blocks: 0,
        broken_blocks: 0,
        collected_items: {},
        completed_positions: [],
        skipped_positions: [],
        unresolved_observed_drops: [blockerDrop],
      },
    });
    expect(calls).toEqual([
      `observe_block:${key(first)}`,
      "observe_inventory",
      `goto_and_break_block:${key(first)}`,
    ]);
  });

  it.each(["observe_block", "observe_inventory"] as const)(
    "starts no new call after Root cancellation is latched by %s",
    async (cancelAfter) => {
    const controller = new AbortController();
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      observeBlock(position) {
        calls.push(`observe_block:${key(position)}`);
        if (cancelAfter === "observe_block") controller.abort(new Error("operator canceled"));
        return knownBlock(position, "minecraft:stone");
      },
      observeInventory() {
        calls.push("observe_inventory");
        if (cancelAfter === "observe_inventory") controller.abort(new Error("operator canceled"));
        return inventory({});
      },
      gotoAndBreak() {
        calls.push("goto_and_break_block");
        throw new Error("mutation started after cancellation");
      },
      collectItems() {
        throw new Error("unexpected collection");
      },
    });

    await expect(runtime.dispatch("collect_blocks", {
      positions: [first],
    }, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: {
        requested_blocks: 1,
        completed_blocks: 0,
        broken_blocks: 0,
        collected_items: {},
        completed_positions: [],
        skipped_positions: [],
        unresolved_observed_drops: [],
      },
    });
    expect(calls).toEqual(cancelAfter === "observe_block"
      ? [`observe_block:${key(first)}`]
      : [`observe_block:${key(first)}`, "observe_inventory"]);
  });

  it("returns interruption without a later mutation when the current-feet candidate query is canceled", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const runtime = await collectBlocksRuntime({
      findKnownBlocks() {
        calls.push("find_known_blocks");
        controller.abort(new Error("operator canceled"));
        return rememberedBlocks([{ position: first, block_state: "minecraft:stone" }]);
      },
      observeBlock() { throw new Error("unexpected block observation"); },
      observeInventory() { throw new Error("unexpected Inventory observation"); },
      gotoAndBreak() { throw new Error("unexpected break"); },
      collectItems() { throw new Error("unexpected collection"); },
    });

    await expect(runtime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:stone",
      count: 1,
    }, { signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      error: "INTERRUPTED",
      data: { requested_blocks: 1, completed_blocks: 0, broken_blocks: 0 },
    });
    expect(calls).toEqual(["find_known_blocks"]);
  });
});

interface Handlers {
  readonly observeBlock: (position: Position) => unknown | Promise<unknown>;
  readonly observeInventory: () => unknown | Promise<unknown>;
  readonly gotoAndBreak: (position: Position) => unknown | Promise<unknown>;
  readonly collectItems: (input: { uuids: readonly string[] }) => unknown | Promise<unknown>;
  readonly observeSelf?: () => unknown | Promise<unknown>;
  readonly findKnownBlocks?: (input: { block_id_glob: string }) => unknown | Promise<unknown>;
  readonly wait?: (seconds: number) => unknown | Promise<unknown>;
}

type Position = { x: number; y: number; z: number };

async function collectBlocksRuntime(handlers: Handlers) {
  const runtime = new AbilityRuntime();
  type NoAbilities = ScopedAbilityNamespace<readonly []>;
  const gotoAndBreak = defineCompositeAbility<NoAbilities>()({
    name: "goto_and_break_block", description: "Scripted conditional break workflow.",
    concurrency: "safe",
    input: s.object({ position: s.field(positionSchema(), { description: "Position" }) }),
    output: s.losslessJson(),
    execute: ({ position }) => handlers.gotoAndBreak(position),
  });
  const definitions = [
    defineAbility({
      name: "observe_block", description: "Scripted exact block evidence.",
      concurrency: "safe", execution: "query", input: positionSchema(), output: s.losslessJson(),
      execute: handlers.observeBlock,
    }),
    defineAbility({
      name: "observe_inventory", description: "Scripted Inventory evidence.",
      concurrency: "safe", execution: "query", input: s.object({}), output: s.losslessJson(),
      execute: handlers.observeInventory,
    }),
    gotoAndBreak,
    defineAbility({
      name: "collect_items", description: "Scripted exact UUID collection.",
      execution: "body", input: s.object({ uuids: s.field(s.array(s.string()), { description: "UUIDs" }) }), output: s.losslessJson(),
      execute: handlers.collectItems,
    }),
  ];
  definitions.push(defineAbility({
    name: "observe_self", description: "Scripted self position.",
    concurrency: "safe", execution: "query", input: s.object({}), output: s.losslessJson(),
    execute: handlers.observeSelf ?? (() => selfAt({ x: 0, y: 64, z: 0 })),
  }));
  if (handlers.findKnownBlocks !== undefined) {
    definitions.push(defineAbility({
      name: "find_known_blocks", description: "Scripted remembered block candidates.",
      concurrency: "safe", execution: "query",
      input: s.object({ block_id_glob: s.field(s.string(), { description: "Glob" }) }), output: s.losslessJson(),
      execute: handlers.findKnownBlocks,
    }));
  }
  if (handlers.wait !== undefined) {
    definitions.push(defineAbility({
      name: "wait", description: "Scripted wait.",
      concurrency: "safe", execution: "query",
      input: s.object({ seconds: s.field(s.number(), { description: "Seconds" }) }), output: s.losslessJson(),
      execute: ({ seconds }) => handlers.wait!(seconds),
    }));
  }
  for (const definition of definitions) await runtime.register(definition);
  const collectBlocks = projectCompositeAbilities.find(({ name }) => name === "collect_blocks");
  expect(collectBlocks).toBeDefined();
  await runtime.register(collectBlocks!);
  return runtime;
}

function positionSchema() {
  return s.object({
    x: s.field(s.integer(), { description: "X" }),
    y: s.field(s.integer(), { description: "Y" }),
    z: s.field(s.integer(), { description: "Z" }),
  });
}

function knownBlock(position: Position, block_state: string) {
  return {
    ok: true as const,
    message: "fresh exact block evidence",
    data: {
      operation: "block.get" as const,
      cells: [{
        dimension: "minecraft:overworld",
        position,
        state: "KNOWN_BLOCK" as const,
        block_state,
        fluid: "minecraft:empty",
        source: "vision",
        observed_tick: 10,
        observation_revision: 2,
      }],
    },
  };
}

function unknownBlock(position: Position) {
  return {
    ok: true as const,
    message: "fresh unknown block evidence",
    data: {
      operation: "block.get" as const,
      cells: [{
        dimension: "minecraft:overworld",
        position,
        state: "UNKNOWN" as const,
      }],
    },
  };
}

function knownAir(position: Position) {
  return {
    ok: true as const,
    message: "fresh known air evidence",
    data: {
      operation: "block.get" as const,
      cells: [{
        dimension: "minecraft:overworld",
        position,
        state: "KNOWN_AIR" as const,
        source: "vision",
        observed_tick: 10,
        observation_revision: 2,
      }],
    },
  };
}

function inventory(items: Readonly<Record<string, number>>) {
  const entries = Object.entries(items).map(([item_id, count]) => ({ item_id, count }));
  return {
    ok: true as const,
    message: "fresh Inventory evidence",
    data: {
      location: "player_inventory" as const,
      items: entries,
      total_slots: 41,
      occupied_slots: entries.length,
      empty_slots: 41 - entries.length,
    },
  };
}

function selfAt(feet: Position) {
  return {
    ok: true as const,
    message: "Ability Start Feet Snapshot",
    data: {
      entity_id: 1,
      name: "bot",
      game_mode: "survival" as const,
      hp: 20,
      max_hp: 20,
      hunger: 20,
      position: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 },
      dimension: "minecraft:overworld",
      equipment: {},
      backpack_slots: { used: 0, total: 41 },
      on_ground: true,
      in_water: false,
      air: "300/300",
      in_lava: false,
      underwater: false,
      on_fire: false,
      fall_distance: 0,
      facing: "north" as const,
      feet,
      velocity: { x: 0, y: 0, z: 0 },
      active_effects: [],
    },
  };
}

function rememberedBlocks(
  matches: readonly { position: Position; block_state: string }[],
) {
  return {
    ok: true as const,
    message: "frozen remembered candidates",
    data: { matches, truncated: false },
  };
}

function collectedItems(collected_entities: number, collected_items: number) {
  return {
    ok: true as const,
    message: "collected exact observed drops",
    data: {
      collected_entities,
      collected_items,
      skipped_entities: 0,
      radius: 8,
      selection: "uuids" as const,
    },
  };
}

function targetLostCollection() {
  return {
    ok: false as const,
    error: "RUNTIME_FAILED" as const,
    message: "the exact drop was already picked up",
    data: {
      collected_entities: 0,
      collected_items: 0,
      skipped_entities: 1,
      radius: 8,
      selection: "uuids" as const,
      failure_type: "target_lost" as const,
    },
  };
}

function verifiedBreak(
  position: Position,
  observed_drop_entities: readonly { uuid: string; item_id: string; count: number }[],
) {
  return verifiedBreakWithClearings(position, observed_drop_entities, []);
}

function verifiedBreakWithClearings(
  position: Position,
  observed_drop_entities: readonly { uuid: string; item_id: string; count: number }[],
  cleared_occluding_blocks: readonly {
    position: Position;
    block_state: string;
    observed_drop_entities: readonly { uuid: string; item_id: string; count: number }[];
  }[],
) {
  return {
    ok: true as const,
    message: "verified exact target disappearance",
    data: { position, observed_drop_entities, cleared_occluding_blocks },
  };
}

function interruptedBreakWithClearings(
  position: Position,
  cleared_occluding_blocks: readonly {
    position: Position;
    block_state: string;
    observed_drop_entities: readonly { uuid: string; item_id: string; count: number }[];
  }[],
) {
  return {
    ok: false as const,
    error: "INTERRUPTED" as const,
    message: "child interrupted",
    data: { position, cleared_occluding_blocks },
  };
}

function unreachableBreak(position: Position) {
  return {
    ok: false as const,
    error: "RUNTIME_FAILED" as const,
    message: "no interaction pose",
    data: { position, cleared_occluding_blocks: [], failure_type: "no_interaction_pose" as const },
  };
}

function unbreakableBreak(position: Position) {
  return {
    ok: false as const,
    error: "RUNTIME_FAILED" as const,
    message: "break failed: unbreakable",
    data: { position, cleared_occluding_blocks: [], failure_type: "target_not_breakable" as const },
  };
}

function key(position: Position) {
  return `${position.x},${position.y},${position.z}`;
}

function same(firstPosition: Position, secondPosition: Position) {
  return key(firstPosition) === key(secondPosition);
}
