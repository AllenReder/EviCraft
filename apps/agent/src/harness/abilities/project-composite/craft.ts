import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";
import {
  failureTypeOf,
  interrupted,
  nearestRememberedBlocks,
  WORKSTATION_DISTANCE,
} from "../shared/composites.js";

const TABLE_ID = "minecraft:crafting_table";
/** Remembered tables tried before falling back to placing a carried or freshly crafted one. */
const MAX_REMEMBERED_TABLES = 3;

const tableSource = s.enumeration("inventory_grid", "open_table", "remembered_table", "placed_table");
const input = s.object({
  item_id: s.field(canonicalIdValue, {
    description: "Canonical item registry identifier to craft.",
    examples: ["minecraft:iron_pickaxe"],
  }),
  count: s.optional(s.integer({ minimum: 1, maximum: 256 }), {
    description: "Desired number of new items to craft, not recipe executions or total carried items; omission requests one. Whole recipes may produce more, and limited materials may produce fewer.",
    default: 1,
    examples: [1],
  }),
  distance: s.optional(s.integer({ minimum: 1, maximum: 64 }), {
    description: "Maximum distance of a remembered crafting table to walk to before placing one instead; omission uses 32.",
    default: WORKSTATION_DISTANCE,
  }),
});
const successData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Crafted item id." }),
  crafted: s.field(s.integer({ minimum: 0 }), { description: "Verified number of requested items crafted." }),
  carrying: s.field(s.integer({ minimum: 0 }), { description: "Verified number of the item carried afterwards." }),
  table_source: s.field(tableSource, {
    description: "Crafting surface used: the 2x2 inventory grid, an already-open table, a remembered table, or one placed by this call.",
  }),
  table_position: s.optional(blockPositionSchema, { description: "Crafting table used, when one was opened by this call." }),
});
const failureData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Requested item id." }),
  step: s.field(s.enumeration("craft", "craft_table", "place_table", "open_table"), {
    description: "Step that failed: craft (the recipe itself), craft_table (no table carried and none could be crafted), place_table (no nearby cell accepted the table), or open_table (no table Menu could be opened).",
  }),
  failure_type: s.optional(s.string(), { description: "The failing child's failure_type, e.g. missing_ingredients." }),
  missing: s.optional(s.array(s.string()), { description: "For missing_ingredients: the short ingredients." }),
  table_position: s.optional(blockPositionSchema, { description: "Crafting table involved, when one was selected." }),
});
const output = canonicalAbilityResultSchema(successData, failureData);

type BlockPosition = InferToolSchema<typeof blockPositionSchema>;
type Source = InferToolSchema<typeof tableSource>;
type Failure = InferToolSchema<typeof failureData>;

export const craft: CompositeAbilityDefinition<
  "craft",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "craft",
  description: "Craft new items end to end. Uses the 2x2 inventory grid or an already-open crafting table when the recipe fits; otherwise walks to a remembered crafting table within distance, or places a carried one (crafting it from planks if needed) nearby, opens it, crafts, and closes the Menu. Another open Menu is closed first. Success can be partial: compare crafted with count. Only remembered or observed tables and cells are used.",
  concurrency: "safe",
  input: input,
  output,
  async execute({ item_id, count, distance }, { abilities, signal }) {
    const request = { item_id, ...(count === undefined ? {} : { count }) };
    const fail = (message: string, data: Omit<Failure, "item_id">) =>
      ({ ok: false as const, error: "RUNTIME_FAILED" as const, message, data: { item_id, ...data } });
    const stopped = (step: Failure["step"]) => interrupted({ item_id, step });
    const childFailure = (
      step: Failure["step"],
      result: Readonly<{ error: string; message: string; data: unknown }>,
      table_position?: BlockPosition,
    ) => result.error === "INTERRUPTED"
      ? interrupted({ item_id, step, ...(table_position === undefined ? {} : { table_position }) })
      : fail(result.message, {
        step,
        ...childFacts(result.data),
        ...(table_position === undefined ? {} : { table_position }),
      });
    const crafted = (
      result: Readonly<{ message: string; data: Readonly<{ crafted: number; carrying: number }> }>,
      table_source: Source,
      table_position?: BlockPosition,
    ) => ({
      ok: true as const,
      message: result.message,
      data: {
        item_id, crafted: result.data.crafted, carrying: result.data.carrying, table_source,
        ...(table_position === undefined ? {} : { table_position }),
      },
    });
    const craftAt = async (position: BlockPosition, source: Source) => {
      const opened = await abilities.goto_and_activate_block({ position });
      if (!opened.ok) return childFailure("open_table", opened, position);
      const shown = await abilities.observe_menu({});
      if (!shown.ok) return childFailure("open_table", shown, position);
      if (shown.data.menu_type !== "crafting_table") {
        await abilities.close_menu({});
        return fail("the activated block did not open a crafting-table Menu",
          { step: "open_table", table_position: position });
      }
      const result = await abilities.craft_on_current_surface(request);
      const closed = await abilities.close_menu({});
      if (!result.ok) return childFailure("craft", result, position);
      if (!closed.ok) return childFailure("craft", closed, position);
      return crafted(result, source, position);
    };

    // 1. The current surface: the 2x2 grid, or a crafting table the caller already opened.
    const menu = await abilities.observe_menu({});
    if (!menu.ok) return childFailure("craft", menu);
    if (signal.aborted) return stopped("craft");
    const tableOpen = menu.data.menu_type === "crafting_table";
    if (!tableOpen && menu.data.menu_type !== "none") {
      const closed = await abilities.close_menu({});
      if (!closed.ok) return childFailure("craft", closed);
    }
    const direct = await abilities.craft_on_current_surface(request);
    if (direct.ok) return crafted(direct, tableOpen ? "open_table" : "inventory_grid");
    if (direct.error === "INTERRUPTED" || tableOpen
      || failureTypeOf(direct.data) !== "needs_crafting_table") {
      return childFailure("craft", direct);
    }
    if (signal.aborted) return stopped("open_table");

    // 2. A remembered table within distance, nearest first.
    const self = await abilities.observe_self({});
    if (!self.ok) return childFailure("open_table", self);
    const known = await abilities.find_known_blocks({ block_id_glob: TABLE_ID });
    if (!known.ok) return childFailure("open_table", known);
    const remembered = nearestRememberedBlocks(known.data.matches, TABLE_ID, self.data.feet,
      distance ?? WORKSTATION_DISTANCE).slice(0, MAX_REMEMBERED_TABLES);
    let lastOpenFailure: Awaited<ReturnType<typeof craftAt>> | undefined;
    for (const position of remembered) {
      if (signal.aborted) return stopped("open_table");
      const outcome = await craftAt(position, "remembered_table");
      if (outcome.ok || outcome.error === "INTERRUPTED" || outcome.data.step !== "open_table") {
        return outcome;
      }
      lastOpenFailure = outcome;
    }

    // 3. Place a carried table, crafting one from planks first when none is carried.
    const inventory = await abilities.observe_inventory({});
    if (!inventory.ok) return childFailure("craft_table", inventory);
    if (!inventory.data.items.some((item) => item.item_id === TABLE_ID && item.count > 0)) {
      const table = await abilities.craft_on_current_surface({ item_id: TABLE_ID });
      if (!table.ok) return lastOpenFailure ?? childFailure("craft_table", table);
    }
    if (signal.aborted) return stopped("place_table");
    const placed = await abilities.place_block_nearby({ item_id: TABLE_ID });
    if (!placed.ok) return childFailure("place_table", placed);
    if (signal.aborted) return stopped("open_table");
    return await craftAt(placed.data.successful_position, "placed_table");
  },
});

/** The child's failure_type and missing ingredients, when it reported them. */
function childFacts(data: unknown): { failure_type?: string; missing?: string[] } {
  const failureType = failureTypeOf(data);
  if (failureType === undefined) return {};
  const missing = (data as { missing?: unknown }).missing;
  return {
    failure_type: failureType,
    ...(Array.isArray(missing) && missing.every((entry) => typeof entry === "string")
      ? { missing: missing as string[] } : {}),
  };
}
