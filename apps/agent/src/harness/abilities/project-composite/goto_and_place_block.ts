import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { goto_block_placement_pose } from "../built-in/goto_block_placement_pose.js";
import { place_block } from "../built-in/place_block.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";
import { failureTypeOf, interrupted } from "../shared/composites.js";

const data = s.object({
  item_id: s.field(canonicalIdValue, { description: "Exact carried BlockItem requested for placement." }),
  position: s.field(blockPositionSchema, { description: "Exact target position." }),
  action: s.field(s.literal("place_block"), { description: "Frozen child action." }),
  initial: s.field(place_block.output, { description: "Initial exact placement result." }),
  approach: s.optional(goto_block_placement_pose.output, {
    description: "Placement-pose approach result when attempted.",
  }),
  retry: s.optional(place_block.output, { description: "Single placement retry result when attempted." }),
});
const input = s.object({
  item_id: s.field(canonicalIdValue, {
    description: "Exact canonical carried BlockItem id to place.",
    examples: ["minecraft:cobblestone"],
  }),
  position: s.field(blockPositionSchema, {
    description: "Exact current-dimension position to fill: known air or a known replaceable block.",
    examples: [{ x: 4, y: 64, z: -2 }],
  }),
});
const output = canonicalAbilityResultSchema(data, data);

export const goto_and_place_block: CompositeAbilityDefinition<
  "goto_and_place_block",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "goto_and_place_block",
  description: "Place an exact carried BlockItem at an exact cell, approaching once when the target is unknown, out of reach, occluded, or under the bot's own body. Placement requires observed air or a replaceable block.",
  concurrency: "safe", input: input, output: output,
  async execute(value, { abilities, signal }) {
    const initial = await abilities.place_block(value);
    const initialData = { ...value, action: "place_block" as const, initial };
    if (initial.ok) return { ok: true as const, message: initial.message, data: initialData };
    const failureType = failureTypeOf(initial.data);
    // Approaching can reveal an unknown target; other-entity occupancy remains the caller's decision.
    if (failureType !== "out_of_reach" && failureType !== "occluded"
      && failureType !== "body_in_target" && failureType !== "target_unknown") {
      return { ok: false as const, error: initial.error, message: initial.message, data: initialData };
    }
    if (signal.aborted) return interrupted(initialData);

    const approach = await abilities.goto_block_placement_pose(value);
    const approachedData = { ...initialData, approach };
    if (!approach.ok) {
      return { ok: false as const, error: approach.error, message: approach.message, data: approachedData };
    }
    if (signal.aborted) return interrupted(approachedData);

    const retry = await abilities.place_block(value);
    const retriedData = { ...approachedData, retry };
    return retry.ok
      ? { ok: true as const, message: retry.message, data: retriedData }
      : { ok: false as const, error: retry.error, message: retry.message, data: retriedData };
  },
});
