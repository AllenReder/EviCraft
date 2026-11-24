import { describe, expect, it } from "vitest";

import { AbilityRuntime } from "../src/harness/ability-runtime.js";
import { abilities } from "../src/harness/abilities/index.js";
import {
  analyzeManualTool,
  type ManualObjectNode,
} from "../src/harness/manual-input-schema.js";

describe("Manual Ability input schemas", () => {
  it("presents every top-level union branch as an Ability Input Preset", () => {
    const analyzed = analyzeManualTool({
      name: "goto",
      description: "Navigate",
      strict: false,
      inputSchema: {
        oneOf: [
          { ...object({ x: integer(), z: integer() }, ["x", "z"]), title: "Surface column" },
          { ...object({ x: integer(), y: integer(), z: integer() }, ["x", "y", "z"]), title: "Exact feet cell" },
          { ...object({ y: integer() }, ["y"]), title: "Elevation" },
          { ...object({ block_id_regex: { type: "string" } }, ["block_id_regex"]), title: "Remembered block" },
        ],
      },
    });

    expect(analyzed).toMatchObject({ supported: true });
    if (!analyzed.supported) throw new Error(analyzed.reason);
    expect(analyzed.presets.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "x,z", label: "Surface column" },
      { id: "x,y,z", label: "Exact feet cell" },
      { id: "y", label: "Elevation" },
      { id: "block_id_regex", label: "Remembered block" },
    ]);
  });

  it("recognizes named presets regardless of schema property order", () => {
    const analyzed = analyzeManualTool({
      name: "goto",
      description: "Navigate",
      inputSchema: {
        oneOf: [{ ...object({ z: integer(), x: integer() }, ["z", "x"]), title: "Surface column" }],
      },
    });

    if (!analyzed.supported) throw new Error(analyzed.reason);
    expect(analyzed.presets[0]).toMatchObject({ id: "x,z", label: "Surface column" });
  });

  it("retains nested fields, optional/default state, enums, patterns, ranges, and arrays", () => {
    const analyzed = analyzeManualTool({
      name: "sample",
      description: "Sample",
      inputSchema: object({
        position: object({ x: integer(), y: integer(), z: integer() }, ["x", "y", "z"]),
        direction: { type: "string", enum: ["north", "east", "south", "west"], default: "north" },
        uuids: {
          type: "array",
          items: { type: "string", pattern: "^[0-9a-f-]+$" },
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
        },
      }, ["position", "uuids"]),
      strict: false,
    });

    if (!analyzed.supported) throw new Error(analyzed.reason);
    const root = analyzed.presets[0]?.node as ManualObjectNode;
    expect(root.fields.map(({ name, required, defaultValue }) => ({ name, required, defaultValue }))).toEqual([
      { name: "position", required: true, defaultValue: undefined },
      { name: "direction", required: false, defaultValue: "north" },
      { name: "uuids", required: true, defaultValue: undefined },
    ]);
    expect(root.fields[0]?.node).toMatchObject({ kind: "object" });
    expect(root.fields[1]?.node).toMatchObject({ kind: "enum", values: ["north", "east", "south", "west"] });
    expect(root.fields[2]?.node).toMatchObject({
      kind: "array",
      minimumItems: 1,
      maximumItems: 8,
      uniqueItems: true,
      item: { kind: "string", pattern: "^[0-9a-f-]+$" },
    });
  });

  it("supports every currently registered Ability input without modifying Ability definitions", async () => {
    const runtime = new AbilityRuntime();
    for (const ability of abilities) await runtime.register(ability);

    const unsupported = runtime.modelTools()
      .map(analyzeManualTool)
      .filter((tool) => !tool.supported);

    expect(unsupported).toEqual([]);
  });

  it("disables an unsupported schema with an actionable path", () => {
    const analyzed = analyzeManualTool({
      name: "future_tool",
      description: "Future",
      inputSchema: { type: "object", additionalProperties: { type: "string" } },
    });

    expect(analyzed).toEqual({
      supported: false,
      name: "future_tool",
      description: "Future",
      reason: "future_tool input uses dynamic object keys, which Manual TUI does not support",
    });
  });
});

function integer() {
  return { type: "integer", minimum: -30_000_000, maximum: 30_000_000 } as const;
}

function object(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
) {
  return { type: "object", properties, required, additionalProperties: false } as const;
}
