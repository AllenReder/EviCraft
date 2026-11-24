import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import {
  canonicalAbilityResultSchema,
  type CanonicalAbilityError,
} from "../../canonical-ability-result.js";
import { canonicalBlockId } from "../../canonical-registry-id.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import {
  blockPositionSchema,
  canonicalIdValue,
} from "../shared/schemas.js";
import {
  failure,
  interrupted,
  nearestRememberedBlocks,
  samePosition,
  WORKSTATION_DISTANCE,
} from "../shared/composites.js";

const requestedInputSchema = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical requested furnace input item id." }),
  count: s.field(s.integer({ minimum: 1, maximum: 16 }), { description: "Requested furnace input count." }),
});
const collectedOutputSchema = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical collected furnace output item id." }),
  count: s.field(s.integer({ minimum: 1 }), { description: "Verified collected furnace output count." }),
});
const progressFields = {
  requested_input: s.field(requestedInputSchema, { description: "Frozen requested furnace input." }),
  inserted_input: s.field(s.integer({ minimum: 0, maximum: 16 }), { description: "Verified input units inserted." }),
  processed_input: s.field(s.integer({ minimum: 0, maximum: 16 }), { description: "Verified input units processed." }),
  collected_output: s.field(s.nullable(collectedOutputSchema), { description: "Verified collected output, or null when none was collected." }),
  inserted_fuel: s.field(s.integer({ minimum: 0, maximum: 64 }), { description: "Verified fuel units inserted." }),
  remaining_fuel_budget: s.field(s.integer({ minimum: 0, maximum: 64 }), { description: "Caller-authorized fuel units not inserted." }),
  remaining_input: s.field(s.integer({ minimum: 0, maximum: 16 }), { description: "Verified unprocessed requested input remaining." }),
  recovered_items: s.optional(s.array(collectedOutputSchema), {
    description: "Leftover furnace input or output moved to player_inventory before this smelt began.",
  }),
} as const;
const successData = s.object({ position: s.field(blockPositionSchema, { description: "Exact furnace position used." }), ...progressFields });
const failureData = s.object({ position: s.optional(blockPositionSchema, { description: "Exact selected furnace position when available." }), ...progressFields });
const input = s.oneOf(
  s.branch(s.object({
    input_item: s.field(canonicalIdValue, { description: "Canonical input item id to smelt." }),
    count: s.field(s.integer({ minimum: 1, maximum: 16 }), { description: "Input count to smelt; when fewer are carried, every carried unit is smelted." }),
    fuel_item: s.optional(canonicalIdValue, { description: "Canonical caller-authorized fuel item id; omission selects carried coal or charcoal, then planks, logs, or sticks." }),
    fuel_count: s.optional(s.integer({ minimum: 1, maximum: 64 }), { description: "Maximum fuel units authorized for transfer; omission authorizes the carried supply, still inserted one unit at a time only while the furnace needs fuel." }),
    position: s.field(blockPositionSchema, { description: "Exact known ordinary furnace position." }),
  }), { title: "Exact furnace", description: "Operate one exact evidence-backed ordinary furnace." }),
  s.branch(s.object({
    input_item: s.field(canonicalIdValue, { description: "Canonical input item id to smelt." }),
    count: s.field(s.integer({ minimum: 1, maximum: 16 }), { description: "Input count to smelt; when fewer are carried, every carried unit is smelted." }),
    fuel_item: s.optional(canonicalIdValue, { description: "Canonical caller-authorized fuel item id; omission selects carried coal or charcoal, then planks, logs, or sticks." }),
    fuel_count: s.optional(s.integer({ minimum: 1, maximum: 64 }), { description: "Maximum fuel units authorized for transfer; omission authorizes the carried supply, still inserted one unit at a time only while the furnace needs fuel." }),
    distance: s.optional(s.integer({ minimum: 1, maximum: 64 }), { description: "Maximum candidate distance; omission uses 32.", default: WORKSTATION_DISTANCE }),
  }), { title: "Nearby remembered furnace", description: "Select a clean ordinary remembered furnace within a bounded distance." }),
);
const output = canonicalAbilityResultSchema(successData, failureData);
type BlockPosition = InferToolSchema<typeof blockPositionSchema>;
type ObserveMenuResult = Awaited<ReturnType<ProjectAbilityNamespace["observe_menu"]>>;
type ObserveMenuData = Extract<ObserveMenuResult, { ok: true }>["data"];
type FurnaceMenu = Extract<ObserveMenuData, { menu_type: "furnace" }>;
type MenuItem = { item_id: string; count: number };
type ObserveBlockResult = Awaited<ReturnType<ProjectAbilityNamespace["observe_block"]>>;
type ObserveBlockData = Extract<ObserveBlockResult, { ok: true }>["data"];
type CanonicalFailure = Readonly<{
  ok: false;
  error: CanonicalAbilityError;
  message: string;
  data: unknown;
}>;
type SmeltProgress = {
  position?: BlockPosition;
  requestedInput: { item_id: string; count: number };
  insertedInput: number;
  processedInput: number;
  collectedOutput: MenuItem | null;
  insertedFuel: number;
  remainingInput: number;
  recoveredItems: MenuItem[];
};

const FURNACE_ID = "minecraft:furnace";
const PROGRESS_WAIT_SECONDS = 1;
const MAX_PROGRESS_WAITS = 300;
/** Ordinary fuels the composite may choose by itself, in preference order; valuable fuels need explicit authorization. */
const AUTOMATIC_FUELS: readonly ((itemId: string) => boolean)[] = [
  (id) => id === "minecraft:coal" || id === "minecraft:charcoal",
  (id) => id.endsWith("_planks"),
  (id) => /_(log|wood|stem|hyphae)$/u.test(id),
  (id) => id === "minecraft:stick",
];

export const smelt_at_furnace: CompositeAbilityDefinition<
  "smelt_at_furnace",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "smelt_at_furnace",
  description: "Smelt 1-16 input items (every carried unit when fewer are carried) in one ordinary minecraft:furnace, first moving any leftover input or output into the inventory, then using existing fuel before transferring up to the authorized fuel count one unit at a time. Omit fuel_item to let it choose carried coal/charcoal, planks, logs, or sticks, and omit fuel_count to authorize the carried supply. Success collects actual output and closes the Menu, while ordinary failure attempts input/output recovery and leaves furnace fuel in place.",
  concurrency: "safe",
  input,
  output,
  async execute(input, { abilities, signal }) {
    const progress: SmeltProgress = {
      ...( "position" in input ? { position: input.position } : {}),
      requestedInput: { item_id: input.input_item, count: input.count },
      insertedInput: 0,
      processedInput: 0,
      collectedOutput: null,
      insertedFuel: 0,
      remainingInput: 0,
      recoveredItems: [],
    };
    let fuelItem = input.fuel_item;
    let fuelBudget = input.fuel_count ?? 0;
    if (fuelItem === undefined || input.fuel_count === undefined) {
      const inventory = await abilities.observe_inventory({});
      if (!inventory.ok) return { ok: false as const, error: inventory.error, message: inventory.message, data: progressData(progress, 0) };
      if (signal.aborted) return interrupted(progressData(progress, 0));
      const selected = selectFuel(inventory.data.items, fuelItem);
      fuelItem = selected?.item_id;
      fuelBudget = input.fuel_count ?? selected?.count ?? 0;
    }
    const canceled = () => interrupted(progressData(progress, fuelBudget));
    const closeAfterFailure = async (failed: CanonicalFailure) => {
      if (signal.aborted) return canceled();
      if (progress.insertedInput > 0) {
        const observed = await abilities.observe_menu({});
        if (signal.aborted) return canceled();
        if (observed.ok) {
          const cleanupMenu = furnaceMenu(observed.data);
          if (cleanupMenu !== undefined) {
            reconcileInput(progress, cleanupMenu);
            if (cleanupMenu.output !== null) {
              const recoveredOutput = await abilities.transfer_item({
                item_id: cleanupMenu.output.item_id,
                count: cleanupMenu.output.count,
                source: "menu_output",
                target: "player_inventory",
              });
              if (recoveredOutput.ok) addCollectedOutput(progress, cleanupMenu.output);
              if (signal.aborted) return canceled();
            }
            if (cleanupMenu.input?.item_id === input.input_item && cleanupMenu.input.count > 0) {
              const recoveredInput = await abilities.transfer_item({
                item_id: input.input_item,
                count: cleanupMenu.input.count,
                source: "menu_input",
                target: "player_inventory",
              });
              if (recoveredInput.ok) progress.remainingInput = 0;
              if (signal.aborted) return canceled();
            }
          }
        }
      }
      const closed = await abilities.close_menu({});
      if (signal.aborted) return canceled();
      return {
        ok: false as const,
        error: closed.ok ? failed.error : closed.error,
        message: closed.ok ? failed.message : closed.message,
        data: progressData(progress, fuelBudget),
      };
    };

    const distanceMode = !("position" in input);
    let candidates: BlockPosition[];
    if (!distanceMode) {
      candidates = [input.position];
    } else {
      const observedSelf = await abilities.observe_self({});
      if (!observedSelf.ok) return await closeAfterFailure(observedSelf);
      if (signal.aborted) return canceled();
      const start = observedSelf.data.feet;
      const found = await abilities.find_known_blocks({ block_id_glob: FURNACE_ID });
      if (!found.ok) return await closeAfterFailure(found);
      if (signal.aborted) return canceled();
      candidates = nearestRememberedBlocks(found.data.matches, FURNACE_ID, start,
        input.distance ?? WORKSTATION_DISTANCE);
    }
    if (candidates.length === 0) {
      return failure("no usable remembered ordinary furnace was selected", {
        ...progressData(progress, fuelBudget),
      });
    }

    /** Move leftover output and input into the inventory; undefined keeps the furnace occupied. */
    const takeOverResidue = async (occupied: FurnaceMenu): Promise<FurnaceMenu | "canceled" | undefined> => {
      for (const [slot, stack] of [["menu_output", occupied.output], ["menu_input", occupied.input]] as const) {
        if (stack === null) continue;
        const moved = await abilities.transfer_item({
          item_id: stack.item_id, count: stack.count, source: slot, target: "player_inventory",
        });
        if (moved.ok) progress.recoveredItems.push({ item_id: stack.item_id, count: stack.count });
        if (signal.aborted) return "canceled";
        if (!moved.ok) return undefined;
      }
      const observed = await abilities.observe_menu({});
      if (signal.aborted) return "canceled";
      return observed.ok ? furnaceMenu(observed.data) : undefined;
    };

    const occupiedCandidate = Symbol("occupied furnace candidate");
    const operateCandidate = async (position: BlockPosition) => {
      const observedBlock = await abilities.observe_block(position);
      if (!observedBlock.ok) return await closeAfterFailure(observedBlock);
      if (signal.aborted) return canceled();
      if (!isOrdinaryFurnace(observedBlock.data, position)) {
        return await closeAfterFailure(failure("target is not a known ordinary minecraft:furnace", {}));
      }

      const activated = await abilities.goto_and_activate_block({ position });
      if (!activated.ok) return await closeAfterFailure(activated);
      if (signal.aborted) return canceled();
      const opened = await abilities.observe_menu({});
      if (!opened.ok) return await closeAfterFailure(opened);
      if (signal.aborted) return canceled();
      let menu = furnaceMenu(opened.data);
      if (menu === undefined) {
        return await closeAfterFailure(failure("target did not expose an ordinary furnace Menu", {}));
      }
      if (menu.input !== null || menu.output !== null) {
        const emptied = await takeOverResidue(menu);
        if (emptied === "canceled") return canceled();
        if (emptied !== undefined) menu = emptied;
      }
      if (menu.input !== null || menu.output !== null) {
        if (!distanceMode) {
          return await closeAfterFailure(failure("exact furnace input or output is occupied", {}));
        }
        const closed = await abilities.close_menu({});
        if (!closed.ok) return {
          ok: false as const, error: closed.error, message: closed.message,
          data: progressData(progress, fuelBudget),
        };
        if (signal.aborted) return canceled();
        return occupiedCandidate;
      }

      let loadCount = input.count;
      let loaded = await abilities.transfer_item({
        item_id: input.input_item,
        count: loadCount,
        source: "player_inventory",
        target: "menu_input",
      });
      const carried = availableCount(loaded);
      if (!loaded.ok && carried !== undefined && carried > 0 && carried < loadCount && !signal.aborted) {
        loadCount = carried;
        loaded = await abilities.transfer_item({
          item_id: input.input_item,
          count: loadCount,
          source: "player_inventory",
          target: "menu_input",
        });
      }
      if (!loaded.ok) return await closeAfterFailure(loaded);
      progress.insertedInput = loadCount;
      progress.remainingInput = loadCount;
      if (signal.aborted) return canceled();

      const afterLoad = await abilities.observe_menu({});
      if (!afterLoad.ok) return await closeAfterFailure(afterLoad);
      if (signal.aborted) return canceled();
      menu = furnaceMenu(afterLoad.data);
      if (menu === undefined) {
        return await closeAfterFailure(failure("furnace Menu was lost after loading input", {}));
      }

      let progressWaits = 0;
      let idleExistingFuelObservations = 0;
      for (;;) {
        const reconciled = reconcileInput(progress, menu);
        if (!reconciled.ok) return await closeAfterFailure(reconciled);

        if (menu.output !== null) {
          const collected = await abilities.transfer_item({
            item_id: menu.output.item_id,
            count: menu.output.count,
            source: "menu_output",
            target: "player_inventory",
          });
          if (!collected.ok) return await closeAfterFailure(collected);
          addCollectedOutput(progress, menu.output);
          if (signal.aborted) return canceled();
          const afterCollection = await abilities.observe_menu({});
          if (!afterCollection.ok) return await closeAfterFailure(afterCollection);
          if (signal.aborted) return canceled();
          menu = furnaceMenu(afterCollection.data);
          if (menu === undefined) {
            return await closeAfterFailure(failure("furnace Menu was lost after collecting output", {}));
          }
          continue;
        }

        if (progress.remainingInput === 0) {
          if (signal.aborted) return canceled();
          const closed = await abilities.close_menu({});
          if (!closed.ok) return {
            ok: false as const, error: closed.error, message: closed.message,
            data: progressData(progress, fuelBudget),
          };
          if (signal.aborted) return canceled();
          return {
            ok: true as const,
            message: "smelted requested furnace input",
            data: { position, ...progressData(progress, fuelBudget) },
          };
        }

        if (!menu.burning && menu.fuel === null) {
          if (fuelItem === undefined) {
            return await closeAfterFailure(failure("no carried fuel was authorized or found for the furnace", {}));
          }
          if (progress.insertedFuel >= fuelBudget) {
            return await closeAfterFailure(failure("caller-authorized furnace fuel budget was exhausted", {}));
          }
          const fueled = await abilities.transfer_item({
            item_id: fuelItem,
            count: 1,
            source: "player_inventory",
            target: "menu_fuel",
          });
          if (!fueled.ok) return await closeAfterFailure(fueled);
          progress.insertedFuel += 1;
          idleExistingFuelObservations = 0;
          if (signal.aborted) return canceled();
          const afterFuel = await abilities.observe_menu({});
          if (!afterFuel.ok) return await closeAfterFailure(afterFuel);
          if (signal.aborted) return canceled();
          menu = furnaceMenu(afterFuel.data);
          if (menu === undefined) {
            return await closeAfterFailure(failure("furnace Menu was lost after loading fuel", {}));
          }
          continue;
        }

        if (!menu.burning) {
          if (idleExistingFuelObservations >= 1) {
            return await closeAfterFailure(failure("existing furnace fuel did not begin burning", {}));
          }
          idleExistingFuelObservations += 1;
        } else {
          idleExistingFuelObservations = 0;
        }
        if (progressWaits >= MAX_PROGRESS_WAITS) {
          return await closeAfterFailure(failure("furnace progress wait bound was exhausted", {}));
        }
        progressWaits += 1;
        const waited = await abilities.wait({ seconds: PROGRESS_WAIT_SECONDS });
        if (!waited.ok) return await closeAfterFailure(waited);
        if (signal.aborted) return canceled();
        const observed = await abilities.observe_menu({});
        if (!observed.ok) return await closeAfterFailure(observed);
        if (signal.aborted) return canceled();
        menu = furnaceMenu(observed.data);
        if (menu === undefined) {
          return await closeAfterFailure(failure("furnace Menu was lost while waiting for progress", {}));
        }
      }
    };

    for (const position of candidates) {
      progress.position = position;
      const attempted = await operateCandidate(position);
      if (attempted !== occupiedCandidate) return attempted;
    }
    return failure("all remembered ordinary furnace candidates were occupied", {
      ...progressData(progress, fuelBudget),
    });
  },
});

function selectFuel(items: readonly MenuItem[], requested: string | undefined): MenuItem | undefined {
  const itemId = requested
    ?? AUTOMATIC_FUELS.map((matches) => items.find(({ item_id }) => matches(item_id))?.item_id)
      .find((candidate) => candidate !== undefined);
  if (itemId === undefined) return undefined;
  const carried = items.filter((stack) => stack.item_id === itemId).reduce((total, stack) => total + stack.count, 0);
  return { item_id: itemId, count: Math.min(64, Math.max(1, carried)) };
}

function availableCount(result: { ok: boolean; data: unknown }) {
  if (result.ok || result.data === null || typeof result.data !== "object") return undefined;
  const available = (result.data as { available_count?: unknown }).available_count;
  return typeof available === "number" ? available : undefined;
}

function progressData(progress: SmeltProgress, fuelCount: number) {
  return {
    ...(progress.position === undefined ? {} : { position: progress.position }),
    requested_input: progress.requestedInput,
    inserted_input: progress.insertedInput,
    processed_input: progress.processedInput,
    collected_output: progress.collectedOutput,
    inserted_fuel: progress.insertedFuel,
    remaining_fuel_budget: fuelCount - progress.insertedFuel,
    remaining_input: progress.remainingInput,
    ...(progress.recoveredItems.length === 0 ? {} : { recovered_items: progress.recoveredItems }),
  };
}

function isOrdinaryFurnace(value: ObserveBlockData, position: BlockPosition) {
  const cell = value.cells[0];
  if (cell?.state !== "KNOWN_BLOCK") return false;
  return samePosition(cell.position, position)
    && canonicalBlockId(cell.block_state) === FURNACE_ID;
}

function furnaceMenu(value: ObserveMenuData): FurnaceMenu | undefined {
  return value.menu_type === "furnace" ? value : undefined;
}

function reconcileInput(
  progress: SmeltProgress,
  menu: FurnaceMenu,
) {
  if (menu.input !== null && menu.input.item_id !== progress.requestedInput.item_id) {
    return failure("furnace input changed to a different item", {});
  }
  const remaining = menu.input?.count ?? 0;
  if (remaining > progress.remainingInput) {
    return failure("furnace input count exceeded the committed insertion", {});
  }
  const processed = progress.remainingInput - remaining;
  progress.remainingInput = remaining;
  if (processed > 0 && menu.output === null) {
    return failure("furnace input decreased without fresh output evidence", {});
  }
  progress.processedInput += processed;
  return { ok: true as const, message: "reconciled furnace input", data: {} };
}

function addCollectedOutput(progress: SmeltProgress, collected: MenuItem) {
  if (progress.collectedOutput === null) {
    progress.collectedOutput = { ...collected };
    return;
  }
  if (progress.collectedOutput.item_id !== collected.item_id) {
    throw new Error("one smelt_at_furnace call produced multiple output item ids");
  }
  progress.collectedOutput.count += collected.count;
}


