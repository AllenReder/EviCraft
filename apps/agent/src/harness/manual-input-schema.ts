import type { AgentToolProjection } from "./model-surface-message.js";

export type ManualInputNode =
  | ManualObjectNode
  | ManualArrayNode
  | ManualStringNode
  | ManualNumberNode
  | ManualBooleanNode
  | ManualEnumNode
  | ManualLiteralNode;

export interface ManualObjectNode {
  readonly kind: "object";
  readonly fields: readonly ManualObjectField[];
}

export interface ManualObjectField {
  readonly name: string;
  readonly required: boolean;
  readonly defaultValue?: unknown;
  readonly node: ManualInputNode;
}

export interface ManualArrayNode {
  readonly kind: "array";
  readonly item: ManualInputNode;
  readonly minimumItems?: number;
  readonly maximumItems?: number;
  readonly uniqueItems: boolean;
}

export interface ManualStringNode {
  readonly kind: "string";
  readonly pattern?: string;
}

export interface ManualNumberNode {
  readonly kind: "number" | "integer";
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ManualBooleanNode {
  readonly kind: "boolean";
}

export interface ManualEnumNode {
  readonly kind: "enum";
  readonly values: readonly string[];
}

export interface ManualLiteralNode {
  readonly kind: "literal";
  readonly value: string | number | boolean | null;
}

export interface ManualInputPreset {
  readonly id: string;
  readonly label: string;
  readonly node: ManualInputNode;
}

export type ManualToolAnalysis =
  | Readonly<{
      supported: true;
      name: string;
      description: string;
      presets: readonly ManualInputPreset[];
    }>
  | Readonly<{
      supported: false;
      name: string;
      description: string;
      reason: string;
    }>;

export function analyzeManualTool(tool: AgentToolProjection): ManualToolAnalysis {
  try {
    const branches = arrayValue(tool.inputSchema.oneOf);
    const schemas = branches ?? [tool.inputSchema];
    const presets = schemas.map((schema, index) => {
      const object = record(schema, `${tool.name} input preset ${index + 1}`);
      const id = presetId(object, index);
      return {
        id,
        label: branchTitle(object) ?? genericPresetLabel(object, index),
        node: analyzeNode(object, `${tool.name} input`),
      } satisfies ManualInputPreset;
    });
    return { supported: true, name: tool.name, description: tool.description, presets };
  } catch (error) {
    return {
      supported: false,
      name: tool.name,
      description: tool.description,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function analyzeNode(schema: Readonly<Record<string, unknown>>, path: string): ManualInputNode {
  if (Object.hasOwn(schema, "const")) {
    const value = schema.const;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { kind: "literal", value };
    }
    throw new Error(`${path} uses a non-scalar literal, which Manual TUI does not support`);
  }
  const enumeration = arrayValue(schema.enum);
  if (enumeration !== undefined) {
    if (!enumeration.every((value): value is string => typeof value === "string")) {
      throw new Error(`${path} uses a non-string enum, which Manual TUI does not support`);
    }
    return { kind: "enum", values: enumeration };
  }
  const type = schema.type;
  if (type === "string") {
    const pattern = schema.pattern;
    if (pattern !== undefined && typeof pattern !== "string") throw new Error(`${path}.pattern must be a string`);
    return { kind: "string", ...(pattern === undefined ? {} : { pattern }) };
  }
  if (type === "number" || type === "integer") {
    const minimum = finiteNumber(schema.minimum, `${path}.minimum`);
    const maximum = finiteNumber(schema.maximum, `${path}.maximum`);
    return {
      kind: type,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    };
  }
  if (type === "boolean") return { kind: "boolean" };
  if (type === "array") {
    const items = record(schema.items, `${path}.items`);
    const minimumItems = nonNegativeInteger(schema.minItems, `${path}.minItems`);
    const maximumItems = nonNegativeInteger(schema.maxItems, `${path}.maxItems`);
    return {
      kind: "array",
      item: analyzeNode(items, `${path}[]`),
      ...(minimumItems === undefined ? {} : { minimumItems }),
      ...(maximumItems === undefined ? {} : { maximumItems }),
      uniqueItems: schema.uniqueItems === true,
    };
  }
  if (type === "object") {
    if (schema.additionalProperties !== false && schema.additionalProperties !== undefined) {
      throw new Error(`${path} uses dynamic object keys, which Manual TUI does not support`);
    }
    const properties = schema.properties === undefined ? {} : record(schema.properties, `${path}.properties`);
    const required = new Set(stringArray(schema.required, `${path}.required`));
    return {
      kind: "object",
      fields: Object.entries(properties).map(([name, value]) => {
        const property = record(value, `${path}.${name}`);
        return {
          name,
          required: required.has(name),
          ...(Object.hasOwn(property, "default") ? { defaultValue: property.default } : {}),
          node: analyzeNode(property, `${path}.${name}`),
        };
      }),
    };
  }
  if (schema.oneOf !== undefined) {
    throw new Error(`${path} uses a nested union, which Manual TUI does not support`);
  }
  throw new Error(`${path} has no supported scalar, array, or object type`);
}

function presetId(schema: Readonly<Record<string, unknown>>, index: number): string {
  if (schema.type !== "object") return `preset-${index + 1}`;
  const properties = schema.properties;
  if (properties === undefined || properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return `preset-${index + 1}`;
  }
  const names = Object.keys(properties).sort();
  return names.length === 0 ? "empty" : names.join(",");
}

function genericPresetLabel(schema: Readonly<Record<string, unknown>>, index: number): string {
  const id = presetId(schema, index);
  if (id === "empty") return "No input";
  if (id.startsWith("preset-")) return `Preset ${index + 1}`;
  return id.split(",").join(" + ");
}

function branchTitle(schema: Readonly<Record<string, unknown>>): string | undefined {
  return typeof schema.title === "string" && schema.title.trim() !== "" ? schema.title.trim() : undefined;
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function arrayValue(value: unknown): readonly unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Manual input union must be an array");
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`${path} must be a string array`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite`);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${path} must be a non-negative integer`);
  return Number(value);
}
