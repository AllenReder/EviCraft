import type { AgentToolProjection } from "./model-surface-message.js";
import type { InferToolSchema, ToolSchema } from "./tool-schema.js";

export type ToolContractStage = "input_validation" | "output_validation" | "rendering";

export class ToolContractError extends Error {
  public constructor(
    public readonly tool: string,
    public readonly stage: ToolContractStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolContractError";
  }
}

export interface ToolContract<
  Name extends string,
  InputSchema extends ToolSchema<unknown>,
  OutputSchema extends ToolSchema<unknown>,
> {
  readonly name: Name;
  readonly description: string;
  readonly input: InputSchema;
  readonly output: OutputSchema;
  render(input: InferToolSchema<InputSchema>, output: InferToolSchema<OutputSchema>): string;
}

export function defineToolContract<
  const Name extends string,
  InputSchema extends ToolSchema<unknown>,
  OutputSchema extends ToolSchema<unknown>,
>(contract: ToolContract<Name, InputSchema, OutputSchema>): ToolContract<Name, InputSchema, OutputSchema> {
  if (contract.name.trim() === "") throw new Error("Tool Contract name must be non-empty");
  if (contract.description.trim() === "") throw new Error("Tool Contract description must be non-empty");
  return Object.freeze({ ...contract });
}

export function projectToolContract(
  contract: ToolContract<string, ToolSchema<unknown>, ToolSchema<unknown>>,
): AgentToolProjection {
  return Object.freeze({
    name: contract.name,
    description: contract.description,
    inputSchema: contract.input.jsonSchema,
    strict: false,
  });
}

export async function executeToolContract<
  InputSchema extends ToolSchema<unknown>,
  OutputSchema extends ToolSchema<unknown>,
>(
  contract: ToolContract<string, InputSchema, OutputSchema>,
  rawInput: unknown,
  execute: (input: InferToolSchema<InputSchema>) => Promise<unknown> | unknown,
): Promise<Readonly<{
  input: InferToolSchema<InputSchema>;
  canonicalOutput: InferToolSchema<OutputSchema>;
  modelContent: string;
}>> {
  let input: InferToolSchema<InputSchema>;
  try {
    input = deepFreeze(
      contract.input.parse(rawInput, `${contract.name} input`) as InferToolSchema<InputSchema>,
    );
  } catch (error) {
    throw contractError(contract.name, "input_validation", error);
  }

  const produced = await execute(input);
  let canonicalOutput: InferToolSchema<OutputSchema>;
  try {
    canonicalOutput = deepFreeze(
      contract.output.parse(produced, `${contract.name} output`) as InferToolSchema<OutputSchema>,
    );
  } catch (error) {
    throw contractError(contract.name, "output_validation", error);
  }

  let modelContent: string;
  try {
    modelContent = contract.render(input, canonicalOutput);
    if (typeof modelContent !== "string") throw new Error("Tool Output Renderer must return a string");
  } catch (error) {
    throw contractError(contract.name, "rendering", error);
  }
  return Object.freeze({ input, canonicalOutput, modelContent });
}

function contractError(tool: string, stage: ToolContractStage, error: unknown): ToolContractError {
  return new ToolContractError(
    tool,
    stage,
    `${tool} Tool Contract ${stage.replace("_", " ")} failed: ${errorMessage(error)}`,
    { cause: error },
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
