import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { defineAbility } from "../../ability-runtime.js";
import { toolSchema as s } from "../../tool-schema.js";
import { consumableStackSchema, observedItemCountSchema, toolEmpty } from "../shared/schemas.js";
import { requiredRuntime } from "../shared/runtime.js";
const output = canonicalAbilityResultSchema(s.object({
  location: s.field(s.literal("player_inventory"), { description: "Semantic Inventory location represented by this result." }),
  items: s.field(s.array(observedItemCountSchema), { description: "Aggregated verified item counts without raw slot indices." }),
  consumables: s.field(s.array(consumableStackSchema), { description: "Current food and drink stacks with exact Inventory slots, distinguishing potion variants." }),
  total_slots: s.field(s.integer({ minimum: 0 }), { description: "Total semantic Inventory slots." }),
  occupied_slots: s.field(s.integer({ minimum: 0 }), { description: "Occupied semantic Inventory slots." }),
  empty_slots: s.field(s.integer({ minimum: 0 }), { description: "Empty semantic Inventory slots." }),
}), toolEmpty);
export const observe_inventory = defineAbility({
  name: "observe_inventory", description: "Observe aggregate player_inventory counts and selectable food/drink slots with potion variants.",
  concurrency: "safe", execution: "query", input: toolEmpty, output,
  async execute(_input, context) {
    const runtime = requiredRuntime(context);
    const inventory = await runtime.semantic.observeInventory(context.signal);
    if (!inventory.ok) return output.parse(inventory, "observe_inventory result");
    const status = await runtime.call<{ raw_inventory: Array<{
      slot: number; item: string; count: number; consumable?: boolean; potion?: unknown;
    }> }>("get_self_status", {}, context.signal);
    if (!status.ok) return output.parse(status, "observe_inventory body result");
    const consumables = status.data.raw_inventory.filter((stack) => stack.consumable === true)
      .map(({ slot, item, count, potion }) => ({ slot, item_id: item, count,
        ...(potion === undefined ? {} : { potion }),
      }));
    return output.parse({ ...inventory, data: { ...inventory.data, consumables } }, "observe_inventory result");
  },
});
