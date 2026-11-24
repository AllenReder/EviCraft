import { setTimeout as delay } from "node:timers/promises";
import {
  APICallError,
  streamText,
  InvalidResponseDataError,
  InvalidToolInputError,
  jsonSchema,
  NoSuchToolError,
  RetryError,
  tool,
  type AssistantModelMessage,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";

import {
  ModelContextOverflowError,
  ModelProviderError,
  type AgentToolProjection,
  type ModelSessionDecision,
} from "./model-surface-message.js";

import { modelErrorDetails, type ModelErrorDetails } from "./model-error-details.js";
import type { ModelLimits } from "./config.js";

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly AgentToolProjection[];
  readonly maxOutputTokens?: number;
}

export type AiSdkModelLimits = ModelLimits;

/** One complete provider attempt, including consumption of its response stream. */
export interface ModelAttemptEvent {
  readonly type: "model_attempt_started" | "model_attempt_finished";
  readonly attempt: number;
  readonly timestamp: string;
  readonly outcome?: "ok" | "error";
  readonly durationMs?: number;
  readonly statusCode?: number;
  readonly category?: ModelProviderError["category"];
  readonly errorDetails?: ModelErrorDetails;
  readonly firstOutputMs?: number;
}

/**
 * Retries after the first attempt when `limits.retries` is absent. Game time is paused while a request is
 * pending, so waiting for a restarting model server costs nothing; with the default delay cap this is
 * about 25 minutes of backoff.
 */
export const DEFAULT_MODEL_RETRIES = 30;
/** Cap on the exponential backoff when `limits.retryMaxDelayMs` is absent. */
export const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;

/** Run-scoped owner of AI SDK generation, limits, validation, and Provider error classification. */
export class AiSdkModelSession {
  public readonly limits: AiSdkModelLimits;
  private readonly model: LanguageModel;
  private readonly toolChoice: "auto" | "required";

  public constructor(
    model: LanguageModel,
    limits: AiSdkModelLimits,
    toolChoice?: "auto" | "required",
  ) {
    this.model = model;
    this.toolChoice = toolChoice ?? "required";
    this.limits = Object.freeze({ ...limits });
  }

  public async complete(
    input: ModelRequest,
    options?: Readonly<{ signal?: AbortSignal; requestId?: string; onAttempt?: (event: ModelAttemptEvent) => void | Promise<void> }>,
  ): Promise<ModelSessionDecision> {
    let result;
    let attempts = 0;
    const deadline = new AbortController();
    const timeoutMs = this.limits.requestTimeoutMs ?? 7_200_000;
    const retries = this.limits.retries ?? DEFAULT_MODEL_RETRIES;
    const timer = setTimeout(() => deadline.abort(new DOMException("Model request deadline exceeded", "TimeoutError")), timeoutMs);
    const signal = options?.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
    try {
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        signal.throwIfAborted();
        attempts = attempt;
        const started = performance.now();
        await options?.onAttempt?.({ type: "model_attempt_started", attempt, timestamp: new Date().toISOString() });
        let firstOutputMs: number | undefined;
        let failure: unknown;
        try {
          result = await this.stream(input, signal, () => { firstOutputMs ??= performance.now() - started; });
        } catch (error) {
          failure = error;
          const classified = classifyProviderError(error);
          const category = options?.signal?.aborted ? "cancelled" : deadline.signal.aborted ? "timeout" : classified.category;
          try {
            await options?.onAttempt?.({ type: "model_attempt_finished", attempt, timestamp: new Date().toISOString(), outcome: "error",
              durationMs: performance.now() - started, ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
              ...(classified.statusCode === undefined ? {} : { statusCode: classified.statusCode }),
              category, errorDetails: modelErrorDetails(error) });
          } catch (auditError) {
            throw new AggregateError([error, auditError], "Model request and audit failed", { cause: error });
          }
          if (signal.aborted || attempt > retries || lastApiError(error)?.isRetryable === false
            || !["transient_http", "connection", "timeout"].includes(classified.category ?? "")) throw error;
        }
        if (result !== undefined) {
          await options?.onAttempt?.({ type: "model_attempt_finished", attempt, timestamp: new Date().toISOString(), outcome: "ok",
            durationMs: performance.now() - started, ...(firstOutputMs === undefined ? {} : { firstOutputMs }) });
          break;
        }
        await delay(retryDelayMs(failure, attempt, this.limits.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS), undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) {
        const category = options?.signal?.aborted ? "cancelled" : "timeout";
        throw new ModelProviderError(`Model request ${category}`, { category, attempts, cause: error });
      }
      const classified = classifyProviderError(error);
      if (classified.category === "context_overflow") {
        throw new ModelContextOverflowError("Provider rejected the model context window", { cause: error });
      }
      if (classified.category !== undefined) {
        throw new ModelProviderError(`Model ${classified.category} failure${classified.statusCode === undefined ? "" : ` (HTTP ${classified.statusCode})`}`, {
          ...(classified.code === undefined ? {} : { code: classified.code }), category: classified.category, attempts,
          ...(classified.statusCode === undefined ? {} : { statusCode: classified.statusCode }), cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (result === undefined) throw new Error("Model request completed without a result");
    const calls = result.toolCalls;
    const first = calls[0];
    const toolCallIssue = first === undefined ? undefined : toolCallIssueOf(first);
    const assistant = acceptedAssistantMessage(
      result.responseMessages,
      first?.toolCallId,
      result.text,
      result.reasoningText,
    );
    return {
      message: assistant,
      usage: observedUsage(result.usage),
      finishReason: result.finishReason,
      ...(result.rawFinishReason === undefined ? {} : { rawFinishReason: result.rawFinishReason }),
      ...(result.usage.outputTokenDetails?.reasoningTokens === undefined ? {} : { reasoningTokens: result.usage.outputTokenDetails.reasoningTokens }),
      ...(result.usage.inputTokenDetails?.cacheReadTokens === undefined ? {} : { cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens }),
      ...(result.usage.inputTokenDetails?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens }),
      ...(first === undefined || calls.length <= 1 ? {} : {
        serialToolCallReduction: { received: calls.length, retained: first.toolCallId },
      }),
      ...(toolCallIssue === undefined ? {} : { toolCallIssue }),
    };
  }

  private async stream(input: ModelRequest, requestSignal: AbortSignal, onOutput: () => void) {
    const attempt = new AbortController();
    const signal = AbortSignal.any([requestSignal, attempt.signal]);
    let watchdog: ReturnType<typeof setTimeout>;
    const arm = (phase: "first_output" | "output_idle", timeoutMs: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => attempt.abort(new ModelStreamTimeout(phase)), timeoutMs);
    };
    // Unlike SDK firstChunkMs, this includes upload and waiting for response headers.
    arm("first_output", this.limits.firstOutputTimeoutMs ?? 600_000);
    try {
      const result = streamText({
        model: this.model,
        ...this.generationOptions(input, signal),
        maxRetries: 0,
        onError: () => {}, // Errors are consumed below and recorded once by the Session.
      });
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error instanceof Error ? part.error : new ModelStreamInterrupted({ cause: new ModelStreamFailure(part.error) });
        if (part.type === "abort") throw signal.reason ?? new ModelStreamInterrupted();
        if (((part.type === "text-delta" || part.type === "reasoning-delta") && part.text.length > 0)
          || (part.type === "tool-input-delta" && part.delta.length > 0) || part.type === "tool-call") {
          onOutput();
          arm("output_idle", this.limits.outputIdleTimeoutMs ?? 7_200_000);
        }
      }
      signal.throwIfAborted();
      const [toolCalls, responseMessages, text, reasoningText, usage, finishReason, rawFinishReason] = await Promise.all([
        result.toolCalls, result.responseMessages, result.text, result.reasoningText, result.usage, result.finishReason, result.rawFinishReason,
      ]);
      if (finishReason === "error" || (finishReason === "other" && rawFinishReason === undefined)) throw new ModelStreamInterrupted();
      return { toolCalls, responseMessages, text, reasoningText, usage, finishReason, rawFinishReason };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // EOF without a provider finish marker and socket failures cannot commit partial output.
      if ((InvalidResponseDataError.isInstance(error) && error.data === undefined)
        || (error instanceof TypeError && error.cause !== undefined)) {
        throw new ModelStreamInterrupted({ cause: error });
      }
      throw error;
    } finally {
      clearTimeout(watchdog!);
      attempt.abort(); // Close any unfinished body before another attempt can start.
    }
  }

  private generationOptions(input: ModelRequest, signal: AbortSignal) {
    return {
      messages: [...input.messages],
      allowSystemInMessages: true,
      tools: Object.fromEntries((input.tools ?? []).map((definition) => [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema),
          ...(definition.strict === undefined ? {} : { strict: definition.strict }),
        }),
      ])) as ToolSet,
      toolChoice: input.tools === undefined ? "none" as const : this.toolChoice,
      maxOutputTokens: input.tools === undefined
        ? Math.min(input.maxOutputTokens ?? this.limits.maxOutputTokens, this.limits.contextWindowTokens - 1)
        : this.limits.maxOutputTokens,
      abortSignal: signal,
    };
  }
}

/** Why the retained Tool Call cannot be executed; the cycle asks the model again instead of ending the run. */
function toolCallIssueOf(first: Readonly<{
  toolCallId: string;
  toolName: string;
  invalid?: boolean | undefined;
  error?: unknown | undefined;
}>): ModelSessionDecision["toolCallIssue"] {
  if (first.invalid && NoSuchToolError.isInstance(first.error)) {
    return { code: "invalid_tool_call_name", message: `Tool ${first.toolName} is not available`, toolName: first.toolName };
  }
  if (first.invalid && InvalidToolInputError.isInstance(first.error)) {
    try { JSON.parse(first.error.toolInput); }
    catch (error) {
      return { code: "invalid_tool_call_arguments", toolName: first.toolName,
        message: `Tool ${first.toolName} arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (first.toolName.trim() === "") return { code: "invalid_tool_call_name", message: "Tool Call has no name", toolName: "" };
  if (first.toolCallId.trim() === "") return { code: "invalid_tool_call_id", message: "Tool Call has no id", toolName: first.toolName };
  return undefined;
}

function acceptedAssistantMessage(
  messages: readonly ModelMessage[],
  retainedToolCallId: string | undefined,
  fallbackText: string,
  reasoningText: string | undefined,
): AssistantModelMessage {
  const assistant = messages.find((message): message is AssistantModelMessage => message.role === "assistant");
  if (assistant === undefined) return {
    role: "assistant",
    content: reasoningText === undefined || reasoningText === ""
      ? fallbackText
      : [{ type: "reasoning", text: reasoningText }, ...(fallbackText === "" ? [] : [{ type: "text" as const, text: fallbackText }])],
  };
  const content = typeof assistant.content === "string"
    ? [{ type: "text" as const, text: assistant.content }]
    : assistant.content.filter((part) => part.type !== "tool-call" || retainedToolCallId === undefined
      || part.toolCallId === retainedToolCallId);
  const withReasoning = reasoningText === undefined || reasoningText === ""
    || content.some((part) => part.type === "reasoning")
    ? content
    : [{ type: "reasoning" as const, text: reasoningText }, ...content];
  return {
    ...assistant,
    content: withReasoning,
  };
}

function observedUsage(value: Readonly<{
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}>): Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }> {
  return {
    ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
    ...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
  };
}

interface ClassifiedModelError {
  readonly category: "transient_http" | "fatal_http" | "connection" | "context_overflow" | "timeout" | undefined;
  readonly statusCode: number | undefined;
  readonly code: string | undefined;
}

/** Classifies an AI SDK error into the Harness error taxonomy. */
function classifyProviderError(error: unknown): ClassifiedModelError {
  if (error instanceof ModelStreamTimeout) return { category: "timeout", statusCode: undefined, code: error.code };
  if (error instanceof ModelStreamInterrupted) return { category: "connection", statusCode: undefined, code: error.code };
  const apiError = lastApiError(error);
  if (apiError === undefined) return { category: undefined, statusCode: undefined, code: undefined };
  if (isProviderConfirmedContextOverflow(apiError)) {
    return { category: "context_overflow", statusCode: apiError.statusCode, code: providerErrorCode(apiError) };
  }
  if (apiError.statusCode === undefined) {
    return { category: "connection", statusCode: undefined, code: providerErrorCode(apiError) };
  }
  const code = providerErrorCode(apiError);
  if (apiError.statusCode === 429 || apiError.statusCode === 408 || apiError.statusCode >= 500) {
    return { category: "transient_http", statusCode: apiError.statusCode, code };
  }
  return { category: "fatal_http", statusCode: apiError.statusCode, code };
}

/**
 * Wording providers use when a request does not fit the context window. Servers disagree on error codes and
 * body shapes (SGLang and vLLM return a flat `{message, code: 400}`), so the texts are matched wherever they appear.
 */
const CONTEXT_OVERFLOW_PATTERN = new RegExp([
  "context_length_exceeded", "context_window_exceeded",
  "exceeds? the context window", "maximum context length", "longer than the model's context length",
  "context length of \\d+ tokens", "prompt is too long", "input is too long", "too many (input )?tokens",
  "reduce the (length|number of tokens)",
].join("|"), "i");

function isProviderConfirmedContextOverflow(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode !== 400 && error.statusCode !== 413 && error.statusCode !== 422) return false;
  return [providerErrorCode(error), providerErrorMessage(error), error.message, error.responseBody]
    .some(text => typeof text === "string" && CONTEXT_OVERFLOW_PATTERN.test(text));
}

function lastApiError(error: unknown): APICallError | undefined {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(last) ? last : undefined;
}

function providerErrorCode(error: APICallError): string | undefined {
  if (error.data === null || typeof error.data !== "object" || Array.isArray(error.data)) return undefined;
  const data = error.data as Readonly<Record<string, unknown>>;
  const nested = data.error;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const code = (nested as Readonly<Record<string, unknown>>).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return typeof data.code === "string" && data.code !== "" ? data.code : undefined;
}

function providerErrorMessage(error: APICallError): string | undefined {
  if (error.data === null || typeof error.data !== "object" || Array.isArray(error.data)) return undefined;
  const data = error.data as Readonly<Record<string, unknown>>;
  const nested = data.error;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const message = (nested as Readonly<Record<string, unknown>>).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return typeof data.message === "string" && data.message !== "" ? data.message : undefined;
}

/** Attempt-local timeouts may retry; the request deadline and caller cancellation never do. */
class ModelStreamTimeout extends Error {
  public readonly code: string;
  public constructor(phase: "first_output" | "output_idle") {
    super(`Model stream ${phase} timeout`);
    this.name = "ModelStreamTimeout";
    this.code = phase === "first_output" ? "MODEL_FIRST_OUTPUT_TIMEOUT" : "MODEL_OUTPUT_IDLE_TIMEOUT";
  }
}

class ModelStreamInterrupted extends Error {
  public readonly code = "MODEL_STREAM_INTERRUPTED";
  public constructor(options?: ErrorOptions) {
    super("Model stream ended before a complete response", options);
    this.name = "ModelStreamInterrupted";
  }
}

/** Provider evidence from a failure frame; after first output the SDK delivers these as plain objects. */
class ModelStreamFailure extends Error {
  public readonly code: string | number | undefined;
  public constructor(frame: unknown) {
    const root = asRecord(frame);
    const failure = asRecord(asRecord(root?.response)?.error) ?? asRecord(root?.error) ?? root;
    super(typeof failure?.message === "string" ? failure.message : "Provider stream failed without a message");
    this.name = "ModelStreamFailure";
    this.code = typeof failure?.code === "string" || typeof failure?.code === "number" ? failure.code : undefined;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" ? value as Readonly<Record<string, unknown>> : undefined;
}

/** Provider Retry-After hints (up to 60 s) win; otherwise exponential backoff from 2 s, capped by `maxDelayMs`. */
export function retryDelayMs(error: unknown, attempt: number, maxDelayMs: number): number {
  const headers = lastApiError(error)?.responseHeaders;
  const milliseconds = headers?.["retry-after-ms"];
  const retryAfter = headers?.["retry-after"];
  const hinted = milliseconds !== undefined ? Number(milliseconds)
    : retryAfter === undefined ? NaN : Number.isNaN(Number(retryAfter)) ? Date.parse(retryAfter) - Date.now() : Number(retryAfter) * 1000;
  return Number.isFinite(hinted) && hinted >= 0 && hinted <= 60_000 ? hinted
    : Math.min(2_000 * 2 ** Math.min(attempt - 1, 20), maxDelayMs);
}
