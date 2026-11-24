/**
 * Bounded Tool Schema dialect inspired by DeepSeek Harness commit
 * 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca. This is a local,
 * provider-neutral implementation rather than a runtime dependency.
 */

export type JsonScalar = string | number | boolean | null;

export interface SchemaAnnotation {
  readonly description?: string;
  readonly title?: string;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
}

export type ToolSchemaNode = Readonly<Record<string, unknown>>;

export interface ToolSchema<Value> {
  readonly dialect: ToolSchemaNode;
  readonly jsonSchema: ToolSchemaNode;
  parse(value: unknown, path?: string): Value;
}

export type InferToolSchema<Schema extends ToolSchema<unknown>> =
  Schema extends ToolSchema<infer Value> ? Value : never;

export class ToolSchemaValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolSchemaValidationError";
  }
}

export interface FieldAnnotation<Value = unknown> {
  readonly description: string;
  readonly default?: Value;
  readonly examples?: readonly Value[];
}

export interface BranchAnnotation {
  readonly title: string;
  readonly description: string;
}

type ToolField<Value, Optional extends boolean> = Readonly<{
  field: true;
  optional: Optional;
  schema: ToolSchema<Value>;
  annotation: FieldAnnotation<Value>;
}>;

type ToolBranch<Value> = Readonly<{
  branch: true;
  schema: ToolSchema<Value>;
  annotation: BranchAnnotation;
}>;

type ObjectFields = Readonly<Record<string, ToolField<unknown, boolean>>>;
type ObjectValue<Fields extends ObjectFields> = {
  readonly [Key in keyof Fields as Fields[Key] extends ToolField<unknown, true> ? never : Key]:
    Fields[Key] extends ToolField<infer Value, boolean> ? Value : never;
} & {
  readonly [Key in keyof Fields as Fields[Key] extends ToolField<unknown, true> ? Key : never]?:
    Fields[Key] extends ToolField<infer Value, boolean> ? Value : never;
};

interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

interface NumberOptions {
  readonly minimum?: number;
  readonly maximum?: number;
}

interface ArrayOptions {
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
}

export const toolSchema = Object.freeze({
  string(options: StringOptions = {}): ToolSchema<string> {
    assertLengthBounds(options.minLength, options.maxLength, "string");
    if (options.pattern !== undefined) {
      try { new RegExp(options.pattern); }
      catch (error) {
        throw new ToolSchemaValidationError(`pattern must be a valid JSON Schema pattern: ${errorMessage(error)}`);
      }
    }
    return createSchema({ type: "string", ...options }, (value, path) => {
      if (typeof value !== "string") fail(`${path} must be a string`);
      const length = [...value].length;
      if (options.minLength !== undefined && length < options.minLength) {
        fail(`${path} must contain at least ${options.minLength} characters`);
      }
      if (options.maxLength !== undefined && length > options.maxLength) {
        fail(`${path} must contain at most ${options.maxLength} characters`);
      }
      if (options.pattern !== undefined && !new RegExp(options.pattern).test(value)) {
        fail(`${path} must match pattern ${options.pattern}`);
      }
      return value;
    });
  },

  number(options: NumberOptions = {}): ToolSchema<number> {
    assertNumericBounds(options, "number");
    return createSchema({ type: "number", ...options }, (value, path) => {
      if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a finite number`);
      assertValueBounds(value, options, path);
      return value;
    });
  },

  integer(options: NumberOptions = {}): ToolSchema<number> {
    assertNumericBounds(options, "integer", true);
    const minimum = Math.max(options.minimum ?? Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
    const maximum = Math.min(options.maximum ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    return createSchema({ type: "integer", minimum, maximum }, (value, path) => {
      if (!Number.isSafeInteger(value)) fail(`${path} must be a safe integer`);
      assertValueBounds(Number(value), { minimum, maximum }, path);
      return Number(value);
    });
  },

  boolean(): ToolSchema<boolean> {
    return createSchema({ type: "boolean" }, (value, path) => {
      if (typeof value !== "boolean") fail(`${path} must be a boolean`);
      return value;
    });
  },

  literal<const Value extends JsonScalar>(value: Value): ToolSchema<Value> {
    assertJsonValue(value, "literal");
    return createSchema({ const: value }, (input, path) => {
      if (!deepEqual(input, value)) fail(`${path} must equal ${stableJson(value)}`);
      return value;
    });
  },

  enumeration<const Values extends readonly [JsonScalar, ...JsonScalar[]]>(
    ...values: Values
  ): ToolSchema<Values[number]> {
    const keys = values.map((value) => stableJson(value));
    if (new Set(keys).size !== keys.length) {
      throw new ToolSchemaValidationError("enum must not contain duplicate values");
    }
    return createSchema({ enum: [...values] }, (input, path) => {
      const index = values.findIndex((value) => deepEqual(input, value));
      if (index < 0) fail(`${path} must be one of ${keys.join(", ")}`);
      return values[index]!;
    });
  },

  array<Value>(item: ToolSchema<Value>, options: ArrayOptions = {}): ToolSchema<readonly Value[]> {
    assertLengthBounds(options.minItems, options.maxItems, "array");
    return createSchema({ type: "array", items: item.dialect, ...options }, (value, path) => {
      if (!Array.isArray(value)) fail(`${path} must be an array`);
      if (options.minItems !== undefined && value.length < options.minItems) {
        fail(`${path} must contain at least ${options.minItems} items`);
      }
      if (options.maxItems !== undefined && value.length > options.maxItems) {
        fail(`${path} must contain at most ${options.maxItems} items`);
      }
      const parsed = value.map((entry, index) => item.parse(entry, `${path}[${index}]`));
      if (options.uniqueItems === true) {
        const serialized = parsed.map((entry, index) => stableJson(assertJsonValue(entry, `${path}[${index}]`)));
        if (new Set(serialized).size !== serialized.length) fail(`${path} must contain unique items`);
      }
      return parsed;
    });
  },

  object<const Fields extends ObjectFields>(fields: Fields): ToolSchema<ObjectValue<Fields>> {
    const entries = Object.entries(fields);
    for (const [name, field] of entries) {
      if (!isField(field)) throw new ToolSchemaValidationError(`object property ${name} must use field() or optional()`);
    }
    const properties = Object.fromEntries(entries.map(([name, field]) => [
      name,
      annotateNode(field.schema.dialect, field.annotation),
    ]));
    const required = entries.filter(([, field]) => !field.optional).map(([name]) => name);
    return createSchema({ type: "object", properties, required, additionalProperties: false }, (value, path) => {
      if (!isPlainObject(value)) fail(`${path} must be an object`);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(fields, key)) fail(`${path}.${key} is not supported`);
      }
      const output: Record<string, unknown> = {};
      for (const [name, field] of entries) {
        if (!Object.hasOwn(value, name)) {
          if (field.optional) continue;
          fail(`${path}.${name} is required`);
        }
        output[name] = field.schema.parse(value[name], `${path}.${name}`);
      }
      return output as ObjectValue<Fields>;
    });
  },

  record<Value>(
    valueSchema: ToolSchema<Value>,
    ...unsupported: readonly never[]
  ): ToolSchema<Readonly<Record<string, Value>>> {
    if (unsupported.length > 0) throw new ToolSchemaValidationError("record options are unsupported by this dialect");
    return createSchema({ type: "object", additionalProperties: valueSchema.dialect }, (value, path) => {
      if (!isPlainObject(value)) fail(`${path} must be an object`);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        valueSchema.parse(entry, `${path}.${key}`),
      ]));
    });
  },

  losslessJson(): ToolSchema<unknown> {
    return createSchema({}, (value, path) => assertJsonValue(value, path));
  },

  field<Value>(schema: ToolSchema<Value>, annotation: FieldAnnotation<Value>): ToolField<Value, false> {
    assertFieldAnnotation(annotation);
    return Object.freeze({ field: true, optional: false, schema, annotation });
  },

  optional<Value>(schema: ToolSchema<Value>, annotation: FieldAnnotation<Value>): ToolField<Value, true> {
    assertFieldAnnotation(annotation);
    return Object.freeze({ field: true, optional: true, schema, annotation });
  },

  branch<Value>(schema: ToolSchema<Value>, annotation: BranchAnnotation): ToolBranch<Value> {
    assertNonBlank(annotation.title, "branch title");
    assertNonBlank(annotation.description, "branch description");
    return Object.freeze({ branch: true, schema, annotation });
  },

  oneOf<const Branches extends readonly [ToolBranch<unknown>, ...ToolBranch<unknown>[]]>(
    ...branches: Branches
  ): ToolSchema<InferBranch<Branches[number]>> {
    const dialect = {
      oneOf: branches.map((branch) => annotateNode(branch.schema.dialect, branch.annotation)),
    };
    return createSchema(dialect, (value, path) => {
      const matches: unknown[] = [];
      const errors: string[] = [];
      for (const branch of branches) {
        try { matches.push(branch.schema.parse(value, path)); }
        catch (error) { errors.push(errorMessage(error)); }
      }
      if (matches.length !== 1) {
        fail(`${path} must match exactly one supported shape; matched ${matches.length}: ${errors.join("; ")}`);
      }
      return matches[0] as InferBranch<Branches[number]>;
    });
  },

  nullable<Value>(schema: ToolSchema<Value>): ToolSchema<Value | null> {
    let acceptsNull = true;
    try { schema.parse(null, "nullable value"); }
    catch { acceptsNull = false; }
    if (acceptsNull) {
      throw new ToolSchemaValidationError("nullable value schema already accepts null");
    }
    return this.oneOf(
      this.branch(schema, { title: "Value", description: "Use the documented non-null value." }),
      this.branch(this.literal(null), { title: "Null", description: "No value is available." }),
    );
  },
});

type InferBranch<Branch> = Branch extends ToolBranch<infer Value> ? Value : never;

export function renderToolSchemaTypeScript(schema: ToolSchema<unknown>): string {
  return renderNode(schema.dialect, 0);
}

function createSchema<Value>(
  dialect: ToolSchemaNode,
  parser: (value: unknown, path: string) => Value,
): ToolSchema<Value> {
  const frozen = deepFreeze(cloneJsonObject(dialect));
  const schema: ToolSchema<Value> = {
    dialect: frozen,
    jsonSchema: frozen,
    parse(value, path = "value") { return parser(value, path); },
  };
  return Object.freeze(schema);
}

function annotateNode(node: ToolSchemaNode, annotation: SchemaAnnotation): ToolSchemaNode {
  return {
    ...node,
    ...("title" in annotation ? { title: normalizeWhitespace(annotation.title ?? "") } : {}),
    ...("description" in annotation ? { description: normalizeWhitespace(annotation.description ?? "") } : {}),
    ...(Object.hasOwn(annotation, "default")
      ? { default: assertJsonValue(annotation.default, "schema default") }
      : {}),
    ...(annotation.examples === undefined
      ? {}
      : { examples: annotation.examples.map((example, index) => assertJsonValue(example, `schema example ${index + 1}`)) }),
  };
}

function renderNode(node: ToolSchemaNode, depth: number): string {
  if (Object.hasOwn(node, "const")) return stableJson(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(stableJson).join(" | ");
  if (Array.isArray(node.oneOf)) {
    return node.oneOf.map((branch) => {
      const schema = asRecord(branch, "oneOf branch");
      const doc = branchDoc(schema, depth + 1);
      return `(${doc}${renderNode(withoutAnnotations(schema), depth + 1)})`;
    }).join(" | ");
  }
  if (node.type === "string") return "string";
  if (node.type === "number" || node.type === "integer") return "number";
  if (node.type === "boolean") return "boolean";
  if (node.type === "array") {
    return `readonly (${renderNode(asRecord(node.items, "array items"), depth)})[]`;
  }
  if (node.type === "object") {
    if (node.properties !== undefined) {
      const properties = asRecord(node.properties, "object properties");
      const entries = Object.entries(properties);
      if (entries.length === 0) return "{}";
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const indent = "  ".repeat(depth);
      const childIndent = "  ".repeat(depth + 1);
      const members = entries.map(([name, value]) => {
        const property = asRecord(value, `property ${name}`);
        const key = isIdentifier(name) ? name : stableJson(name);
        return `${renderJSDoc(property, depth + 1)}${childIndent}readonly ${key}${required.has(name) ? "" : "?"}: ${renderNode(withoutAnnotations(property), depth + 1)};`;
      });
      return `{\n${members.join("\n")}\n${indent}}`;
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      return `{ readonly [key: string]: ${renderNode(asRecord(node.additionalProperties, "record value"), depth + 1)} }`;
    }
    return "{}";
  }
  if (Object.keys(withoutAnnotations(node)).length === 0) return "unknown";
  throw new ToolSchemaValidationError(`cannot render unsupported Tool Schema node ${stableJson(node)}`);
}

function branchDoc(node: ToolSchemaNode, depth: number): string {
  const title = typeof node.title === "string" ? normalizeWhitespace(node.title) : "";
  const description = typeof node.description === "string" ? normalizeWhitespace(node.description) : "";
  const combined = [sentence(title), description].filter((value) => value !== "").join(" ");
  return combined === "" ? "" : `${jsDoc([combined], depth)}\n${"  ".repeat(depth)}`;
}

function renderJSDoc(node: ToolSchemaNode, depth: number): string {
  const lines: string[] = [];
  if (typeof node.description === "string") lines.push(normalizeWhitespace(node.description));
  if (Object.hasOwn(node, "default")) lines.push(`@default ${stableJson(node.default)}`);
  if (Array.isArray(node.examples)) {
    lines.push(...node.examples.map((example) => `@example ${stableJson(example)}`));
  }
  return lines.length === 0 ? "" : `${jsDoc(lines, depth)}\n`;
}

function jsDoc(lines: readonly string[], depth: number): string {
  const indent = "  ".repeat(depth);
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line.replaceAll("*/", "* /")}`),
    `${indent} */`,
  ].join("\n");
}

function withoutAnnotations(node: ToolSchemaNode): ToolSchemaNode {
  const { title: _title, description: _description, default: _default, examples: _examples, ...schema } = node;
  return schema;
}

function assertFieldAnnotation(annotation: FieldAnnotation<unknown>): void {
  assertNonBlank(annotation.description, "field description");
  if (Object.hasOwn(annotation, "default")) assertJsonValue(annotation.default, "field default");
  annotation.examples?.forEach((example, index) => assertJsonValue(example, `field example ${index + 1}`));
}

function assertNonBlank(value: string, name: string): void {
  if (normalizeWhitespace(value) === "") throw new ToolSchemaValidationError(`${name} must be non-empty`);
}

function assertNumericBounds(options: NumberOptions, name: string, integer = false): void {
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ToolSchemaValidationError(`${name} ${key} must be finite`);
    }
    if (integer && !Number.isSafeInteger(value)) {
      throw new ToolSchemaValidationError(`${name} ${key} must be a safe integer`);
    }
  }
  if (options.minimum !== undefined && options.maximum !== undefined && options.minimum > options.maximum) {
    throw new ToolSchemaValidationError(`${name} minimum must not exceed maximum`);
  }
}

function assertLengthBounds(minimum: number | undefined, maximum: number | undefined, name: string): void {
  for (const [key, value] of [[name === "string" ? "minLength" : "minItems", minimum], [name === "string" ? "maxLength" : "maxItems", maximum]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ToolSchemaValidationError(`${key} must be a non-negative safe integer`);
    }
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new ToolSchemaValidationError(`${name === "string" ? "minLength" : "minItems"} must not exceed ${name === "string" ? "maxLength" : "maxItems"}`);
  }
}

function assertValueBounds(value: number, options: NumberOptions, path: string): void {
  if (options.minimum !== undefined && value < options.minimum) fail(`${path} must be at least ${options.minimum}`);
  if (options.maximum !== undefined && value > options.maximum) fail(`${path} must be at most ${options.maximum}`);
}

function assertJsonValue(value: unknown, path: string, ancestors: Set<object> = new Set()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object") {
    if (ancestors.has(value)) fail(`${path} contains a cycle and is not lossless JSON`);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry, index) => assertJsonValue(entry, `${path}[${index}]`, ancestors));
      }
      if (!isPlainObject(value)) fail(`${path} is not lossless JSON`);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        assertJsonValue(entry, `${path}.${key}`, ancestors),
      ]));
    } finally {
      ancestors.delete(value);
    }
  }
  fail(`${path} is not lossless JSON`);
}

function cloneJsonObject(value: ToolSchemaNode): ToolSchemaNode {
  return assertJsonValue(value, "Tool Schema") as ToolSchemaNode;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(assertJsonValue(value, "JSON value")));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  try { return stableJson(left) === stableJson(right); }
  catch { return false; }
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function sentence(value: string): string {
  if (value === "" || /[.!?]$/u.test(value)) return value;
  return `${value}.`;
}

function isField(value: unknown): value is ToolField<unknown, boolean> {
  return isPlainObject(value) && value.field === true && typeof value.optional === "boolean";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asRecord(value: unknown, path: string): ToolSchemaNode {
  if (!isPlainObject(value)) throw new ToolSchemaValidationError(`${path} must be an object`);
  return value;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message: string): never {
  throw new ToolSchemaValidationError(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
