import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { canonicalIdGlobValue, canonicalIdValue } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";

const requestedItemIdGlobs = s.array(canonicalIdGlobValue, { minItems: 1, maxItems: 16 });
const globsField = () => s.field(requestedItemIdGlobs, {
  description: "One to sixteen ordered Canonical ID Globs to add, delete exactly, or set.",
  examples: [["minecraft:*dirt", "minecraft:stone"]],
});
const input = s.oneOf(
  s.branch(s.object({
    action: s.optional(s.literal("read"), {
      description: "Read the current policy; omission also selects read.", default: "read",
    }),
  }), { title: "Read policy", description: "Return the current World Run Scaffold Material policy without changing it." }),
  s.branch(s.object({
    action: s.field(s.literal("add"), { description: "Append new Globs, removing duplicate configured strings without reordering." }),
    item_id_globs: globsField(),
  }), { title: "Add Globs", description: "Append validated Globs to the existing policy atomically." }),
  s.branch(s.object({
    action: s.field(s.literal("delete"), { description: "Delete only configured Globs exactly equal to a supplied string." }),
    item_id_globs: globsField(),
  }), { title: "Delete exact Globs", description: "Remove exact configured Glob strings without expanding the deletion selectors." }),
  s.branch(s.object({
    action: s.field(s.literal("set"), { description: "Replace the complete policy with the supplied ordered Globs." }),
    item_id_globs: globsField(),
  }), { title: "Set policy", description: "Replace the complete policy after validating and expanding every supplied Glob." }),
  s.branch(s.object({
    action: s.field(s.literal("clear"), { description: "Authorize no BlockItem for navigation scaffold consumption." }),
  }), { title: "Clear policy", description: "Store an explicit empty policy for the remainder of this World Run." }),
);
const carriedMatchingItem = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical item id of one carried BlockItem authorized by the effective policy." }),
  count: s.field(s.integer({ minimum: 1 }), { description: "Total matching item count across the Runtime Bot's Inventory." }),
});
const policyFields = {
  action: s.field(s.enumeration("read", "add", "delete", "set", "clear"), {
    description: "Policy operation represented by this result projection.",
  }),
  item_id_globs: s.field(s.array(canonicalIdGlobValue, { maxItems: 16 }), {
    description: "Complete ordered, deduplicated Canonical ID Globs currently configured.",
  }),
  effective_item_count: s.field(s.integer({ minimum: 0, maximum: 128 }), {
    description: "Number of unique non-air BlockItems authorized by the configured Globs.",
  }),
  effective_item_sample: s.field(s.array(canonicalIdValue, { maxItems: 16 }), {
    description: "Registry-ordered sample of at most sixteen effective authorized BlockItems.",
  }),
  carried_matching_items: s.field(s.array(carriedMatchingItem, { maxItems: 128 }), {
    description: "Every carried BlockItem matching the effective policy, with its total count.",
  }),
} as const;
const successData = s.object(policyFields);
const failureData = s.object({
  ...policyFields,
  failure_type: s.field(s.enumeration(
    "no_block_item_match", "too_many_item_id_globs", "too_many_effective_items",
  ), { description: "Stable reason the requested atomic policy mutation was rejected." }),
});
const output = canonicalAbilityResultSchema(successData, failureData);

export const manage_scaffold_materials = defineDirectRuntimeAbility({
  name: "manage_scaffold_materials",
  description: "Configure which carried BlockItems navigation may consume as temporary scaffolding during this World Run. It does not move or place blocks.",
  execution: "body", input, output,
});
