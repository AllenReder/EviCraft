import { describe, expect, it, vi } from "vitest";

import {
  SemanticMenuTranslation,
  type RawMenuCalls,
} from "../src/harness/semantic-menu.js";

describe("SemanticMenuTranslation", () => {
  it.each([
    ["none", gui({ own_inventory: true, menu_type: null }), { menu_type: "none" }],
    ["unsupported", gui({ menu_type: "minecraft:anvil" }), { menu_type: "unsupported" }],
    ["storage", gui({ menu_type: "minecraft:generic_9x3", slots: [
      slot(0, "menu", 0, "minecraft:stone", 3),
      slot(1, "menu", 1, null, 0),
    ] }), { menu_type: "storage", contents: [{ item_id: "minecraft:stone", count: 3 }] }],
    ["crafting_table", gui({ menu_type: "minecraft:crafting" }), { menu_type: "crafting_table", surface: "3x3" }],
    ["furnace", gui({ menu_type: "minecraft:furnace", data_values: [40, 200, 20, 100], slots: [
      slot(0, "menu", 0, "minecraft:iron_ore", 1),
      slot(1, "menu", 1, "minecraft:coal", 2),
      slot(2, "menu", 2, "minecraft:iron_ingot", 1, true),
    ] }), { menu_type: "furnace", burning: true, burn_remaining_seconds: 2, cook_progress_seconds: 1 }],
  ] as const)("projects %s Menu semantics without raw GUI fields", async (_label, snapshot, expected) => {
    const calls = rawCalls([snapshot]);

    const result = await new SemanticMenuTranslation(calls).observeMenu();

    expect(result).toMatchObject({ ok: true, data: expected });
    expect(JSON.stringify(result)).not.toMatch(/"role"|cursor|container_slot|"index"/u);
  });

  it("aggregates hotbar and main inventory slots into one semantic player_inventory", async () => {
    const calls = rawCalls([gui({ slots: [
      slot(36, "player", 0, "minecraft:oak_log", 2),
      slot(9, "player", 9, "minecraft:oak_log", 3),
      slot(10, "player", 10, "minecraft:stick", 1),
      slot(11, "player", 11, null, 0),
    ] })]);

    await expect(new SemanticMenuTranslation(calls).observeInventory()).resolves.toMatchObject({
      ok: true,
      data: {
        location: "player_inventory",
        items: [
          { item_id: "minecraft:oak_log", count: 5 },
          { item_id: "minecraft:stick", count: 1 },
        ],
        total_slots: 4,
        occupied_slots: 3,
        empty_slots: 1,
      },
    });
  });

  it("plans stable multi-stack raw moves and verifies the exact semantic transfer", async () => {
    const before = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 1, slots: [
      slot(0, "menu", 0, null, 0),
      slot(1, "menu", 1, "minecraft:oak_log", 60),
      slot(36, "player", 0, "minecraft:oak_log", 3),
      slot(9, "player", 9, "minecraft:oak_log", 4),
    ] });
    const after = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 2, slots: [
      slot(0, "menu", 0, "minecraft:oak_log", 6),
      slot(1, "menu", 1, "minecraft:oak_log", 60),
      slot(36, "player", 0, null, 0),
      slot(9, "player", 9, "minecraft:oak_log", 1),
    ] });
    const receipt = {
      menu_id: 0, before_revision: 1, after_revision: 2,
      moves: [
        { from: 36, to: 0, item_id: "minecraft:oak_log", requested_count: 3, moved_count: 3, outcome: "moved" },
        { from: 9, to: 0, item_id: "minecraft:oak_log", requested_count: 3, moved_count: 3, outcome: "moved" },
      ],
    };
    const calls = rawCalls([before, receipt, after]);

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:oak_log",
      count: 6,
      source: "player_inventory",
      target: "menu_storage",
    })).resolves.toMatchObject({ ok: true, data: { count: 6 } });
    expect(calls.transfer.mock.calls[0]![0]).toEqual({
      menu_id: 0,
      menu_revision: 1,
      moves: [
        { from: 36, to: 0, count: 3 },
        { from: 9, to: 0, count: 3 },
      ],
    });
  });

  it("preserves interruption from the initial Menu inspection for transfer_item", async () => {
    const calls: RawMenuCalls = {
      inspectGui: vi.fn(async () => ({
        ok: false, error: "INTERRUPTED", message: "inspect deadline", data: {},
      })),
      transfer: vi.fn(),
    };

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:oak_log",
      count: 1,
      source: "player_inventory",
      target: "menu_storage",
    })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "inspect deadline",
      data: {},
    });
  });

  it("preserves interruption from the post-transfer Menu inspection", async () => {
    const before = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 1, slots: [
      slot(0, "menu", 0, null, 0),
      slot(36, "player", 0, "minecraft:oak_log", 1),
    ] });
    const receipt = {
      menu_id: 0,
      before_revision: 1,
      after_revision: 2,
      moves: [{
        from: 36,
        to: 0,
        item_id: "minecraft:oak_log",
        requested_count: 1,
        moved_count: 1,
        outcome: "moved",
      }],
    };
    const calls: RawMenuCalls = {
      inspectGui: vi.fn()
        .mockResolvedValueOnce({ ok: true, message: "before", data: before })
        .mockResolvedValueOnce({
          ok: false, error: "INTERRUPTED", message: "inspect cancelled", data: {},
        }),
      transfer: vi.fn(async () => ({ ok: true, message: "moved", data: receipt })),
    };

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:oak_log",
      count: 1,
      source: "player_inventory",
      target: "menu_storage",
    })).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "inspect cancelled",
      data: {},
    });
  });

  it("reports an exact fuel transfer when the Runtime receipt proves immediate consumption", async () => {
    const calls = immediateFuelCalls();

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal",
      count: 1,
      source: "player_inventory",
      target: "menu_fuel",
    })).resolves.toEqual({
      ok: true,
      message: "transferred 1 minecraft:coal",
      data: {
        item_id: "minecraft:coal", count: 1,
        source: "player_inventory", target: "menu_fuel",
      },
    });
    expect(calls.transfer.mock.calls[0]![0]).toEqual({
      menu_id: 4,
      menu_revision: 12,
      moves: [{ from: 36, to: 1, count: 1 }],
    });
  });

  it("reconciles a raw transfer rejection into canonical committed deltas", async () => {
    const unchanged = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 2, slots: [
      slot(0, "menu", 0, "minecraft:coal", 2),
      slot(36, "player", 0, null, 0),
    ] });
    const calls: RawMenuCalls = {
      inspectGui: vi.fn()
        .mockResolvedValueOnce({ ok: true, message: "before", data: { ...unchanged, menu_revision: 1 } })
        .mockResolvedValueOnce({ ok: true, message: "reconciled", data: unchanged })
        .mockResolvedValueOnce({ ok: true, message: "reconciled again", data: unchanged }),
      transfer: vi.fn()
        .mockResolvedValueOnce({
          ok: false, error: "RUNTIME_FAILED", message: "open Menu changed since inspect_gui", data: {},
        })
        .mockResolvedValueOnce({
          ok: false, error: "RUNTIME_FAILED", message: "open Menu changed since inspect_gui", data: {},
        }),
    };

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal",
      count: 2,
      source: "menu_storage",
      target: "player_inventory",
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "open Menu changed since inspect_gui",
      data: {
        item_id: "minecraft:coal",
        requested_count: 2,
        source_delta: 0,
        target_delta: 0,
      },
    });
  });

  it("retries one no-delta Menu revision rejection from fresh evidence", async () => {
    const before = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 1, slots: [
      slot(0, "menu", 0, "minecraft:coal", 2),
      slot(36, "player", 0, null, 0),
    ] });
    const refreshed = { ...before, menu_revision: 2 };
    const after = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 3, slots: [
      slot(0, "menu", 0, null, 0),
      slot(36, "player", 0, "minecraft:coal", 2),
    ] });
    const receipt = {
      menu_id: 0, before_revision: 2, after_revision: 3,
      moves: [{
        from: 0, to: 36, item_id: "minecraft:coal",
        requested_count: 2, moved_count: 2, outcome: "moved",
      }],
    };
    const calls: RawMenuCalls = {
      inspectGui: vi.fn()
        .mockResolvedValueOnce({ ok: true, message: "before", data: before })
        .mockResolvedValueOnce({ ok: true, message: "refreshed", data: refreshed })
        .mockResolvedValueOnce({ ok: true, message: "after", data: after }),
      transfer: vi.fn()
        .mockResolvedValueOnce({
          ok: false, error: "RUNTIME_FAILED", message: "open Menu changed since inspect_gui", data: {},
        })
        .mockResolvedValueOnce({ ok: true, message: "moved", data: receipt }),
    };

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal",
      count: 2,
      source: "menu_storage",
      target: "player_inventory",
    })).resolves.toMatchObject({ ok: true, data: { item_id: "minecraft:coal", count: 2 } });
    expect(calls.inspectGui).toHaveBeenCalledTimes(3);
    expect(calls.transfer).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["rejected move", { moved_count: 0, outcome: "rejected" }],
    ["no-op move", { moved_count: 0, outcome: "no_op" }],
    ["partial move", { outcome: "partial" }],
    ["wrong item", { item_id: "minecraft:charcoal" }],
    ["wrong requested count", { requested_count: 2 }],
  ] as const)("does not infer fuel-transfer success from burning after a %s receipt", async (
    _label, receiptOverride,
  ) => {
    const calls = immediateFuelCalls(receiptOverride);

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal", count: 1,
      source: "player_inventory", target: "menu_fuel",
    })).resolves.toMatchObject({ ok: false, error: "RUNTIME_FAILED" });
  });

  it("rejects an immediate-consumption receipt when the Menu identity or revision changed", async () => {
    const calls = immediateFuelCalls({}, { menu_id: 5, menu_revision: 1 });

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal", count: 1,
      source: "player_inventory", target: "menu_fuel",
    })).resolves.toMatchObject({ ok: false, error: "RUNTIME_FAILED" });
  });

  it("respects the incoming item's maximum stack size when planning targets", async () => {
    const before = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 1, slots: [
      slot(0, "menu", 0, "minecraft:ender_pearl", 15, false, 16),
      slot(1, "menu", 1, null, 0, false, 64),
      slot(36, "player", 0, "minecraft:ender_pearl", 2, false, 16),
    ] });
    const after = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 2, slots: [
      slot(0, "menu", 0, "minecraft:ender_pearl", 16, false, 16),
      slot(1, "menu", 1, "minecraft:ender_pearl", 1, false, 16),
      slot(36, "player", 0, null, 0, false, 64),
    ] });
    const receipt = {
      menu_id: 0, before_revision: 1, after_revision: 2,
      moves: [
        { from: 36, to: 0, item_id: "minecraft:ender_pearl", requested_count: 1, moved_count: 1, outcome: "moved" },
        { from: 36, to: 1, item_id: "minecraft:ender_pearl", requested_count: 1, moved_count: 1, outcome: "moved" },
      ],
    };
    const calls = rawCalls([before, receipt, after]);

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:ender_pearl",
      count: 2,
      source: "player_inventory",
      target: "menu_storage",
    })).resolves.toMatchObject({ ok: true, data: { count: 2 } });
    expect(calls.transfer.mock.calls[0]![0]).toEqual({
      menu_id: 0,
      menu_revision: 1,
      moves: [
        { from: 36, to: 0, count: 1 },
        { from: 36, to: 1, count: 1 },
      ],
    });
  });

  it.each([
    ["menu_input", gui({ menu_type: "minecraft:generic_9x3", slots: [slot(0, "menu", 0, null, 0)] })],
    ["menu_storage", gui({ menu_type: "minecraft:furnace", slots: [slot(0, "menu", 0, null, 0)] })],
  ] as const)("rejects semantic location %s when the current Menu does not expose it", async (target, snapshot) => {
    const calls = rawCalls([snapshot]);

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:stone",
      count: 1,
      source: "player_inventory",
      target,
    })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      message: expect.stringContaining(`location ${target} is unavailable`),
    });
    expect(calls.inspectGui).toHaveBeenCalledTimes(1);
    expect(calls.transfer).not.toHaveBeenCalled();
  });

  it("rejects a semantic transfer whose source equals its target", async () => {
    const calls = rawCalls([]);

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:stone",
      count: 1,
      source: "player_inventory",
      target: "player_inventory",
    })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "source and target must differ",
    });
  });

  it("rejects transfers into the read-only menu_output location before any Runtime call", async () => {
    const before = gui({ menu_type: "minecraft:furnace", slots: [
      slot(36, "player", 0, "minecraft:coal", 2),
    ] });
    const calls = rawCalls([before]);

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal",
      count: 1,
      source: "player_inventory",
      target: "menu_output",
    })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      message: expect.stringContaining("menu_output is read-only"),
    });
    expect(calls.transfer).not.toHaveBeenCalled();
  });

  it("rejects a transfer whose source holds fewer items than requested", async () => {
    const before = gui({ menu_type: "minecraft:generic_9x3", slots: [
      slot(0, "menu", 0, "minecraft:coal", 2),
      slot(36, "player", 0, null, 0),
    ] });
    const calls = rawCalls([before]);

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal",
      count: 3,
      source: "menu_storage",
      target: "player_inventory",
    })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      data: {
        item_id: "minecraft:coal",
        requested_count: 3,
        available_count: 2,
      },
    });
    expect(calls.transfer).not.toHaveBeenCalled();
  });

  it("rejects a transfer whose target lacks capacity and a transfer when the cursor is occupied", async () => {
    const full = gui({ menu_type: "minecraft:generic_9x3", slots: [
      slot(0, "menu", 0, "minecraft:stone", 64),
      slot(36, "player", 0, "minecraft:stone", 64),
    ] });
    const occupiedCursor = gui({ menu_type: "minecraft:generic_9x3", cursor: { item_id: "minecraft:dirt", count: 1 }, slots: [
      slot(0, "menu", 0, null, 0),
      slot(36, "player", 0, "minecraft:stone", 64),
    ] });

    await expect(new SemanticMenuTranslation(rawCalls([full])).transferItem({
      item_id: "minecraft:stone", count: 1, source: "player_inventory", target: "menu_storage",
    })).resolves.toMatchObject({ ok: false, error: "RUNTIME_FAILED", message: expect.stringContaining("capacity") });
    await expect(new SemanticMenuTranslation(rawCalls([occupiedCursor])).transferItem({
      item_id: "minecraft:stone", count: 1, source: "player_inventory", target: "menu_storage",
    })).resolves.toMatchObject({ ok: false, error: "RUNTIME_FAILED", message: expect.stringContaining("cursor") });
  });

  it("rejects a settled transfer whose deltas do not prove the requested count", async () => {
    const before = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 1, slots: [
      slot(0, "menu", 0, null, 0),
      slot(36, "player", 0, "minecraft:coal", 2),
    ] });
    const after = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 2, slots: [
      slot(0, "menu", 0, "minecraft:coal", 1),
      slot(36, "player", 0, "minecraft:coal", 1),
    ] });
    const receipt = {
      menu_id: 0, before_revision: 1, after_revision: 2,
      moves: [{
        from: 36, to: 0, item_id: "minecraft:coal",
        requested_count: 2, moved_count: 2, outcome: "moved",
      }],
    };
    const calls = rawCalls([before, receipt, after]);

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal",
      count: 2,
      source: "player_inventory",
      target: "menu_storage",
    })).resolves.toMatchObject({
      ok: false,
      error: "RUNTIME_FAILED",
      message: expect.stringContaining("did not settle the exact requested count"),
      data: { item_id: "minecraft:coal", requested_count: 2, source_delta: 1, target_delta: 1 },
    });
  });

  it("returns the raw rejection with canonical zero deltas after the second no-delta retry", async () => {
    const before = gui({ menu_type: "minecraft:generic_9x3", menu_revision: 1, slots: [
      slot(0, "menu", 0, "minecraft:coal", 2),
      slot(36, "player", 0, null, 0),
    ] });
    const unchanged = { ...before, menu_revision: 2 };
    const calls: RawMenuCalls = {
      inspectGui: vi.fn()
        .mockResolvedValueOnce({ ok: true, message: "before", data: before })
        .mockResolvedValueOnce({ ok: true, message: "reconciled", data: unchanged })
        .mockResolvedValueOnce({ ok: true, message: "reconciled again", data: { ...unchanged, menu_revision: 3 } }),
      transfer: vi.fn()
        .mockResolvedValue({ ok: false, error: "RUNTIME_FAILED", message: "open Menu changed since inspect_gui", data: {} }),
    };

    await expect(new SemanticMenuTranslation(calls).transferItem({
      item_id: "minecraft:coal",
      count: 2,
      source: "menu_storage",
      target: "player_inventory",
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "open Menu changed since inspect_gui",
      data: { item_id: "minecraft:coal", requested_count: 2, source_delta: 0, target_delta: 0 },
    });
    expect(calls.transfer).toHaveBeenCalledTimes(2);
  });
});

function gui(overrides: Readonly<Record<string, unknown>> = {}) {
  const snapshot = {
    menu_type: null as string | null,
    menu_id: 0,
    menu_revision: 0,
    own_inventory: false,
    slots: [],
    cursor: { item_id: null, count: 0 },
    data_values: [],
    ...overrides,
  };
  // The Runtime labels each slot; a furnace's three menu slots are input, fuel and output in that order.
  const furnace = snapshot.menu_type === "minecraft:furnace";
  return {
    ...snapshot,
    slots: (snapshot.slots as ReturnType<typeof slot>[]).map((entry) => ({
      ...entry,
      role: entry.owner === "player" ? "inventory"
        : furnace ? ["input", "fuel", "output"][entry.container_slot] ?? "container" : "container",
    })),
  };
}

function slot(
  index: number,
  owner: "player" | "menu",
  container_slot: number,
  item_id: string | null,
  count: number,
  output = false,
  max_stack_size = 64,
) {
  return { index, owner, container_slot, item_id, count, output, max_stack_size };
}

function rawCalls(results: ReadonlyArray<unknown>): RawMenuCalls & { transfer: ReturnType<typeof vi.fn> } {
  const queue = [...results];
  const next = async (kind: string, args?: Record<string, unknown>) => {
    const value = queue.shift();
    if (value === undefined) throw new Error(`unexpected extra ${kind} call: ${JSON.stringify(args ?? {})}`);
    if (value !== null && typeof value === "object" && "ok" in (value as Record<string, unknown>)) {
      return value as never;
    }
    return { ok: true, message: kind, data: value } as never;
  };
  return {
    inspectGui: vi.fn(async () => await next("inspectGui")),
    transfer: vi.fn(async (args: Record<string, unknown>) => await next("transfer", args)),
  };
}

function immediateFuelCalls(
  receiptOverride: Readonly<Record<string, unknown>> = {},
  afterOverride: Readonly<Record<string, unknown>> = {},
): RawMenuCalls {
  const before = gui({ menu_type: "minecraft:furnace", menu_id: 4, menu_revision: 12, slots: [
    slot(1, "menu", 1, null, 0),
    slot(36, "player", 0, "minecraft:coal", 2),
  ] });
  const after = gui({
    menu_type: "minecraft:furnace", menu_id: 4, menu_revision: 14,
    data_values: [1600, 1600, 1, 200],
    slots: [
      slot(1, "menu", 1, null, 0),
      slot(36, "player", 0, "minecraft:coal", 1),
    ],
    ...afterOverride,
  });
  const receipt = {
    menu_id: 4, before_revision: 12, after_revision: 13,
    moves: [{
      from: 36, to: 1, item_id: "minecraft:coal",
      requested_count: 1, moved_count: 1, outcome: "moved",
      ...receiptOverride,
    }],
  };
  return rawCalls([before, receipt, after]);
}
