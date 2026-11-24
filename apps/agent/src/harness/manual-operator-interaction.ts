import { confirm, input, number, search, select } from "@inquirer/prompts";

import {
  analyzeManualTool,
  type ManualArrayNode,
  type ManualInputNode,
  type ManualInputPreset,
  type ManualObjectNode,
  type ManualToolAnalysis,
} from "./manual-input-schema.js";
import {
  type OperatorInteraction,
  type OperatorSelection,
  type OperatorTurn,
} from "./operator-interaction.js";

type PromptContext = Readonly<{
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearPromptOnDone?: boolean;
  signal?: AbortSignal;
}>;

export interface ManualOperatorInteractionOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

/** Interactive terminal form that converts one fresh Turn Observation into one Ability call. */
export class ManualOperatorInteraction implements OperatorInteraction {
  readonly #context: Omit<PromptContext, "signal">;
  readonly #output: NodeJS.WritableStream;
  #spinner: ReturnType<typeof setInterval> | undefined;
  #spinnerStartedAt = 0;

  public constructor(options: ManualOperatorInteractionOptions = {}) {
    this.#output = options.output ?? process.stdout;
    this.#context = {
      input: options.input ?? process.stdin,
      output: this.#output,
      clearPromptOnDone: false,
    };
  }

  public async choose(turn: OperatorTurn, options: Readonly<{ signal?: AbortSignal }>): Promise<OperatorSelection> {
    this.#stopSpinner("settled");
    this.#writeTurn(turn);
    const context = options.signal === undefined
      ? this.#context
      : { ...this.#context, signal: options.signal };

    for (;;) {
      const analyses = turn.tools.map(analyzeManualTool);
      const selected = await search<ManualToolAnalysis>({
        message: "Choose an Ability",
        pageSize: 12,
        source: (term) => {
          const query = term?.trim().toLocaleLowerCase() ?? "";
          return analyses
            .filter((analysis) => query === ""
              || analysis.name.toLocaleLowerCase().includes(query)
              || analysis.description.toLocaleLowerCase().includes(query))
            .map((analysis) => ({
              value: analysis,
              name: analysis.name,
              description: analysis.description,
              ...(analysis.supported ? {} : { disabled: analysis.reason }),
            }));
        },
      }, context);
      if (!selected.supported) continue;

      const preset = await this.#choosePreset(selected, context);
      let value = await this.#readNode(preset.node, selected.name, context);
      for (;;) {
        this.#output.write(`\n${selected.name} ${JSON.stringify(value, null, 2)}\n`);
        const action = await select({
          message: "Review Ability call",
          choices: [
            { value: "execute", name: "Execute" },
            { value: "edit", name: "Edit input" },
            { value: "abandon", name: "Choose another Ability" },
          ],
        }, context);
        if (action === "execute") {
          this.#startSpinner(options.signal);
          return { toolName: selected.name, input: value };
        }
        if (action === "abandon") break;
        value = await this.#readNode(preset.node, selected.name, context);
      }
    }
  }

  public close(): void {
    this.#stopSpinner("silent");
  }

  async #choosePreset(analysis: Extract<ManualToolAnalysis, { supported: true }>, context: PromptContext): Promise<ManualInputPreset> {
    if (analysis.presets.length === 1) return analysis.presets[0]!;
    return await select({
      message: "Choose an input preset",
      choices: analysis.presets.map((preset) => ({ value: preset, name: preset.label })),
    }, context);
  }

  async #readNode(node: ManualInputNode, path: string, context: PromptContext): Promise<unknown> {
    switch (node.kind) {
      case "object": return await this.#readObject(node, path, context);
      case "array": return await this.#readArray(node, path, context);
      case "string": return await input({
        message: path,
        ...(node.pattern === undefined ? {} : {
          validate: (value) => new RegExp(node.pattern!, "u").test(value) || `Must match /${node.pattern}/`,
        }),
      }, context);
      case "integer":
      case "number": {
        const value = await number({
          message: path,
          required: true,
          min: node.minimum,
          max: node.maximum,
          ...(node.kind === "integer" ? {
            step: "any" as const,
            validate: (candidate) => Number.isSafeInteger(candidate) || "Must be a safe integer",
          } : {}),
        }, context);
        return value;
      }
      case "boolean": return await confirm({ message: path });
      case "enum": return await select({
        message: path,
        choices: node.values.map((value) => ({ value })),
      }, context);
      case "literal": return node.value;
    }
  }

  async #readObject(node: ManualObjectNode, path: string, context: PromptContext): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const field of node.fields) {
      const fieldPath = `${path}.${field.name}`;
      if (!field.required) {
        const choices = [
          { value: "omit" as const, name: "Omit" },
          ...(field.defaultValue === undefined
            ? []
            : [{ value: "default" as const, name: `Use default (${JSON.stringify(field.defaultValue)})` }]),
          { value: "enter" as const, name: "Enter value" },
        ];
        const action = await select({ message: fieldPath, choices }, context);
        if (action === "omit") continue;
        if (action === "default") {
          result[field.name] = field.defaultValue;
          continue;
        }
      }
      result[field.name] = await this.#readNode(field.node, fieldPath, context);
    }
    return result;
  }

  async #readArray(node: ManualArrayNode, path: string, context: PromptContext): Promise<unknown[]> {
    const values: unknown[] = [];
    const minimum = node.minimumItems ?? 0;
    while (values.length < minimum) {
      values.push(await this.#readUniqueArrayItem(node, path, values, values.length, context));
    }
    for (;;) {
      this.#output.write(`\n${path} ${JSON.stringify(values, null, 2)}\n`);
      const maximumReached = node.maximumItems !== undefined && values.length >= node.maximumItems;
      const action = await select({
        message: `Edit ${path}`,
        choices: [
          { value: "add", name: "Add item", ...(maximumReached ? { disabled: "Maximum item count reached" } : {}) },
          { value: "edit", name: "Edit item", ...(values.length === 0 ? { disabled: "Array is empty" } : {}) },
          { value: "delete", name: "Delete item", ...(values.length <= minimum ? { disabled: "Minimum item count reached" } : {}) },
          { value: "done", name: "Done" },
        ],
      }, context);
      if (action === "done") return values;
      if (action === "add") {
        values.push(await this.#readUniqueArrayItem(node, path, values, values.length, context));
        continue;
      }
      const index = await select({
        message: action === "edit" ? "Choose an item to edit" : "Choose an item to delete",
        choices: values.map((value, candidate) => ({
          value: candidate,
          name: `[${candidate}] ${JSON.stringify(value)}`,
        })),
      }, context);
      if (action === "delete") {
        values.splice(index, 1);
        continue;
      }
      values[index] = await this.#readUniqueArrayItem(node, path, values, index, context);
    }
  }

  async #readUniqueArrayItem(
    node: ManualArrayNode,
    path: string,
    values: readonly unknown[],
    index: number,
    context: PromptContext,
  ): Promise<unknown> {
    for (;;) {
      const value = await this.#readNode(node.item, `${path}[${index}]`, context);
      const duplicate = node.uniqueItems && values.some((candidate, candidateIndex) =>
        candidateIndex !== index && JSON.stringify(candidate) === JSON.stringify(value));
      if (!duplicate) return value;
      this.#output.write("That item is already present; enter a unique value.\n");
    }
  }

  #writeTurn(turn: OperatorTurn): void {
    this.#output.write("\n=== Turn Observation ===\n");
    this.#output.write(`${turn.observation}\n`);
    if (turn.previousResult !== undefined) {
      this.#output.write("\n=== Previous Ability Result ===\n");
      this.#output.write(`${turn.previousResult}\n`);
    }
  }

  #startSpinner(signal?: AbortSignal): void {
    this.#spinnerStartedAt = Date.now();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    const render = () => {
      const elapsed = ((Date.now() - this.#spinnerStartedAt) / 1000).toFixed(1);
      this.#output.write(`\r${frames[frame++ % frames.length]} Executing Ability (${elapsed}s)`);
    };
    render();
    this.#spinner = setInterval(render, 80);
    this.#spinner.unref();
    signal?.addEventListener("abort", () => { this.#stopSpinner("silent"); }, { once: true });
  }

  #stopSpinner(outcome: "settled" | "silent"): void {
    if (this.#spinner === undefined) return;
    clearInterval(this.#spinner);
    this.#spinner = undefined;
    if (outcome === "settled") {
      const elapsed = ((Date.now() - this.#spinnerStartedAt) / 1000).toFixed(1);
      this.#output.write(`\r✓ Ability settled (${elapsed}s)\n`);
    } else {
      this.#output.write("\r\u001b[2K");
    }
  }
}

export function createManualOperatorInteraction(): ManualOperatorInteraction {
  return new ManualOperatorInteraction();
}
