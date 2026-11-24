import { simulateStreamingMiddleware, wrapLanguageModel, type AssistantModelMessage, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4Content, LanguageModelV4GenerateResult } from "@ai-sdk/provider";

import type { AgentToolProjection } from "../model-surface-message.js";

type GenerateOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

export interface ScriptedModelCall {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly AgentToolProjection[];
  readonly maxOutputTokens?: number;
}

export interface ScriptedDecision {
  readonly message: AssistantModelMessage;
  readonly usage?: Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>;
  readonly finishReason?: LanguageModelV4GenerateResult["finishReason"];
  readonly reasoningTokens?: number;
}

export interface ScriptedLanguageModelOptions {
  readonly limits?: Readonly<{ contextWindowTokens: number; maxOutputTokens?: number }>;
  readonly responses?: readonly (ScriptedDecision | Error)[];
  readonly respond?: (
    request: ScriptedModelCall,
    index: number,
    context: Readonly<{ signal?: AbortSignal }>,
  ) => ScriptedDecision | Error | Promise<ScriptedDecision | Error>;
}

/** AI SDK test model used only to drive deterministic public Harness Runs. */
export class ScriptedLanguageModel extends MockLanguageModelV4 {
  public readonly requests: ScriptedModelCall[];
  public readonly limits: Readonly<{ contextWindowTokens: number; maxOutputTokens: number }>;

  public constructor(options: ScriptedLanguageModelOptions) {
    let calls = 0;
    const requests: ScriptedModelCall[] = [];
    super({
      provider: "scripted",
      modelId: "scripted",
      doGenerate: async (input) => {
        const request = modelCall(input);
        const index = calls++;
        requests.push(request);
        const response = options.respond === undefined
          ? options.responses?.[index]
          : await options.respond(request, index, {
            ...(input.abortSignal === undefined ? {} : { signal: input.abortSignal }),
          });
        if (response === undefined) throw new Error("Scripted LanguageModel exhausted its responses");
        if (response instanceof Error) throw response;
        return generateResult(response);
      },
    });
    this.doStream = wrapLanguageModel({ model: this, middleware: simulateStreamingMiddleware() }).doStream;
    this.requests = requests;
    this.limits = {
      contextWindowTokens: options.limits?.contextWindowTokens ?? 200_000,
      maxOutputTokens: options.limits?.maxOutputTokens ?? 512,
    };
  }
}

function modelCall(input: GenerateOptions): ScriptedModelCall {
  const tools = input.tools?.filter((candidate) => candidate.type === "function").map((candidate): AgentToolProjection => ({
    name: candidate.name,
    description: candidate.description ?? "",
    inputSchema: candidate.inputSchema as Readonly<Record<string, unknown>>,
  }));
  return {
    messages: input.prompt.map(modelMessage),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
  };
}

function modelMessage(message: GenerateOptions["prompt"][number]): ModelMessage {
  if (message.role === "system") return { role: "system", content: message.content };
  if (message.role === "user") return {
    role: "user",
    content: message.content.filter((part) => part.type === "text")
      .map((part) => ({ type: "text" as const, text: part.text })),
  };
  if (message.role === "tool") return {
    role: "tool",
    content: message.content.filter((part) => part.type === "tool-result").map((part) => ({
      type: "tool-result" as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: part.output,
    })),
  };
  const content: Exclude<AssistantModelMessage["content"], string> = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    if (part.type === "reasoning") content.push({ type: "reasoning", text: part.text });
    if (part.type === "tool-call") content.push({
      type: "tool-call",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: typeof part.input === "string" ? parseJson(part.input) : part.input,
    });
  }
  return {
    role: "assistant",
    content,
  };
}

function generateResult(decision: ScriptedDecision): LanguageModelV4GenerateResult {
  const content: LanguageModelV4Content[] = [];
  const parts = typeof decision.message.content === "string"
    ? [{ type: "text" as const, text: decision.message.content }]
    : decision.message.content;
  for (const part of parts) {
    if (part.type === "reasoning") content.push({ type: "reasoning", text: part.text });
    if (part.type === "text") content.push({ type: "text", text: part.text });
    if (part.type === "tool-call") content.push({
      type: "tool-call",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: JSON.stringify(part.input),
    });
  }
  const inputTokens = decision.usage?.inputTokens;
  const outputTokens = decision.usage?.outputTokens;
  return {
    content,
    finishReason: decision.finishReason ?? {
      unified: content.some((part) => part.type === "tool-call") ? "tool-calls" : "stop",
      raw: undefined,
    },
    usage: {
      inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: outputTokens, text: outputTokens, reasoning: decision.reasoningTokens },
    },
    warnings: [],
  };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { return value; }
}
