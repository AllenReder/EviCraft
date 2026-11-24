import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { useItemOnBlockOutput } from "../built-in/use_item_on_block.js";
import { failureTypeOf } from "../shared/composites.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";

const input = s.object({
  item_id: s.field(canonicalIdValue, {
    description: "Exact canonical carried non-BlockItem id to use.",
    examples: ["minecraft:water_bucket"],
  }),
  position: s.field(blockPositionSchema, {
    description: "Exact current-dimension known-block position to use the item on.",
    examples: [{ x: 4, y: 64, z: -2 }],
  }),
});
const output = useItemOnBlockOutput;

export const goto_and_use_item_on_block: CompositeAbilityDefinition<
  "goto_and_use_item_on_block",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "goto_and_use_item_on_block",
  description: "Use one carried non-BlockItem on an exact known block, approaching first when it is out of reach or occluded: to a pose from which that item's use resolves, which for a bucket on a known water or lava cell keeps the feet off fluids and away from lava. Only out-of-reach or occluded results trigger the approach and one retry; when no pose reaches the target the first failure is returned with the pose's reason.",
  concurrency: "safe", input: input, output,
  async execute(value, { abilities, signal }) {
    const initial = await abilities.use_item_on_block(value);
    if (initial.ok) return initial;
    const failureType = failureTypeOf(initial.data);
    if (failureType !== "out_of_reach" && failureType !== "occluded") return initial;
    if (signal.aborted) return interrupted(value);

    const pose = await abilities.goto_block_interaction_pose({ position: value.position, item_id: value.item_id });
    if (!pose.ok && pose.error === "INTERRUPTED") return interrupted(value);
    if (!pose.ok) return { ...initial, message: `${initial.message}; no pose reaches it: ${pose.message}` };
    if (signal.aborted) return interrupted(value);
    return await abilities.use_item_on_block(value);
  },
});

function interrupted(value: InferToolSchema<typeof input>) {
  return {
    ok: false as const, error: "INTERRUPTED" as const, message: "composite interrupted",
    data: { item_id: value.item_id, position: value.position },
  };
}
