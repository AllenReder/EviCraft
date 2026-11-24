import type { AssistantModelMessage, ModelMessage } from "ai";

export type ModelProtocolErrorCode =
  | "missing_tool_call"
  | "invalid_tool_call_id"
  | "invalid_tool_call_name"
  | "invalid_tool_call_arguments";

/** Harness Tool metadata projected into AI SDK Tools by the Model Session. */
export interface AgentToolProjection {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** One accepted result from the run-scoped AI SDK Model Session. */
export interface ModelSessionDecision {
  readonly message: AssistantModelMessage;
  readonly usage?: Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>;
  readonly finishReason?: string;
  readonly rawFinishReason?: string;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly serialToolCallReduction?: Readonly<{ received: number; retained: string }>;
  /** The retained Tool Call cannot be executed as returned (unknown Tool, malformed arguments, missing id). */
  readonly toolCallIssue?: Readonly<{ code: ModelProtocolErrorCode; message: string; toolName: string }>;
}

export type { AssistantModelMessage as ModelAssistantMessage, ModelMessage };

export function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (message.role === "tool") {
    return message.content.filter((part) => part.type === "tool-result").map((part) =>
      part.output.type === "text" ? part.output.value : JSON.stringify(part.output),
    ).join("");
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function textMessage(role: "system" | "user", text: string): ModelMessage {
  return { role, content: text };
}

export function messageToolCalls(message: AssistantModelMessage): readonly ModelToolCall[] {
  if (typeof message.content === "string") return [];
  return message.content
    .filter((part) => part.type === "tool-call")
    .map((part) => ({ id: part.toolCallId, name: part.toolName, arguments: canonicalJson(part.input) }));
}

export function messageReasoning(message: AssistantModelMessage): string {
  if (typeof message.content === "string") return "";
  return message.content
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
}

/** Estimated input tokens charged for one attached image, independent of its encoded size. */
export const IMAGE_TOKEN_ESTIMATE = 1600;

/** A user message carrying one PNG image after a short text label. */
export function imageMessage(label: string, pngBase64: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text: label }, { type: "file", data: pngBase64, mediaType: "image/png" }] };
}

/** Number of image parts in one message. */
export function messageImageCount(message: ModelMessage): number {
  if (message.role !== "user" || typeof message.content === "string") return 0;
  return message.content.filter(isImagePart).length;
}

/** The same message with every image part replaced by a text placeholder, for journals and summaries. */
export function withoutImages(message: ModelMessage, placeholder: string): ModelMessage {
  if (message.role !== "user" || typeof message.content === "string") return message;
  return { ...message, content: message.content.map((part) => isImagePart(part) ? { type: "text" as const, text: placeholder } : part) };
}

function isImagePart(part: Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number]): boolean {
  return part.type === "image" || (part.type === "file" && part.mediaType.startsWith("image/"));
}

export function toolResultMessage(toolCallId: string, toolName: string, content: string): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value: content } }],
  };
}

export class ModelProviderError extends Error {
  public readonly code: string | undefined;
  public readonly category: "transient_http" | "fatal_http" | "connection" | "timeout" | "cancelled" | "context_overflow" | undefined;
  public readonly statusCode: number | undefined;
  public readonly attempts: number | undefined;

  public constructor(message: string, options: Readonly<{ code?: string; cause?: unknown; category?: ModelProviderError["category"]; statusCode?: number; attempts?: number }> = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelProviderError";
    this.code = options.code;
    this.category = options.category;
    this.statusCode = options.statusCode;
    this.attempts = options.attempts;
  }
}

/** Raised only when the Provider explicitly identifies the request as exceeding its context. */
export class ModelContextOverflowError extends ModelProviderError {
  public constructor(message: string, options: Readonly<{ cause?: unknown }> = {}) {
    super(message, { code: "context_overflow", category: "context_overflow", ...options });
    this.name = "ModelContextOverflowError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
