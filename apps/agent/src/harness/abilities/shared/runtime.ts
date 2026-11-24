import {
  defineAbility,
  type AbilityAuthorDefinition,
  type AbilityInvocationContext,
} from "../../ability-runtime.js";
import type { SemanticMenuTranslation } from "../../semantic-menu.js";
import type { ToolSchema } from "../../tool-schema.js";

export function semanticTool<const Name extends string, Input, Output>(options: Readonly<{
  name: Name;
  description: string;
  execution: "query" | "body";
  input: ToolSchema<Input>;
  output: ToolSchema<Output>;
  invoke: (
    semantic: SemanticMenuTranslation,
    input: Input,
    signal: AbortSignal | undefined,
  ) => Promise<unknown>;
}>): AbilityAuthorDefinition<Name, Input, Output> {
  return defineAbility({
    name: options.name,
    description: options.description,
    concurrency: options.execution === "query" ? "safe" : "exclusive",
    execution: options.execution,
    input: options.input,
    output: options.output,
    async execute(value, context) {
      const semantic = requiredRuntime(context).semantic;
      const result = await options.invoke(semantic, value, context.signal);
      return options.output.parse(result, `${options.name} semantic result`);
    },
  });
}

export function requiredRuntime(context: AbilityInvocationContext) {
  if (context.runtime === undefined) throw new Error("Ability requires the RuntimeAdapter");
  return context.runtime;
}
