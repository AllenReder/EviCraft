import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { canonicalIdValue, menuLocation, toolEmpty } from "../shared/schemas.js";
import { semanticTool } from "../shared/runtime.js";
const transferData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical item id moved between semantic locations." }),
  count: s.field(s.integer({ minimum: 1 }), { description: "Verified number of items moved." }),
  source: s.field(menuLocation, { description: "Semantic source location debited by the move." }),
  target: s.field(menuLocation, { description: "Semantic target location credited by the move." }),
});
const transferFailureData = s.oneOf(
  s.branch(toolEmpty, { title: "No verified transfer progress", description: "No transfer facts were verified." }),
  s.branch(s.object({
    item_id: s.field(canonicalIdValue, { description: "Canonical item id requested for transfer." }),
    requested_count: s.field(s.integer({ minimum: 1 }), { description: "Number of items requested by the caller." }),
    available_count: s.field(s.integer({ minimum: 0 }), { description: "Verified number available at the source." }),
  }), { title: "Insufficient source items", description: "The source contained fewer items than requested." }),
  s.branch(s.object({
    item_id: s.field(canonicalIdValue, { description: "Canonical item id requested for transfer." }),
    requested_count: s.field(s.integer({ minimum: 1 }), { description: "Number of items requested by the caller." }),
    source_delta: s.field(s.integer(), { description: "Verified signed source count change." }),
    target_delta: s.field(s.integer(), { description: "Verified signed target count change." }),
  }), { title: "Transfer verification mismatch", description: "Observed source and target deltas did not prove the requested move." }),
);
const output = canonicalAbilityResultSchema(transferData, transferFailureData);
export const transfer_item = semanticTool({
  name: "transfer_item", description: "Move an exact item count between player inventory and an already-open menu. Success verifies the exact move, including fuel consumed immediately by a furnace. Failure may report source_delta and target_delta; refresh inventory/menu evidence before retrying.", execution: "body",
  input: s.object({
    item_id: s.field(canonicalIdValue, {
      description: "Canonical item id to move between semantic locations.",
      examples: ["minecraft:iron_ore"],
    }),
    count: s.field(s.integer({ minimum: 1 }), { description: "Exact positive item count to move." }),
    source: s.field(menuLocation, { description: "Semantic Inventory or Menu location to debit." }),
    target: s.field(menuLocation, { description: "Different semantic Inventory or Menu location to credit." }),
  }),
  output,
  invoke: async (semantic, input, signal) => await semantic.transferItem(input, signal),
});
