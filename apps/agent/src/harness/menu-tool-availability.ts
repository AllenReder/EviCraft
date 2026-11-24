import type { SemanticMenuKind } from "./semantic-menu.js";
import type { TurnObservation } from "./turn-observation.js";

export type AvailableMenuKind = SemanticMenuKind;

const BODY_TOOLS = [
  "goto", "goto_block_interaction_pose", "goto_block_placement_pose", "goto_and_break_block", "goto_and_activate_block", "goto_and_place_block",
  "goto_and_use_item_on_block", "fill_bucket", "collect_blocks",
  "break_block", "activate_block", "use_item", "use_item_on_block", "place_block", "place_block_nearby", "interact_entity", "attack", "collect_items",
  "equip_item", "eat", "drop_items", "throw_eye_of_ender", "sleep_in_bed",
  "suffocation_escape",
] as const;

const COMPLETE_MENU_TOOL_NAMES = new Set([
  ...BODY_TOOLS,
  "transfer_item",
]);

/** Projects the shared Menu preconditions over one immutable registered Tool set. */
export function unavailableToolsForMenu(
  menuKind: AvailableMenuKind,
  registeredToolNames: ReadonlySet<string> = COMPLETE_MENU_TOOL_NAMES,
): TurnObservation["unavailableTools"] {
  if (menuKind === "none") {
    return registeredToolNames.has("transfer_item")
      ? [{ error: "MENU_REQUIRED", tools: ["transfer_item"] }]
      : [];
  }
  const unavailable: Array<TurnObservation["unavailableTools"][number]> = [];
  const bodyTools = BODY_TOOLS.filter((name) => registeredToolNames.has(name));
  if (bodyTools.length > 0) unavailable.push({ error: "MENU_OPEN", tools: bodyTools });
  const incompatible = menuKind === "storage" || menuKind === "furnace" ? [] : ["transfer_item"];
  const registeredIncompatible = incompatible.filter((name) => registeredToolNames.has(name));
  if (registeredIncompatible.length > 0) {
    unavailable.push({ error: "INCOMPATIBLE_MENU", tools: registeredIncompatible });
  }
  return unavailable;
}
