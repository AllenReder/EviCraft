import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { failureTypeOf, interrupted } from "../shared/composites.js";
import { blockPositionSchema } from "../shared/schemas.js";

const successData = s.oneOf(
  s.branch(s.object({
    position: s.field(blockPositionSchema, { description: "Exact activated block position." }),
    outcome: s.field(s.literal("menu_opened"), { description: "Activation opened a supported or unsupported Block Menu." }),
  }), { title: "Menu opened", description: "Activation is verified by an open Block Menu." }),
  s.branch(s.object({
    position: s.field(blockPositionSchema, { description: "Exact activated block position." }),
    outcome: s.field(s.literal("block_state_changed"), { description: "Activation changed the exact target BlockState." }),
    block_state: s.field(s.string(), { description: "Verified canonical BlockState after activation." }),
  }), { title: "BlockState changed", description: "Activation is verified by an exact target BlockState change." }),
);
const compactFailureData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact requested block position." }),
  failure_type: s.field(s.enumeration(
    "menu_open", "target_not_known_block", "target_changed", "no_interaction_pose", "no_effect",
  ), { description: "Stable reason the activation workflow did not verify an outcome." }),
});
const interruptionData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact target position retained after interruption." }),
});
const input = s.object({ position: s.field(blockPositionSchema, { description: "Exact known block position." }) });
const output = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED",
    data: compactFailureData,
    title: "Expected activation failure",
    description: "The activation workflow reached a stable terminal failure.",
  },
  {
    error: "INTERRUPTED",
    data: interruptionData,
    title: "Activation interrupted",
    description: "The workflow was interrupted before a verified activation outcome.",
  },
]);

export const goto_and_activate_block: CompositeAbilityDefinition<
  "goto_and_activate_block",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "goto_and_activate_block",
  description: "Activate one exact known block from the current pose; success verifies a block Menu opened or the exact target BlockState changed. Only out-of-reach or occluded results trigger an approach and one retry.",
  concurrency: "safe", input: input, output: output,
  async execute(value, { abilities, signal }) {
    const initial = await abilities.activate_block(value);
    if (initial.ok) return initial;
    const failureType = failureTypeOf(initial.data);
    if (failureType !== "out_of_reach" && failureType !== "occluded") {
      return initial;
    }
    if (signal.aborted) return interrupted({ position: value.position });
    const approach = await abilities.goto_block_interaction_pose(value);
    if (!approach.ok) {
      return approach;
    }
    if (signal.aborted) return interrupted({ position: value.position });
    const retry = await abilities.activate_block(value);
    if (retry.ok) return { ok: true as const, message: retry.message, data: retry.data };
    if (retry.error === "INTERRUPTED") return interrupted({ position: value.position });
    return activationFailure(retry.message, value.position, failureTypeOf(retry.data));
  },
});

function activationFailure(
  message: string,
  position: { x: number; y: number; z: number },
  failureType: string | undefined,
) {
  switch (failureType) {
    case "menu_open":
    case "target_not_known_block":
    case "target_changed":
    case "no_effect":
      return { ok: false as const, error: "RUNTIME_FAILED" as const, message, data: { position, failure_type: failureType } };
    case "out_of_reach":
    case "occluded":
      return { ok: false as const, error: "RUNTIME_FAILED" as const, message, data: { position, failure_type: "no_effect" as const } };
    default:
      throw new Error("activate_block returned an unsupported failure type");
  }
}
