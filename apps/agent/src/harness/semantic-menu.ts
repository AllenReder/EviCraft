export type CanonicalRuntimeResult<Data extends Record<string, unknown> = Record<string, unknown>> =
  | Readonly<{ ok: true; message: string; data: Data }>
  | Readonly<{
      ok: false;
      error: "RUNTIME_FAILED" | "INTERRUPTED";
      message: string;
      data: Readonly<Record<string, unknown>>;
    }>;

/** The two raw Menu primitives the Semantic Menu Translation composes. */
export interface RawMenuCalls {
  inspectGui(signal?: AbortSignal): Promise<CanonicalRuntimeResult<GuiSnapshot>>;
  transfer(
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CanonicalRuntimeResult<TransferReceipt>>;
}

/** The sole authority for semantic Menu Kinds. */
export type SemanticMenuKind = "none" | "storage" | "crafting_table" | "furnace" | "unsupported";

const SEMANTIC_MENU_KINDS: ReadonlySet<string> = new Set<SemanticMenuKind>([
  "none", "storage", "crafting_table", "furnace", "unsupported",
]);

export function isSemanticMenuKind(value: unknown): value is SemanticMenuKind {
  return typeof value === "string" && SEMANTIC_MENU_KINDS.has(value);
}

export interface SemanticTransferInput {
  readonly item_id: string;
  readonly count: number;
  readonly source: SemanticMenuLocation;
  readonly target: SemanticMenuLocation;
}

export type SemanticMenuLocation =
  | "player_inventory"
  | "menu_storage"
  | "menu_input"
  | "menu_fuel"
  | "menu_output";

/** Concrete, Harness-specific semantic Menu translation over raw Runtime GUI snapshots. */
export class SemanticMenuTranslation {
  public constructor(private readonly calls: RawMenuCalls) {}

  public async observeInventory(signal?: AbortSignal): Promise<CanonicalRuntimeResult<Record<string, unknown>>> {
    const inspected = await this.calls.inspectGui(signal);
    if (!inspected.ok) return inspected;
    const items = aggregateSlots(inspected.data.slots.filter((slot) => slot.owner === "player"));
    const occupied = inspected.data.slots.filter(
      (slot) => slot.owner === "player" && slot.item_id !== null,
    ).length;
    const total = inspected.data.slots.filter((slot) => slot.owner === "player").length;
    return {
      ok: true,
      message: "semantic player inventory",
      data: {
        location: "player_inventory",
        items,
        total_slots: total,
        occupied_slots: occupied,
        empty_slots: total - occupied,
      },
    };
  }

  public async observeMenu(signal?: AbortSignal): Promise<CanonicalRuntimeResult<Record<string, unknown>>> {
    const inspected = await this.calls.inspectGui(signal);
    if (!inspected.ok) return inspected;
    return {
      ok: true,
      message: "semantic Menu projection",
      data: semanticMenu(inspected.data),
    };
  }

  public async transferItem(
    input: SemanticTransferInput,
    signal?: AbortSignal,
  ): Promise<CanonicalRuntimeResult<Record<string, unknown>>> {
    const { item_id: itemId, count, source, target } = input;
    if (source === target) return runtimeFailure("source and target must differ");
    const inspected = await this.calls.inspectGui(signal);
    if (!inspected.ok) return inspected;
    let before = inspected.data;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (before.cursor.item_id !== null) {
        return runtimeFailure("Runtime cursor must be empty before semantic transfer");
      }
      const availableLocations = semanticLocations(before);
      for (const location of [source, target]) {
        if (!availableLocations.has(location)) {
          return runtimeFailure(`semantic location ${location} is unavailable for the current Menu`);
        }
      }
      if (target === "menu_output") {
        return runtimeFailure("semantic location menu_output is read-only");
      }
      const sources = slotsForLocation(before, source)
        .filter((slot) => slot.item_id === itemId && slot.count > 0);
      const available = sources.reduce((total, slot) => total + slot.count, 0);
      if (available < count) {
        return runtimeFailure(`source contains ${available}, fewer than requested ${count}`, {
          item_id: itemId, requested_count: count, available_count: available,
        });
      }
      const itemMaxStackSize = Math.min(...sources.map((slot) => slot.max_stack_size));
      const targets = slotsForLocation(before, target)
        .filter((slot) => slot.item_id === null || slot.item_id === itemId);
      const capacity = targets.reduce(
        (total, slot) => total + Math.max(
          0, Math.min(slot.max_stack_size, itemMaxStackSize) - slot.count,
        ),
        0,
      );
      if (capacity < count) {
        return runtimeFailure(`target has capacity ${capacity}, fewer than requested ${count}`);
      }
      const moves: Array<{ from: number; to: number; count: number }> = [];
      let remaining = count;
      for (const sourceSlot of sources) {
        let sourceRemaining = Math.min(sourceSlot.count, remaining);
        for (const targetSlot of targets) {
          if (sourceRemaining === 0) break;
          const alreadyPlanned = moves
            .filter((move) => move.to === targetSlot.index)
            .reduce((total, move) => total + move.count, 0);
          const room = Math.min(targetSlot.max_stack_size, itemMaxStackSize)
            - targetSlot.count - alreadyPlanned;
          if (room <= 0) continue;
          const moved = Math.min(sourceRemaining, room);
          moves.push({ from: sourceSlot.index, to: targetSlot.index, count: moved });
          sourceRemaining -= moved;
          remaining -= moved;
        }
        if (remaining === 0) break;
      }
      const transferred = await this.calls.transfer({
        menu_id: before.menu_id,
        menu_revision: before.menu_revision,
        moves,
      }, signal);
      if (!transferred.ok) {
        const reconciled = await this.calls.inspectGui(signal);
        if (!reconciled.ok) {
          return { ok: false, error: transferred.error, message: transferred.message, data: {} };
        }
        const comparable = reconciled.data.menu_id === before.menu_id
          && semanticLocations(reconciled.data).has(source)
          && semanticLocations(reconciled.data).has(target);
        const sourceDelta = comparable
          ? itemCount(slotsForLocation(before, source), itemId)
            - itemCount(slotsForLocation(reconciled.data, source), itemId)
          : undefined;
        const targetDelta = comparable
          ? itemCount(slotsForLocation(reconciled.data, target), itemId)
            - itemCount(slotsForLocation(before, target), itemId)
          : undefined;
        if (attempt === 0 && transferred.error === "RUNTIME_FAILED"
            && sourceDelta === 0 && targetDelta === 0
            && reconciled.data.cursor.item_id === null) {
          before = reconciled.data;
          continue;
        }
        return {
          ok: false,
          error: transferred.error,
          message: transferred.message,
          data: sourceDelta === undefined || targetDelta === undefined ? {} : {
            item_id: itemId,
            requested_count: count,
            source_delta: sourceDelta,
            target_delta: targetDelta,
          },
        };
      }
      const after = await this.calls.inspectGui(signal);
      if (!after.ok) return after;
      const sourceDelta = itemCount(slotsForLocation(before, source), itemId)
        - itemCount(slotsForLocation(after.data, source), itemId);
      const targetDelta = itemCount(slotsForLocation(after.data, target), itemId)
        - itemCount(slotsForLocation(before, target), itemId);
      const exactReceipt = isExactTransferReceipt(
        transferred.data, before, after.data, moves, itemId, count,
      );
      const destinationSettled = targetDelta === count
        || (target === "menu_fuel" && targetDelta <= count && exactReceipt);
      if (sourceDelta !== count || !destinationSettled || !exactReceipt
          || after.data.cursor.item_id !== null) {
        return runtimeFailure("Runtime transfer did not settle the exact requested count", {
          item_id: itemId, requested_count: count,
          source_delta: sourceDelta, target_delta: targetDelta,
        });
      }
      return {
        ok: true,
        message: `transferred ${count} ${itemId}`,
        data: { item_id: itemId, count, source, target },
      };
    }
    return runtimeFailure("Runtime transfer retry bound was exhausted", {
      item_id: itemId, requested_count: count, source_delta: 0, target_delta: 0,
    });
  }
}

interface GuiSlot {
  readonly index: number;
  readonly owner: "player" | "menu";
  readonly role: string;
  readonly container_slot: number;
  readonly item_id: string | null;
  readonly count: number;
  readonly output: boolean;
  readonly max_stack_size: number;
}

interface GuiSnapshot extends Record<string, unknown> {
  /** Registry id of the open block menu; null for the Bot's own inventory menu. */
  readonly menu_type: string | null;
  readonly menu_id: number;
  readonly menu_revision: number;
  readonly own_inventory: boolean;
  readonly slots: GuiSlot[];
  readonly cursor: Readonly<{ item_id: string | null; count: number }>;
  readonly data_values: number[];
  readonly crafting?: Readonly<{ width: number; height: number; result_slot: number }>;
}

interface TransferReceipt extends Record<string, unknown> {
  readonly menu_id: number;
  readonly before_revision: number;
  readonly after_revision: number;
  readonly moves: readonly TransferMoveReceipt[];
}

interface TransferMoveReceipt {
  readonly from: number;
  readonly to: number;
  readonly item_id: string;
  readonly requested_count: number;
  readonly moved_count: number;
  readonly outcome: "moved" | "partial" | "rejected" | "no_op";
}

function isExactTransferReceipt(
  receipt: TransferReceipt,
  before: GuiSnapshot,
  after: GuiSnapshot,
  plannedMoves: readonly Readonly<{ from: number; to: number; count: number }>[],
  itemId: string,
  requestedCount: number,
): boolean {
  if (receipt.menu_id !== before.menu_id || after.menu_id !== receipt.menu_id
      || receipt.before_revision !== before.menu_revision
      || !Number.isInteger(receipt.after_revision)
      || receipt.after_revision <= receipt.before_revision
      || after.menu_revision < receipt.after_revision
      || !Array.isArray(receipt.moves)
      || receipt.moves.length !== plannedMoves.length) {
    return false;
  }
  let movedCount = 0;
  for (let index = 0; index < plannedMoves.length; index += 1) {
    const planned = plannedMoves[index]!;
    const actual = receipt.moves[index];
    if (actual === undefined
        || actual.from !== planned.from
        || actual.to !== planned.to
        || actual.item_id !== itemId
        || actual.requested_count !== planned.count
        || actual.moved_count !== planned.count
        || actual.outcome !== "moved") {
      return false;
    }
    movedCount += actual.moved_count;
  }
  return movedCount === requestedCount;
}

const CRAFTING_TABLE_MENU = "minecraft:crafting";
const FURNACE_MENUS: ReadonlySet<string | null> = new Set([
  "minecraft:furnace", "minecraft:blast_furnace", "minecraft:smoker",
]);

function semanticMenu(snapshot: GuiSnapshot): Record<string, unknown> {
  if (snapshot.own_inventory) return { menu_type: "none" };
  const menuSlots = snapshot.slots.filter((slot) => slot.owner === "menu");
  if (snapshot.menu_type === CRAFTING_TABLE_MENU) {
    return { menu_type: "crafting_table", surface: "3x3", can_craft: true };
  }
  if (FURNACE_MENUS.has(snapshot.menu_type)) {
    const data = snapshot.data_values;
    return {
      menu_type: "furnace",
      input: semanticItem(menuSlots.find((slot) => slot.role === "input")),
      fuel: semanticItem(menuSlots.find((slot) => slot.role === "fuel")),
      output: semanticItem(menuSlots.find((slot) => slot.role === "output")),
      burning: (data[0] ?? 0) > 0,
      burn_remaining_seconds: (data[0] ?? 0) / 20,
      cook_progress_seconds: (data[2] ?? 0) / 20,
      cook_total_seconds: (data[3] ?? 0) / 20,
      locations: ["player_inventory", "menu_input", "menu_fuel", "menu_output"],
    };
  }
  if (menuSlots.length > 0) {
    const items = aggregateSlots(menuSlots);
    const occupied = menuSlots.filter((slot) => slot.item_id !== null).length;
    return {
      menu_type: "storage",
      contents: items,
      total_slots: menuSlots.length,
      occupied_slots: occupied,
      empty_slots: menuSlots.length - occupied,
      locations: ["player_inventory", "menu_storage"],
    };
  }
  return { menu_type: "unsupported" };
}

function slotsForLocation(snapshot: GuiSnapshot, location: SemanticMenuLocation): GuiSlot[] {
  switch (location) {
    case "player_inventory": return snapshot.slots.filter((slot) => slot.owner === "player");
    case "menu_storage": return snapshot.slots.filter((slot) => slot.owner === "menu" && !slot.output);
    case "menu_input": return snapshot.slots.filter((slot) => slot.role === "input");
    case "menu_fuel": return snapshot.slots.filter((slot) => slot.role === "fuel");
    case "menu_output": return snapshot.slots.filter((slot) => slot.role === "output");
    default: return [];
  }
}

function semanticLocations(snapshot: GuiSnapshot): ReadonlySet<SemanticMenuLocation> {
  if (snapshot.own_inventory) return new Set(["player_inventory"]);
  if (FURNACE_MENUS.has(snapshot.menu_type)) {
    return new Set(["player_inventory", "menu_input", "menu_fuel", "menu_output"]);
  }
  if (snapshot.menu_type === CRAFTING_TABLE_MENU) return new Set(["player_inventory"]);
  if (snapshot.slots.some((slot) => slot.owner === "menu")) {
    return new Set(["player_inventory", "menu_storage"]);
  }
  return new Set(["player_inventory"]);
}

function aggregateSlots(slots: readonly GuiSlot[]): Array<{ item_id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const slot of slots) {
    if (slot.item_id !== null) counts.set(slot.item_id, (counts.get(slot.item_id) ?? 0) + slot.count);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([item_id, count]) => ({ item_id, count }));
}

function semanticItem(slot?: GuiSlot): { item_id: string; count: number } | null {
  return slot?.item_id === null || slot === undefined
    ? null
    : { item_id: slot.item_id, count: slot.count };
}

function itemCount(slots: readonly GuiSlot[], itemId: string): number {
  return slots.filter((slot) => slot.item_id === itemId)
    .reduce((total, slot) => total + slot.count, 0);
}

function runtimeFailure(
  message: string,
  data: Readonly<Record<string, unknown>> = {},
): CanonicalRuntimeResult<never> {
  return { ok: false, error: "RUNTIME_FAILED", message, data };
}
