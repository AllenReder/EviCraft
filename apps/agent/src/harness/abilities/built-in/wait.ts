import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineInputTranslatedRuntimeAbility } from "../runtime-backed-ability.js";
import { toolEmpty } from "../shared/schemas.js";

const output = canonicalAbilityResultVariants(toolEmpty, [{
  error: "INTERRUPTED",
  data: toolEmpty,
  title: "Wait interrupted",
  description: "The wait was interrupted before its requested duration elapsed.",
}]);

const TICKS_PER_SECOND = 20;

export const wait = defineInputTranslatedRuntimeAbility({
  name: "wait", description: "Let game time pass without acting. The duration is game time at 20 ticks per second, rounded to whole ticks. Game time advances only while an action or a wait is in progress, so this is how to wait for the world to change.",
  execution: "query",
  input: s.object({ seconds: s.field(s.number({ minimum: 0, maximum: 300 }), {
    description: "Game time to wait in seconds.",
    examples: [0.5],
  }) }),
  output,
  runtimeToolName: "wait",
  translateInput: input => ({ ticks: Math.round(input.seconds * TICKS_PER_SECOND) }),
});
