import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { toolEmpty } from "../shared/schemas.js";
import { childFailure, failure, interrupted } from "../shared/composites.js";

const data = s.object({
  ascent_steps: s.field(s.integer({ minimum: 0, maximum: 64 }), {
    description: "Verified number of bounded upward movement steps completed.",
  }),
});
const input = toolEmpty;
const output = canonicalAbilityResultSchema(data, data);

export const surface: CompositeAbilityDefinition<
  "surface",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "surface", description: "Use only while underwater to ascend to the water surface, stopping when observe_self confirms breathable air. Do not use for movement on land.",
  concurrency: "safe", input: input, output,
  async execute(_input, { abilities, signal }) {
    for (let step = 0; step < 64; step += 1) {
      if (signal.aborted) return interrupted({ ascent_steps: step });
      const observed = await abilities.observe_self({});
      if (!observed.ok) return childFailure(observed, { ascent_steps: step });
      if (!observed.data.underwater) {
        return { ok: true as const, message: "reached breathable air", data: { ascent_steps: step } };
      }
      const feet = observed.data.feet;
      const targetY = Math.min(320, feet.y + 2);
      if (targetY <= feet.y) return failure("surface ascent reached the world height bound", { ascent_steps: step });
      const moved = await abilities.goto({ x: feet.x, y: targetY, z: feet.z });
      if (!moved.ok) return childFailure(moved, { ascent_steps: step });
    }
    return failure("surface ascent exhausted its bounded steps", { ascent_steps: 64 });
  },
});
