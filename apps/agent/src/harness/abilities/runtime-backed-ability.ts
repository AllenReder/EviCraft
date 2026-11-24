import {
  defineAbility,
  type AbilityAuthorDefinition,
  type AbilityDefinition,
} from "../ability-runtime.js";
import type { InferToolSchema, ToolSchema } from "../tool-schema.js";
import { requiredRuntime } from "./shared/runtime.js";

const runtimeAbilityMappingKey = Symbol("runtimeAbilityMapping");

type RuntimeAbilityMapping = Readonly<{
  kind: "direct" | "input_translated";
  runtimeToolName: string;
}>;

type MappedAbilityDefinition<Name extends string, Input, Output> =
  AbilityAuthorDefinition<Name, Input, Output>
  & Readonly<{ [runtimeAbilityMappingKey]: RuntimeAbilityMapping }>;

/** Author one direct Runtime-backed Ability from its annotated Tool Contract. */
export function defineDirectRuntimeAbility<
  const Name extends string,
  InputSchema extends ToolSchema<unknown>,
  OutputSchema extends ToolSchema<unknown>,
>(declaration: Readonly<{
  name: Name;
  description: string;
  execution: "query" | "body";
  visibility?: "internal";
  input: InputSchema;
  output: OutputSchema;
  runtimeToolName?: string;
}>): AbilityAuthorDefinition<
  Name,
  InferToolSchema<InputSchema>,
  InferToolSchema<OutputSchema>
> {
  const runtimeToolName = declaration.runtimeToolName ?? declaration.name;
  const definition = defineAbility({
    name: declaration.name,
    description: declaration.description,
    concurrency: declaration.execution === "query" ? "safe" : "exclusive",
    execution: declaration.execution,
    ...(declaration.visibility === undefined ? {} : { visibility: declaration.visibility }),
    input: declaration.input,
    output: declaration.output,
    async execute(input, context) {
      return await requiredRuntime(context).call(
        runtimeToolName,
        input as Record<string, unknown>,
        context.signal,
      ) as InferToolSchema<OutputSchema>;
    },
  });
  const mapped = { ...definition } as MappedAbilityDefinition<
    Name,
    InferToolSchema<InputSchema>,
    InferToolSchema<OutputSchema>
  >;
  Object.defineProperty(mapped, runtimeAbilityMappingKey, {
    value: Object.freeze({ kind: "direct", runtimeToolName }),
  });
  return Object.freeze(mapped);
}

/** Author one input-translated Runtime-backed Ability from its annotated Tool Contract. */
export function defineInputTranslatedRuntimeAbility<
  const Name extends string,
  InputSchema extends ToolSchema<unknown>,
  OutputSchema extends ToolSchema<unknown>,
>(declaration: Readonly<{
  name: Name;
  description: string;
  execution: "query" | "body";
  input: InputSchema;
  output: OutputSchema;
  runtimeToolName: string;
  translateInput(input: InferToolSchema<InputSchema>): Record<string, unknown>;
}>): AbilityAuthorDefinition<
  Name,
  InferToolSchema<InputSchema>,
  InferToolSchema<OutputSchema>
> {
  const definition = defineAbility({
    name: declaration.name,
    description: declaration.description,
    concurrency: declaration.execution === "query" ? "safe" : "exclusive",
    execution: declaration.execution,
    input: declaration.input,
    output: declaration.output,
    async execute(input, context) {
      return await requiredRuntime(context).call(
        declaration.runtimeToolName,
        declaration.translateInput(input),
        context.signal,
      ) as InferToolSchema<OutputSchema>;
    },
  });
  const mapped = { ...definition } as MappedAbilityDefinition<
    Name,
    InferToolSchema<InputSchema>,
    InferToolSchema<OutputSchema>
  >;
  Object.defineProperty(mapped, runtimeAbilityMappingKey, {
    value: Object.freeze({
      kind: "input_translated",
      runtimeToolName: declaration.runtimeToolName,
    }),
  });
  return Object.freeze(mapped);
}

/** Internal conformance view; this module is not part of the Harness package export. */
export function runtimeAbilityMapping(
  definition: AbilityDefinition<string, unknown, unknown>,
): RuntimeAbilityMapping | undefined {
  return (definition as Partial<MappedAbilityDefinition<string, unknown, unknown>>)
    [runtimeAbilityMappingKey];
}
