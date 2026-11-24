import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
import { toolEmpty, uuidPattern } from "../shared/schemas.js";
const dropEntity = s.object({
  uuid: s.field(s.string({ pattern: uuidPattern }), { description: "Exact ItemEntity UUID." }),
  item_id: s.field(s.string(), { description: "Canonical item identifier." }),
  count: s.field(s.integer({ minimum: 1 }), { description: "Stack size observed at death." }),
});
const attackData = s.object({
  mode: s.field(s.enumeration("visible_hostiles", "explicit_uuids"), { description: "Target-selection mode used by the attack." }),
  requested_uuids: s.field(s.array(s.string({ pattern: uuidPattern })), { description: "Exact Entity Track UUIDs selected for combat." }),
  completion: s.field(s.enumeration("all", "partial", "none"), { description: "Whether every authorized target reached a terminal state." }),
  defeated_uuids: s.field(s.array(s.string({ pattern: uuidPattern })), { description: "Selected UUIDs verified defeated." }),
  lost_uuids: s.field(s.array(s.string({ pattern: uuidPattern })), { description: "Selected UUIDs lost from embodied evidence." }),
  unreachable_uuids: s.field(s.array(s.string({ pattern: uuidPattern })), { description: "Selected UUIDs verified unreachable." }),
  strikes: s.field(s.integer({ minimum: 0 }), { description: "Verified attack strikes attempted." }),
  combat_by_entity: s.field(s.record(s.object({
    status: s.field(s.enumeration("pending", "defeated", "lost", "unreachable"), { description: "Final combat status for this target." }),
    strikes: s.field(s.integer({ minimum: 0 }), { description: "Verified strikes attempted against this target." }),
  })), { description: "Per-target combat progress keyed by exact entity UUID." }),
  observed_drop_entities: s.field(s.array(dropEntity), { description: "Exact ItemEntity UUIDs attributed to verified kills." }),
  failure_type: s.optional(s.enumeration("target_lost", "unreachable"), { description: "Stable partial-combat failure category when present." }),
});
const output = canonicalAbilityResultSchema(attackData, s.oneOf(
  s.branch(toolEmpty, { title: "No verified combat progress", description: "No combat facts were verified." }),
  s.branch(attackData, { title: "Verified combat progress", description: "The result retains per-target verified combat progress." }),
));
export const attack = defineDirectRuntimeAbility({
  name: "attack", description: "Attack explicit embodied Entity Track UUIDs, or currently visible hostile evidence when omitted. Does not flee or collect drops.", execution: "body",
  input: s.object({ uuids: s.optional(s.array(s.string({ pattern: uuidPattern }), { minItems: 1, maxItems: 20, uniqueItems: true }), {
    description: "Exact embodied Entity Track UUIDs to attack; omission selects currently visible hostile evidence at task start.",
    examples: [["123e4567-e89b-42d3-a456-426614174000"]],
  }) }),
  output,
});
