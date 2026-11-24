import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { blockPositionSchema } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";

const input = s.object({
  position: s.field(blockPositionSchema, { description: "Exact known bed position; either bed half is accepted." }),
});
const successData = s.object({
  position: s.field(blockPositionSchema, { description: "Normalized exact bed-head position." }),
  sleeping: s.field(s.literal(true), { description: "Verified sleeping state." }),
});
const failureData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested bed position." }),
  failure_type: s.field(s.enumeration(
    "target_changed", "out_of_reach", "occupied", "obstructed", "not_sleep_time",
    "unsafe_nearby_monster", "bed_not_usable_in_dimension", "accepted_but_not_sleeping",
  ), { description: "Stable reason verified bed entry did not complete." }),
});
const interruptedData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested bed position retained on interruption." }),
});
const output = canonicalAbilityResultVariants(successData, [
  { error: "RUNTIME_FAILED", data: failureData, title: "Expected bed-entry failure", description: "The exact bed-entry intent reached a stable expected failure." },
  { error: "INTERRUPTED", data: interruptedData, title: "Bed entry interrupted", description: "Bed entry was interrupted before sleeping was verified." },
]);

export const enter_bed = defineDirectRuntimeAbility({
  name: "enter_bed",
  description: "Enter one exact known bed without navigation. Either bed half is accepted and normalized to the head. Success requires verified sleeping and inherently updates the vanilla respawn point; the Ability returns immediately and does not wait for morning.",
  execution: "body", input, output,
});
