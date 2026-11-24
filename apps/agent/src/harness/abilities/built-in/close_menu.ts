import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolEmpty } from "../shared/schemas.js";
import { defineDirectRuntimeAbility } from "../runtime-backed-ability.js";
const output = canonicalAbilityResultSchema(toolEmpty, toolEmpty);
export const close_menu = defineDirectRuntimeAbility({
  name: "close_menu", description: "Idempotently close the current Block Menu.", execution: "body",
  input: toolEmpty, output, runtimeToolName: "close_gui",
});
