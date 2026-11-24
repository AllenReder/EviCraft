import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { canonicalIdGlobValue, toolEmpty, uuidPattern } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
const collectItemsData = s.object({
  collected_entities: s.field(s.integer({ minimum: 0 }), { description: "Verified number of item entities collected." }),
  collected_items: s.field(s.integer({ minimum: 0 }), { description: "Verified total item units collected." }),
  skipped_entities: s.field(s.integer({ minimum: 0 }), { description: "Number of selected item entities skipped after target-local collection failures." }),
  radius: s.field(s.integer({ minimum: 1 }), { description: "Collection radius in blocks used by the Runtime." }),
  selection: s.field(s.enumeration("item_id_glob", "uuids"), { description: "Target-selection form used by the collection." }),
  failure_type: s.optional(s.enumeration("target_lost", "unreachable", "unknown_not_known"), { description: "Stable terminal collection failure category when present: target_lost means the UUID left embodied evidence; unreachable means evidence remained but collection could not reach it." }),
});
const output = canonicalAbilityResultSchema(collectItemsData, s.oneOf(
  s.branch(toolEmpty, { title: "No verified collection progress", description: "No collection facts were verified." }),
  s.branch(collectItemsData, { title: "Verified collection progress", description: "The result retains verified item collection progress." }),
));
export const collect_items = defineDirectRuntimeAbility({
  name: "collect_items", description: "Collect dropped items held in embodied evidence by item-id glob (default) or exact UUIDs. Each target whose approach fails is retried a few times; items that vanished are skipped as lost and ones that stay out of reach as unreachable. A glob selection also picks up matching drops newly remembered within the radius once the first set is settled, such as items scattered by earlier pickups.", execution: "body",
  input: s.oneOf(
    s.branch(s.object({
      item_id_glob: s.field(canonicalIdGlobValue, {
        description: "Full-match Canonical ID Glob over remembered dropped-item ids; use this branch by default.",
        examples: ["minecraft:*_ingot"],
      }),
      radius: s.optional(s.integer({ minimum: 1, maximum: 48 }), {
        description: "Maximum collection radius in blocks around current feet; omission uses 8.", default: 8, examples: [8],
      }),
    }), { title: "Dropped-item Canonical ID Glob", description: "Default Agent-facing selection by canonical item id." }),
    s.branch(s.object({
      uuids: s.field(s.array(s.string({ pattern: uuidPattern }), { minItems: 1, maxItems: 64, uniqueItems: true }), {
        description: "One to sixty-four exact evidence-backed dropped-item Entity UUIDs.",
        examples: [["00000000-0000-4000-8000-000000000001"]],
      }),
      radius: s.optional(s.integer({ minimum: 1, maximum: 48 }), {
        description: "Maximum collection radius in blocks around current feet; omission uses 8.", default: 8, examples: [8],
      }),
    }), { title: "Exact dropped-item UUIDs", description: "Use only when exact dropped-item entity evidence is already available." }),
  ), output,
});
