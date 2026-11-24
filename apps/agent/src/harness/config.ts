import { randomBytes } from "node:crypto";

export const DEFAULT_RUNTIME_URL = "ws://127.0.0.1:8765/rpc";

export type ToolMode = "code" | "native";
export type AbilitySetMode = "profile-default" | "shared";
export interface ModelLimits {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  /** Whole-call deadline, including retries; defaults to 2 hours. */
  readonly requestTimeoutMs?: number;
  /** Time to the first semantic output in each attempt; defaults to 10 minutes. */
  readonly firstOutputTimeoutMs?: number;
  /** Maximum gap between semantic outputs; defaults to 2 hours. */
  readonly outputIdleTimeoutMs?: number;
  /** Retries after the first attempt for transient_http, connection, and timeout failures; defaults to 30. */
  readonly retries?: number;
  /** Cap on the exponential backoff (2 s, 4 s, 8 s, ...) between attempts; defaults to 60 s. Retry-After hints are not capped by it. */
  readonly retryMaxDelayMs?: number;
}

/** Serializable Provider routes. Each branch owns its credentials and transport defaults. */
export type ModelProvider =
  | Readonly<{
    provider: "openai";
    model: string;
    limits: ModelLimits;
    reasoningEffort?: string;
  }>
  | Readonly<{
    provider: "deepseek";
    model: string;
    limits: ModelLimits;
  }>
  | Readonly<{
    provider: "openai-compatible";
    name: string;
    model: string;
    baseUrl: string;
    protocol: "chat-completions" | "responses";
    limits: ModelLimits;
    reasoningEffort?: string;
    apiKeyEnvironmentVariable?: string;
  }>;

export interface HarnessConfig {
  readonly mode: ToolMode;
  readonly abilitySet: AbilitySetMode;
  readonly runtime: Readonly<{
    url: string;
    connectTimeoutMs: number;
  }>;
  readonly bot: Readonly<{
    username: string;
  }>;
  readonly model: ModelProvider;
  readonly data: Readonly<{
    directory: string;
  }>;
  readonly artifacts: Readonly<{
    directory: string;
    runLabel: string;
  }>;
  /** Enables the first-person `capture_view` control; requires a camera client attached to the World Run. */
  readonly vision?: Readonly<{
    /** Most recent captured images kept as images in model requests; older ones become placeholders. */
    retainedImages: number;
  }>;
}

export interface HarnessSecrets {
  readonly modelApiKey?: string;
  readonly runtimeBearerToken?: string;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Validates an immutable Harness configuration before any external connection is attempted. */
export function validateHarnessConfig(input: unknown): HarnessConfig {
  const value = object(input, "config");
  rejectUnknown(value, ["mode", "abilitySet", "runtime", "bot", "model", "data", "artifacts", "vision"], "config");

  const mode = toolMode(value.mode);
  const abilitySet = value.abilitySet === undefined ? "shared" : value.abilitySet;
  if (abilitySet !== "profile-default" && abilitySet !== "shared") {
    throw new ConfigurationError("config.abilitySet must be profile-default or shared");
  }
  const runtimeValue = optionalObject(value.runtime, "config.runtime");
  rejectUnknown(runtimeValue, ["url", "connectTimeoutMs"], "config.runtime");
  const runtimeUrl = validUrl(
    optionalString(runtimeValue.url, DEFAULT_RUNTIME_URL, "config.runtime.url"),
    ["ws:", "wss:"],
    "config.runtime.url",
  );
  const connectTimeoutMs = optionalPositiveInteger(runtimeValue.connectTimeoutMs, "config.runtime.connectTimeoutMs") ?? 120_000;

  const botValue = optionalObject(value.bot, "config.bot");
  rejectUnknown(botValue, ["username"], "config.bot");
  const username = optionalString(botValue.username, "bot", "config.bot.username");
  if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
    throw new ConfigurationError("config.bot.username must be a Minecraft username");
  }


  const modelValue = object(value.model, "config.model");
  const model = modelProvider(modelValue);

  const dataValue = optionalObject(value.data, "config.data");
  rejectUnknown(dataValue, ["directory"], "config.data");
  const dataDirectory = optionalString(dataValue.directory, "./data", "config.data.directory");

  const artifactsValue = optionalObject(value.artifacts, "config.artifacts");
  rejectUnknown(artifactsValue, ["directory"], "config.artifacts");
  const directory = optionalString(artifactsValue.directory, "./artifacts", "config.artifacts.directory");
  const vision = value.vision === undefined ? undefined : (() => {
    const visionValue = object(value.vision, "config.vision");
    rejectUnknown(visionValue, ["retainedImages"], "config.vision");
    const retainedImages = optionalPositiveInteger(visionValue.retainedImages, "config.vision.retainedImages");
    if (retainedImages === undefined) throw new ConfigurationError("config.vision.retainedImages must be a positive integer");
    return Object.freeze({ retainedImages });
  })();
  const runLabel = createRunLabel();
  return Object.freeze({
    mode,
    abilitySet,
    runtime: Object.freeze({ url: runtimeUrl, connectTimeoutMs }),
    bot: Object.freeze({ username }),
    model,
    data: Object.freeze({ directory: dataDirectory }),
    artifacts: Object.freeze({ directory, runLabel }),
    ...(vision === undefined ? {} : { vision }),
  });
}

function modelProvider(input: Record<string, unknown>): ModelProvider {
  if (input.provider === "openai") {
    rejectUnknown(input, ["provider", "model", "limits", "reasoningEffort"], "config.model");
    return Object.freeze({
      provider: "openai",
      model: requiredString(input.model, "config.model.model"),
      limits: modelLimits(input.limits),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: requiredString(input.reasoningEffort, "config.model.reasoningEffort") }),
    });
  }
  if (input.provider === "deepseek") {
    rejectUnknown(input, ["provider", "model", "limits"], "config.model");
    return Object.freeze({
      provider: "deepseek",
      model: requiredString(input.model, "config.model.model"),
      limits: modelLimits(input.limits),
    });
  }
  if (input.provider === "openai-compatible") {
    rejectUnknown(input, ["provider", "name", "model", "baseUrl", "protocol", "limits", "reasoningEffort", "apiKeyEnvironmentVariable"], "config.model");
    const apiKeyEnvironmentVariable = input.apiKeyEnvironmentVariable === undefined
      ? undefined
      : requiredString(input.apiKeyEnvironmentVariable, "config.model.apiKeyEnvironmentVariable");
    if (input.protocol === undefined) {
      throw new ConfigurationError("config.model.protocol is required for openai-compatible providers (chat-completions or responses)");
    }
    if (input.protocol !== "chat-completions" && input.protocol !== "responses") {
      throw new ConfigurationError("config.model.protocol must be chat-completions or responses");
    }
    return Object.freeze({
      provider: "openai-compatible",
      name: requiredString(input.name, "config.model.name"),
      model: requiredString(input.model, "config.model.model"),
      baseUrl: validUrl(requiredString(input.baseUrl, "config.model.baseUrl"), ["http:", "https:"], "config.model.baseUrl"),
      protocol: input.protocol,
      limits: modelLimits(input.limits),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: requiredString(input.reasoningEffort, "config.model.reasoningEffort") }),
      ...(apiKeyEnvironmentVariable === undefined ? {} : { apiKeyEnvironmentVariable }),
    });
  }
  throw new ConfigurationError("config.model.provider must be openai, deepseek, or openai-compatible");
}

function modelLimits(input: unknown): ModelLimits {
  const limitsValue = object(input, "config.model.limits");
  rejectUnknown(limitsValue, ["contextWindowTokens", "maxOutputTokens", "requestTimeoutMs", "firstOutputTimeoutMs", "outputIdleTimeoutMs", "retries", "retryMaxDelayMs"], "config.model.limits");
  const firstOutputTimeoutMs = optionalPositiveInteger(limitsValue.firstOutputTimeoutMs, "config.model.limits.firstOutputTimeoutMs");
  const outputIdleTimeoutMs = optionalPositiveInteger(limitsValue.outputIdleTimeoutMs, "config.model.limits.outputIdleTimeoutMs");
  const requestTimeoutMs = optionalPositiveInteger(limitsValue.requestTimeoutMs, "config.model.limits.requestTimeoutMs");
  const retries = optionalNonNegativeInteger(limitsValue.retries, "config.model.limits.retries");
  const retryMaxDelayMs = optionalPositiveInteger(limitsValue.retryMaxDelayMs, "config.model.limits.retryMaxDelayMs");
  const contextWindowTokens = requiredPositiveInteger(limitsValue.contextWindowTokens, "config.model.limits.contextWindowTokens");
  const maxOutputTokens = requiredPositiveInteger(limitsValue.maxOutputTokens, "config.model.limits.maxOutputTokens");
  if (maxOutputTokens >= contextWindowTokens) {
    throw new ConfigurationError("config.model.limits.maxOutputTokens must be smaller than contextWindowTokens");
  }
  return Object.freeze({ contextWindowTokens, maxOutputTokens, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(firstOutputTimeoutMs === undefined ? {} : { firstOutputTimeoutMs }),
    ...(outputIdleTimeoutMs === undefined ? {} : { outputIdleTimeoutMs }),
    ...(retries === undefined ? {} : { retries }),
    ...(retryMaxDelayMs === undefined ? {} : { retryMaxDelayMs }) });
}

function toolMode(input: unknown): ToolMode {
  if (input === undefined || input === "code") return "code";
  if (input === "native") return "native";
  throw new ConfigurationError("config.mode must be code or native; both is unsupported");
}

/** Returns the environment variable name that supplies the API key for one Model Provider route. */
function apiKeyEnvironmentVariable(model: ModelProvider): string | undefined {
  if (model.provider === "openai") return "OPENAI_API_KEY";
  if (model.provider === "deepseek") return "DEEPSEEK_API_KEY";
  return model.apiKeyEnvironmentVariable;
}

/** Secrets have no configuration representation and are supplied only by the process environment. */
export function loadHarnessSecrets(
  model: ModelProvider,
  environment: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ requireModelProvider?: boolean }> = {},
): HarnessSecrets {
  const requireModelProvider = options.requireModelProvider ?? true;
  const envVar = apiKeyEnvironmentVariable(model);
  const providerSecrets = envVar === undefined
    ? {}
    : environmentSecret(environment, envVar, "modelApiKey", requireModelProvider);
  const runtimeBearerToken = environment.EVICRAFT_RUNTIME_BEARER_TOKEN;
  return Object.freeze({
    ...providerSecrets,
    ...(typeof runtimeBearerToken === "string" && runtimeBearerToken.trim() !== ""
      ? { runtimeBearerToken }
      : {}),
  });
}

export function validateHarnessSecrets(
  input: HarnessSecrets,
  model: ModelProvider,
  options: Readonly<{ requireModelProvider?: boolean }> = {},
): HarnessSecrets {
  const requireModelProvider = options.requireModelProvider ?? true;
  if (input.modelApiKey !== undefined && (typeof input.modelApiKey !== "string" || input.modelApiKey.trim() === "")) {
    throw new ConfigurationError("Model API key must be a non-empty string when supplied");
  }
  const envVar = apiKeyEnvironmentVariable(model);
  if (requireModelProvider && envVar !== undefined && input.modelApiKey === undefined) {
    throw new ConfigurationError(`${envVar} must be supplied through the environment`);
  }
  if (input.runtimeBearerToken !== undefined
    && (typeof input.runtimeBearerToken !== "string" || input.runtimeBearerToken.trim() === "")) {
    throw new ConfigurationError("EVICRAFT_RUNTIME_BEARER_TOKEN must be a non-empty string when supplied");
  }
  return Object.freeze({
    ...(input.modelApiKey === undefined ? {} : { modelApiKey: input.modelApiKey }),
    ...(input.runtimeBearerToken === undefined ? {} : { runtimeBearerToken: input.runtimeBearerToken }),
  });
}

function environmentSecret<Key extends keyof HarnessSecrets>(
  environment: NodeJS.ProcessEnv,
  name: string,
  key: Key,
  required: boolean,
): Pick<HarnessSecrets, Key> | Record<string, never> {
  const value = environment[name];
  if (typeof value === "string" && value.trim() !== "") return { [key]: value } as Pick<HarnessSecrets, Key>;
  if (required) throw new ConfigurationError(`${name} must be supplied through the environment`);
  return {};
}


function object(input: unknown, name: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigurationError(`${name} must be an object`);
  }
  return input as Record<string, unknown>;
}

function optionalObject(input: unknown, name: string): Record<string, unknown> {
  return input === undefined ? {} : object(input, name);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ConfigurationError(`${name}.${key} is not supported`);
  }
}

function requiredString(input: unknown, name: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ConfigurationError(`${name} must be a non-empty string`);
  }
  return input;
}

function optionalString(input: unknown, fallback: string, name: string): string {
  return input === undefined ? fallback : requiredString(input, name);
}
function optionalBoolean(input: unknown, fallback: boolean, name: string): boolean {
  if (input === undefined) return fallback;
  if (typeof input !== "boolean") throw new ConfigurationError(`${name} must be a boolean`);
  return input;
}

function optionalPositiveInteger(input: unknown, name: string): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return input;
}

function optionalNonNegativeInteger(input: unknown, name: string): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new ConfigurationError(`${name} must be a non-negative integer`);
  }
  return input;
}

function requiredPositiveInteger(input: unknown, name: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return input;
}

function validUrl(input: string, protocols: readonly string[], name: string): string {
  try {
    const url = new URL(input);
    if (!protocols.includes(url.protocol)) throw new ConfigurationError(`${name} has an unsupported protocol`);
    return url.toString();
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`${name} must be a valid URL`);
  }
}

function createRunLabel(date: Date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/gu, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}
