import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
import { blockPositionSchema, observedDropEntitySchema } from "../shared/schemas.js";

const input = s.object({
  position: s.field(blockPositionSchema, {
    description: "Exact current-dimension position of the known block to break without navigation.",
    examples: [{ x: 4, y: 64, z: -2 }],
  }),
});
const successData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact position whose original block was verified absent." }),
  observed_drop_entities: s.field(s.array(observedDropEntitySchema), {
    description: "Best-effort ordinary ItemEntity evidence observed for this break; no completeness guarantee and an empty list is valid.",
  }),
});
const occludingBlock = s.object({
  position: s.field(blockPositionSchema, {
    description: "Exact current-dimension position of the Pose-local block that was the native first hit.",
  }),
  block_state: s.field(s.string(), {
    description: "Canonical BlockState read from that exact native first-hit block.",
  }),
});
const nonOccludedFailureData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested block position." }),
  failure_type: s.field(s.enumeration(
    "menu_open", "target_not_known_block", "target_changed", "out_of_reach",
    "unsupported_shape", "unbreakable", "no_effect",
  ), { description: "Stable reason the exact block disappearance was not verified." }),
});
const occludedFailureData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested block position." }),
  failure_type: s.field(s.literal("occluded"), {
    description: "The native target-directed first hit did not match the exact requested block.",
  }),
  occluding_block: s.optional(occludingBlock, {
    description: "Pose-local native first-hit block, when the occlusion first hit a block; absent for non-block first hits.",
  }),
});
const failureData = s.oneOf(
  s.branch(nonOccludedFailureData, {
    title: "Non-occlusion failure",
    description: "The exact break failed for a stable reason other than an occluding native first hit.",
  }),
  s.branch(occludedFailureData, {
    title: "Occluded exact break",
    description: "The exact target-directed ray was occluded; a block first hit is returned as structured Pose-local evidence.",
  }),
);
const interruptionData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested position retained after interruption." }),
});
const output = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED", data: failureData,
    title: "Expected break failure",
    description: "The exact break intent reached a stable expected Minecraft failure.",
  },
  {
    error: "INTERRUPTED", data: interruptionData,
    title: "Break interrupted",
    description: "The exact break intent was interrupted before disappearance was verified.",
  },
]);

export const break_block = defineDirectRuntimeAbility({
  name: "break_block",
  description: "Break one exact known block from the current position. In modes where the held item affects breaking, the Runtime selects and retains a suitable carried implement, preferring correct harvesting and then base destroy speed. It still breaks when no correct implement is carried. It does not travel or clear blockers; use goto_and_break_block for an out-of-reach or occluded target.",
  execution: "body", input, output,
});
