import { PassThrough } from "node:stream";

import { input, number, search, select } from "@inquirer/prompts";
import { describe, expect, it, vi } from "vitest";

import { ManualOperatorInteraction } from "../src/harness/manual-operator-interaction.js";
import type { AgentToolProjection } from "../src/harness/model-surface-message.js";

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  number: vi.fn(),
  search: vi.fn(),
  select: vi.fn(),
}));

describe("Manual Operator Interaction", () => {
  it("chooses a named input preset, fills its form, and reviews the call", async () => {
    vi.mocked(search).mockImplementation(async (config) => {
      const choices = await config.source(undefined, { signal: new AbortController().signal });
      const first = choices[0];
      if (first === undefined || typeof first !== "object" || !("value" in first)) throw new Error("missing choice");
      return first.value;
    });
    vi.mocked(select).mockImplementation(async (config) => {
      if (config.message === "Choose an input preset") return config.choices[1]!.value;
      if (config.message === "goto.sprint") return "default";
      if (config.message === "Review Ability call") return "execute";
      throw new Error(`unexpected selection: ${config.message}`);
    });
    vi.mocked(number).mockResolvedValueOnce(1).mockResolvedValueOnce(64).mockResolvedValueOnce(2);
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
    const controller = new AbortController();
    const interaction = new ManualOperatorInteraction({ output });

    const selection = await interaction.choose({
      observation: "SELF position=(0,64,0)",
      previousResult: '{"ok":true}',
      tools: [gotoTool()],
    }, { signal: controller.signal });
    controller.abort();

    expect(selection).toEqual({
      toolName: "goto",
      input: { x: 1, y: 64, z: 2, sprint: true },
    });
    expect(rendered).toContain("Turn Observation");
    expect(rendered).toContain("Previous Ability Result");
  });

  it("supports adding, editing, and deleting array items", async () => {
    vi.mocked(search).mockImplementation(async (config) => {
      const choices = await config.source(undefined, { signal: new AbortController().signal });
      const first = choices[0];
      if (first === undefined || typeof first !== "object" || !("value" in first)) throw new Error("missing choice");
      return first.value;
    });
    const arrayActions = ["add", "edit", "delete", "done"];
    vi.mocked(select).mockImplementation(async (config) => {
      if (config.message === "Edit collect.items") return arrayActions.shift()!;
      if (config.message === "Choose an item to edit") return 0;
      if (config.message === "Choose an item to delete") return 1;
      if (config.message === "Review Ability call") return "execute";
      throw new Error(`unexpected selection: ${config.message}`);
    });
    vi.mocked(input)
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second")
      .mockResolvedValueOnce("edited");
    const output = new PassThrough();
    const controller = new AbortController();

    const selection = await new ManualOperatorInteraction({ output }).choose({
      observation: "observation",
      tools: [arrayTool()],
    }, { signal: controller.signal });
    controller.abort();

    expect(selection).toEqual({ toolName: "collect", input: { items: ["edited"] } });
  });

  it("accepts negative safe integers without Inquirer's imprecise default step validation", async () => {
    vi.mocked(search).mockImplementation(async (config) => {
      const choices = await config.source(undefined, { signal: new AbortController().signal });
      const first = choices[0];
      if (first === undefined || typeof first !== "object" || !("value" in first)) throw new Error("missing choice");
      return first.value;
    });
    vi.mocked(select).mockImplementation(async (config) => {
      if (config.message === "Review Ability call") return "execute";
      throw new Error(`unexpected selection: ${config.message}`);
    });
    vi.mocked(number).mockResolvedValueOnce(-46);
    const controller = new AbortController();

    const selection = await new ManualOperatorInteraction({ output: new PassThrough() }).choose({
      observation: "observation",
      tools: [unboundedIntegerTool()],
    }, { signal: controller.signal });
    controller.abort();

    expect(selection).toEqual({ toolName: "goto", input: { x: -46 } });
    const [config] = vi.mocked(number).mock.calls.at(-1) ?? [];
    expect(config).toMatchObject({
      message: "goto.x",
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
      step: "any",
    });
    expect(config?.validate?.(-46)).toBe(true);
    expect(config?.validate?.(1.5)).toBe("Must be a safe integer");
  });
});

function gotoTool(): AgentToolProjection {
  const coordinate = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  });
  return {
    name: "goto",
    description: "Move to a target",
    inputSchema: {
      oneOf: [
        coordinate({ x: { type: "number" }, z: { type: "number" } }, ["x", "z"]),
        coordinate({
          x: { type: "number" },
          y: { type: "integer" },
          z: { type: "number" },
          sprint: { type: "boolean", default: true },
        }, ["x", "y", "z"]),
      ],
    },
  };
}

function arrayTool(): AgentToolProjection {
  return {
    name: "collect",
    description: "Collect items",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
      },
    },
  };
}

function unboundedIntegerTool(): AgentToolProjection {
  return {
    name: "goto",
    description: "Move to a target",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: {
        x: {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
    },
  };
}
