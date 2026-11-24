import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { menuLocation, observedItemCountSchema, toolEmpty } from "../shared/schemas.js";
import { semanticTool } from "../shared/runtime.js";
const menuData = s.oneOf(
  s.branch(s.object({
    menu_type: s.field(s.literal("none"), { description: "No Block Menu is open." }),
  }), { title: "No Menu", description: "The Bot currently has no Block Menu open." }),
  s.branch(s.object({
    menu_type: s.field(s.literal("unsupported"), { description: "The open Menu has no semantic contract." }),
  }), { title: "Unsupported Menu", description: "A Menu is open but is not supported by semantic Menu Abilities." }),
  s.branch(s.object({
    menu_type: s.field(s.literal("crafting_table"), { description: "The open Menu is a crafting table." }),
    surface: s.field(s.literal("3x3"), { description: "Available crafting-grid dimensions." }),
    can_craft: s.field(s.literal(true), { description: "Whether crafting-table recipes may be requested." }),
  }), { title: "Crafting table", description: "The open Menu is a supported 3x3 crafting table." }),
  s.branch(s.object({
    menu_type: s.field(s.literal("furnace"), { description: "The open Menu is an ordinary furnace." }),
    input: s.field(s.nullable(observedItemCountSchema), { description: "Current semantic furnace input stack, or null." }),
    fuel: s.field(s.nullable(observedItemCountSchema), { description: "Current semantic furnace fuel stack, or null." }),
    output: s.field(s.nullable(observedItemCountSchema), { description: "Current semantic furnace output stack, or null." }),
    burning: s.field(s.boolean(), { description: "Whether the furnace is currently burning fuel." }),
    burn_remaining_seconds: s.field(s.number(), { description: "Estimated remaining burn time in seconds." }),
    cook_progress_seconds: s.field(s.number(), { description: "Current recipe cook progress in seconds." }),
    cook_total_seconds: s.field(s.number(), { description: "Total cook duration for the active recipe in seconds." }),
    locations: s.field(s.array(menuLocation), { description: "Semantic locations accepted by Menu actions." }),
  }), { title: "Furnace", description: "The open Menu is a supported ordinary furnace." }),
  s.branch(s.object({
    menu_type: s.field(s.literal("storage"), { description: "The open Menu is semantic storage." }),
    contents: s.field(s.array(observedItemCountSchema), { description: "Aggregated verified storage contents." }),
    total_slots: s.field(s.integer({ minimum: 0 }), { description: "Total storage slots." }),
    occupied_slots: s.field(s.integer({ minimum: 0 }), { description: "Occupied storage slots." }),
    empty_slots: s.field(s.integer({ minimum: 0 }), { description: "Empty storage slots." }),
    locations: s.field(s.array(menuLocation), { description: "Semantic locations accepted by Menu actions." }),
  }), { title: "Storage", description: "The open Menu is supported semantic storage." }),
);
const output = canonicalAbilityResultSchema(menuData, toolEmpty);
export const observe_menu = semanticTool({
  name: "observe_menu", description: "Observe the current Menu through semantic locations.",
  execution: "query", input: toolEmpty, output,
  invoke: async (semantic, _input, signal) => await semantic.observeMenu(signal),
});
