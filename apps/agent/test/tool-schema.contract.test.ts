import { describe, expect, it } from "vitest";

import {
  renderToolSchemaTypeScript,
  toolSchema as s,
} from "../src/harness/tool-schema.js";

describe("Tool Schema public contract", () => {
  it("drives validation, provider JSON Schema, and TypeScript from one bounded dialect", () => {
    const schema = s.object({
      id: s.field(s.string({ minLength: 3, maxLength: 64, pattern: "^[a-z]+:[a-z_]+$" }), {
        description: "Canonical registry identifier.",
        examples: ["minecraft:stone"],
      }),
      count: s.optional(s.integer({ minimum: 1, maximum: 64 }), {
        description: "Requested item count when more than one is needed.",
        default: 1,
        examples: [4],
      }),
      tags: s.field(s.array(s.string(), { minItems: 1, maxItems: 3, uniqueItems: true }), {
        description: "Distinct labels used to classify the request.",
      }),
      metadata: s.field(s.record(s.losslessJson()), {
        description: "Lossless JSON metadata keyed by a caller-owned name.",
      }),
      enabled: s.field(s.boolean(), { description: "Whether the request is active." }),
      mode: s.field(s.enumeration("fast", "safe"), { description: "Execution policy." }),
      version: s.field(s.literal(1), { description: "Contract version." }),
    });

    expect(schema.parse({
      id: "minecraft:stone",
      tags: ["solid"],
      metadata: { source: "test", nested: [true, null, 2] },
      enabled: true,
      mode: "safe",
      version: 1,
    })).toEqual({
      id: "minecraft:stone",
      tags: ["solid"],
      metadata: { source: "test", nested: [true, null, 2] },
      enabled: true,
      mode: "safe",
      version: 1,
    });
    expect(schema.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id", "tags", "metadata", "enabled", "mode", "version"],
      properties: {
        id: {
          type: "string",
          minLength: 3,
          maxLength: 64,
          pattern: "^[a-z]+:[a-z_]+$",
          description: "Canonical registry identifier.",
          examples: ["minecraft:stone"],
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description: "Requested item count when more than one is needed.",
          default: 1,
          examples: [4],
        },
      },
    });
    expect(renderToolSchemaTypeScript(schema)).toContain("readonly count?: number");
    expect(() => schema.parse({
      id: "stone",
      tags: ["same", "same"],
      metadata: {},
      enabled: true,
      mode: "safe",
      version: 1,
    })).toThrow();
  });

  it("requires exactly one oneOf branch and rejects deliberately overlapping shapes", () => {
    const shape = s.oneOf(
      s.branch(s.object({
        x: s.field(s.integer(), { description: "Horizontal block X coordinate." }),
      }), { title: "X coordinate", description: "Select a target by its X coordinate." }),
      s.branch(s.object({
        name: s.field(s.string(), { description: "Stable target name." }),
      }), { title: "Named target", description: "Select a target by name." }),
    );

    expect(shape.parse({ x: 4 })).toEqual({ x: 4 });
    expect(() => shape.parse({})).toThrow(/exactly one supported shape.*matched 0/u);
    expect(() => shape.parse({ x: 4, name: "home" })).toThrow(/matched 0/u);
    expect(shape.jsonSchema).toMatchObject({
      oneOf: [
        { title: "X coordinate", description: "Select a target by its X coordinate." },
        { title: "Named target", description: "Select a target by name." },
      ],
    });

    const overlappingNumbers = s.oneOf(
      s.branch(s.number(), { title: "Any number", description: "Accept a finite number." }),
      s.branch(s.integer(), { title: "Integer", description: "Accept a safe integer." }),
    );
    expect(() => overlappingNumbers.parse(2)).toThrow(/matched 2/u);
    expect(overlappingNumbers.parse(2.5)).toBe(2.5);

    const overlappingStrings = s.oneOf(
      s.branch(s.string(), { title: "Any text", description: "Accept arbitrary text." }),
      s.branch(s.enumeration("known"), { title: "Known text", description: "Accept the known literal." }),
    );
    expect(() => overlappingStrings.parse("known")).toThrow(/matched 2/u);
  });

  it("builds nullable schemas only when null is exclusive from the value branch", () => {
    const nullableString = s.nullable(s.string());

    expect(nullableString.parse("known")).toBe("known");
    expect(nullableString.parse(null)).toBeNull();
    expect(() => nullableString.parse(1)).toThrow(/exactly one supported shape/u);
    expect(() => s.nullable(s.losslessJson())).toThrow(/already accepts null/u);
  });

  it("projects safe-integer bounds, keeps defaults non-validating, and uses flagless patterns", () => {
    const schema = s.object({
      index: s.field(s.integer(), { description: "Safe integer index." }),
      query: s.optional(s.string({ pattern: "^(?:minecraft|mc_agent):" }), {
        description: "Optional canonical namespace prefix.",
        default: "MISSING:DEFAULT_IS_ONLY_DOCUMENTATION",
      }),
    });

    expect(schema.jsonSchema).toMatchObject({
      properties: {
        index: {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        query: { pattern: "^(?:minecraft|mc_agent):" },
      },
    });
    expect(schema.parse({ index: 1 })).toEqual({ index: 1 });
    expect(() => schema.parse({ index: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/u);
    expect(() => schema.parse({ index: 1, query: "Minecraft:stone" })).toThrow(/pattern/u);
    expect(() => s.string({ pattern: "[" })).toThrow(/valid JSON Schema pattern/u);
  });

  it("renders deterministic normalized and escaped field and branch JSDoc", () => {
    const schema = s.oneOf(
      s.branch(s.object({
        value: s.optional(s.losslessJson(), {
          description: "  Keep   a value that may contain */ safely. ",
          default: { z: 1, a: 2 },
          examples: [{ b: 2, a: 1 }, "plain"],
        }),
      }), {
        title: " Value branch ",
        description: " Uses   one documented value. ",
      }),
      s.branch(s.object({}), {
        title: "Empty branch",
        description: "Uses no input fields.",
      }),
    );

    const first = renderToolSchemaTypeScript(schema);
    expect(renderToolSchemaTypeScript(schema)).toBe(first);
    expect(first).toContain("Value branch. Uses one documented value.");
    expect(first).toContain("Keep a value that may contain * / safely.");
    expect(first).toContain('@default {"a":2,"z":1}');
    expect(first).toContain('@example {"a":1,"b":2}');
    expect(first).toContain('@example "plain"');
  });

  it("rejects invalid bounded-dialect constraints at authoring time", () => {
    expect(() => s.number({ minimum: 2, maximum: 1 })).toThrow(/minimum/u);
    expect(() => s.string({ minLength: -1 })).toThrow(/minLength/u);
    expect(() => s.array(s.string(), { minItems: 2, maxItems: 1 })).toThrow(/minItems/u);
    expect(() => s.enumeration("same", "same")).toThrow(/duplicate/u);
    expect(() => s.field(s.string(), { description: "   " })).toThrow(/description/u);
    expect(() => s.branch(s.string(), { title: "", description: "text" })).toThrow(/title/u);
    expect(() => s.record(s.string(), { minProperties: 1 } as never)).toThrow(/unsupported/u);
  });

});
