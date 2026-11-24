import { randomUUID } from "node:crypto";

import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";
import { getGlobalDispatcher } from "undici";

import type { HarnessSecrets, ModelProvider } from "./config.js";

/** Model Session's AbortSignal owns the deadline, including retries and body reads. */
const modelFetch: typeof globalThis.fetch = (input, init) => {
  // Compose over the existing transport: preserve its pools/proxy configuration
  // without changing global defaults or creating a separately owned connection pool.
  const dispatcher = getGlobalDispatcher().compose(dispatch => (options, handler) =>
    dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler));
  // Node and undici publish separate dispatcher types; pass the runtime extension
  // without coupling their independently versioned declarations.
  const options: RequestInit = { ...init };
  Object.assign(options, { dispatcher });
  return globalThis.fetch(input, options);
};

/**
 * Explicit protocol features a Provider route supports, declared once per Adapter.
 * `toolChoice` is consumed by the Model Session; `protocol` selects the adapter
 * implementation for openai-compatible routes; `reasoning`, `strictToolSchema`,
 * and `parallelToolCalls` are declarative — the adapter's `createModel` already
 * encodes them in SDK settings (e.g. Responses middleware, Chat Completions
 * provider options). They exist so callers can inspect a route's capabilities
 * without parsing adapter internals.
 */
export interface ModelProviderCapabilities {
  readonly toolChoice: "auto" | "required";
  readonly protocol: "chat-completions" | "responses";
  readonly reasoning: Readonly<{
    kind: "encrypted_content" | "reasoning_content" | "reasoning_effort_field" | "none";
    effortField?: string;
  }>;
  readonly strictToolSchema: boolean;
  readonly parallelToolCalls: boolean;
}

/** One Provider route's owner of model construction and capability declaration. */
export interface ModelProviderAdapter<Route extends ModelProvider = ModelProvider> {
  readonly provider: Route["provider"];
  readonly capabilities: ModelProviderCapabilities;
  createModel(route: Route, secrets: HarnessSecrets): LanguageModel;
}

/**
 * Stateless Responses settings shared by the OpenAI and OpenAI-compatible Responses adapters.
 * The per-model cache key keeps one Harness Run on one route; without it, relays often miss the cache entirely.
 */
function responsesSettingsMiddleware(reasoningEffort: string | undefined) {
  return defaultSettingsMiddleware({ settings: { providerOptions: { openai: {
    store: false,
    include: ["reasoning.encrypted_content"],
    parallelToolCalls: false,
    promptCacheKey: randomUUID(),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  } } } });
}

const openAiAdapter: ModelProviderAdapter<Extract<ModelProvider, { provider: "openai" }>> = {
  provider: "openai",
  capabilities: {
    toolChoice: "required",
    protocol: "responses",
    reasoning: { kind: "encrypted_content" },
    strictToolSchema: true,
    parallelToolCalls: false,
  },
  createModel(route, secrets) {
    // Model Surface owns history, including compaction; never depend on stored item references.
    return wrapLanguageModel({
      model: createOpenAI({ apiKey: requiredApiKey(secrets.modelApiKey, "OPENAI_API_KEY"), fetch: modelFetch }).responses(route.model),
      middleware: responsesSettingsMiddleware(route.reasoningEffort),
    });
  },
};

const deepSeekAdapter: ModelProviderAdapter<Extract<ModelProvider, { provider: "deepseek" }>> = {
  provider: "deepseek",
  capabilities: {
    toolChoice: "auto",
    protocol: "chat-completions",
    reasoning: { kind: "reasoning_content" },
    strictToolSchema: false,
    parallelToolCalls: false,
  },
  createModel(route, secrets) {
    return createDeepSeek({ apiKey: requiredApiKey(secrets.modelApiKey, "DEEPSEEK_API_KEY"), fetch: modelFetch })(route.model);
  },
};

/**
 * Moonshot (Kimi) backends validate tool parameters as "moonshot flavored json schema" and reject
 * `enum` / `const` nodes that carry no `type`. Harness tool schemas keep those nodes untyped, so only
 * Kimi routes get the type added on the wire; every other route sends the schemas unchanged.
 */
function requiresTypedToolSchemas(route: Extract<ModelProvider, { provider: "openai-compatible" }>): boolean {
  return route.model.toLowerCase().includes("kimi");
}

function scalarJsonType(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return undefined;
}

function inferredType(values: readonly unknown[]): string | readonly string[] | undefined {
  const types = values.map(scalarJsonType);
  if (types.some((type) => type === undefined)) return undefined;
  const distinct = [...new Set(types as string[])];
  if (distinct.length === 1) return distinct[0];
  // integer and number mix into number; any other mix needs a union.
  if (distinct.every((type) => type === "integer" || type === "number")) return "number";
  return distinct;
}

function withTypedSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withTypedSchema);
  if (node === null || typeof node !== "object") return node;
  const entries = Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, withTypedSchema(value)] as const);
  const typed: Record<string, unknown> = Object.fromEntries(entries);
  if (typed.type === undefined) {
    const values = Array.isArray(typed.enum) ? typed.enum : Object.hasOwn(typed, "const") ? [typed.const] : undefined;
    const type = values === undefined ? undefined : inferredType(values);
    if (type !== undefined) return { type, ...typed };
  }
  return typed;
}

/** Adds the JSON Schema `type` that Moonshot requires to each tool definition's parameters. */
function withTypedToolSchemas(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.tools)) return body;
  return { ...body, tools: body.tools.map((tool) => {
    if (tool === null || typeof tool !== "object") return tool;
    const definition = tool as { function?: { parameters?: unknown } };
    if (definition.function?.parameters === undefined) return tool;
    return { ...definition, function: { ...definition.function, parameters: withTypedSchema(definition.function.parameters) } };
  }) };
}

const openAiCompatibleChatAdapter: ModelProviderAdapter<Extract<ModelProvider, { provider: "openai-compatible" }>> = {
  provider: "openai-compatible",
  capabilities: {
    toolChoice: "required",
    protocol: "chat-completions",
    reasoning: { kind: "reasoning_effort_field", effortField: "reasoning_effort" },
    strictToolSchema: false,
    parallelToolCalls: false,
  },
  createModel(route, secrets) {
    const transforms: Array<(body: Record<string, unknown>) => Record<string, unknown>> = [];
    if (route.reasoningEffort !== undefined) {
      transforms.push((body) => ({ ...body, reasoning_effort: route.reasoningEffort }));
    }
    if (requiresTypedToolSchemas(route)) transforms.push(withTypedToolSchemas);
    return createOpenAICompatible({
      fetch: modelFetch,
      name: route.name,
      baseURL: route.baseUrl,
      includeUsage: true,
      ...(transforms.length === 0 ? {} : {
        transformRequestBody: (body: Record<string, unknown>) => transforms.reduce((current, transform) => transform(current), body),
      }),
      ...(secrets.modelApiKey === undefined ? {} : { apiKey: secrets.modelApiKey }),
    }).chatModel(route.model);
  },
};

const openAiCompatibleResponsesAdapter: ModelProviderAdapter<Extract<ModelProvider, { provider: "openai-compatible" }>> = {
  provider: "openai-compatible",
  capabilities: {
    toolChoice: "required",
    protocol: "responses",
    reasoning: { kind: "encrypted_content" },
    strictToolSchema: true,
    parallelToolCalls: false,
  },
  createModel(route, secrets) {
    return wrapLanguageModel({
      model: createOpenAI({
        fetch: modelFetch,
        name: route.name,
        baseURL: route.baseUrl,
        ...(secrets.modelApiKey === undefined ? {} : { apiKey: secrets.modelApiKey }),
      }).responses(route.model),
      middleware: responsesSettingsMiddleware(route.reasoningEffort),
    });
  },
};

const adapters = {
  openai: openAiAdapter,
  deepseek: deepSeekAdapter,
} as const;

/** Returns the Adapter registered for one serializable Model Provider route. */
export function modelProviderAdapter(route: ModelProvider): ModelProviderAdapter {
  if (route.provider === "openai-compatible") {
    if (route.protocol === "responses") return openAiCompatibleResponsesAdapter;
    // Bailian Qwen thinking mode rejects tool_choice=required (HTTP 400).
    if (route.name === "aliyun-bailian" && route.model.startsWith("qwen3.8-") && route.reasoningEffort !== undefined) {
      return { ...openAiCompatibleChatAdapter,
        capabilities: { ...openAiCompatibleChatAdapter.capabilities, toolChoice: "auto" } };
    }
    return openAiCompatibleChatAdapter;
  }
  return adapters[route.provider] as ModelProviderAdapter;
}

function requiredApiKey(apiKey: string | undefined, name: string): string {
  if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error(`${name} must be supplied through the environment`);
  return apiKey;
}
