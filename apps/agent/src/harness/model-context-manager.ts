import { randomUUID } from "node:crypto";

import type { AiSdkModelSession, ModelRequest } from "./ai-sdk-model-session.js";
import type { HarnessRunEventLog } from "./harness-run-event-log.js";
import { modelErrorDetails } from "./model-error-details.js";
import type { CompletedToolCycle, ModelSurface } from "./model-surface.js";
import {
  IMAGE_TOKEN_ESTIMATE, messageImageCount, messageText, messageToolCalls, textMessage, withoutImages,
  type AgentToolProjection, type ModelMessage,
} from "./model-surface-message.js";

/** History is compacted once the request passes this share of the input budget. */
const COMPACTION_TRIGGER_RATIO = 0.8;
/** Share of the input budget that the most recent Tool Cycles keep verbatim after a compaction. */
const RECENT_HISTORY_RATIO = 0.25;
const SUMMARY_MAX_OUTPUT_TOKENS = 16384;
/** A summary needs what a Tool did, not its whole output. */
const SUMMARY_TEXT_CHARS = 4000;
const OMITTED_HISTORY = "[Older tool history omitted because summarization was unavailable.]";
const CLIPPED = "\n[...]\n";

export interface PreparedModelContext {
  readonly estimate: ContextEstimate;
  readonly request: ModelRequest;
  readonly removedCycles: number;
}

interface ContextInput {
  readonly tools: readonly AgentToolProjection[];
  readonly correction?: string;
}

interface ContextEstimate {
  readonly inputTokens: number;
  readonly source: "local_estimate" | "usage_calibrated";
}

interface ContextManagerOptions {
  readonly model: AiSdkModelSession;
  readonly surface: ModelSurface;
  readonly eventLog: HarnessRunEventLog;
}

/**
 * Keeps each request inside the model's input budget: older Tool Cycles are folded into one running summary
 * while the most recent ones stay verbatim.
 */
export class ModelContextManager {
  /** The last request whose input tokens the Provider reported. */
  #anchor: Readonly<{ weight: number; tokens: number }> | undefined;

  public constructor(private readonly options: ContextManagerOptions) {}

  /** Records what the Provider counted for a request, so later estimates start from a measured size. */
  public observe(request: ModelRequest, inputTokens: number | undefined): void {
    if (inputTokens === undefined || !Number.isFinite(inputTokens) || inputTokens <= 0) return;
    this.#anchor = { weight: requestWeight(request), tokens: inputTokens };
  }

  /**
   * Text added since the measured request counts at two bytes a token. Coordinates and identifiers are that dense,
   * and scaling them by the ratio measured on prose is what let oversized requests through.
   */
  private estimate(request: ModelRequest): ContextEstimate {
    const weight = requestWeight(request);
    const anchor = this.#anchor;
    if (anchor === undefined) return { inputTokens: Math.ceil(weight / 3), source: "local_estimate" };
    return {
      inputTokens: weight >= anchor.weight
        ? anchor.tokens + Math.ceil((weight - anchor.weight) / 2)
        : Math.ceil(weight * anchor.tokens / anchor.weight),
      source: "usage_calibrated",
    };
  }

  private get inputBudget(): number {
    const { limits } = this.options.model;
    return limits.contextWindowTokens - limits.maxOutputTokens;
  }

  public async prepare(input: ContextInput, signal?: AbortSignal): Promise<PreparedModelContext> {
    signal?.throwIfAborted();
    const { surface } = this.options;
    const request = this.createRequest(input, surface.historySummary, surface.completedCycles);
    const estimate = this.estimate(request);
    if (estimate.inputTokens <= Math.floor(this.inputBudget * COMPACTION_TRIGGER_RATIO) || surface.completedCycles.length === 0) {
      return { request, estimate, removedCycles: 0 };
    }
    return await this.compact(input, "input_budget", Math.floor(this.inputBudget * RECENT_HISTORY_RATIO), signal);
  }

  /**
   * The Provider rejected a request the estimate had accepted. The first recovery halves the verbatim history,
   * the second keeps only the summary.
   */
  public async recoverOverflow(input: ContextInput, attempt: 1 | 2, signal?: AbortSignal): Promise<number> {
    const { surface } = this.options;
    // The rejected request held more than the whole input budget, whatever the estimate said.
    const rejected = this.createRequest(input, surface.historySummary, surface.completedCycles);
    if (this.estimate(rejected).inputTokens < this.inputBudget) {
      this.#anchor = { weight: requestWeight(rejected), tokens: this.inputBudget };
    }
    const keepTokens = attempt === 1 ? Math.floor(this.inputBudget * RECENT_HISTORY_RATIO / 2) : 0;
    return (await this.compact(input, "provider_overflow", keepTokens, signal)).removedCycles;
  }

  private async compact(
    input: ContextInput,
    trigger: "input_budget" | "provider_overflow",
    keepTokens: number,
    signal?: AbortSignal,
  ): Promise<PreparedModelContext> {
    const { surface, eventLog } = this.options;
    const triggerTokens = Math.floor(this.inputBudget * COMPACTION_TRIGGER_RATIO);
    const all = surface.completedCycles;
    const before = this.estimate(this.createRequest(input, surface.historySummary, all));
    const compactionId = randomUUID();

    // Keep the newest cycles that fit the allowance; the newest one stays whenever it can, so the model reads its own last result.
    const base = this.estimate(this.createRequest(input, undefined, [])).inputTokens;
    let kept = 0;
    if (keepTokens > 0) {
      while (kept < all.length
        && (kept === 0 || this.estimate(this.createRequest(input, undefined, all.slice(-(kept + 1)))).inputTokens - base <= keepTokens)) kept++;
    }
    // Everything fits the allowance yet the request is too large: summarize the older half rather than nothing.
    if (kept === all.length) kept = Math.floor(all.length / 2);
    let cycles = kept === 0 ? [] : all.slice(-kept);
    const older = all.slice(0, all.length - cycles.length);

    let summaryText = surface.historySummary === undefined ? undefined : messageText(surface.historySummary);
    let strategy: "summary" | "trim" = older.length === 0 ? "trim" : "summary";
    // Set when cycles leave the history without reaching the summary.
    let omitted = false;
    if (older.length > 0) {
      const outcome = await this.summarize(older, summaryText, compactionId, trigger, signal);
      summaryText = outcome.summary;
      if (outcome.reason !== undefined) {
        strategy = "trim";
        omitted = true;
        await eventLog.commit({ type: "history_compaction_failed", compactionId, reason: outcome.reason, fallback: "trim" });
      }
    }
    const summaryMessage = () => {
      const text = [summaryText, omitted ? OMITTED_HISTORY : undefined].filter(Boolean).join("\n");
      return text === "" ? undefined : textMessage("user", text);
    };
    // The allowance is an estimate; give up verbatim cycles, oldest first, until the request fits.
    while (cycles.length > 0 && this.estimate(this.createRequest(input, summaryMessage(), cycles)).inputTokens > triggerTokens) {
      cycles = cycles.slice(1);
      omitted = true;
    }
    const summary = summaryMessage();

    const request = this.createRequest(input, summary, cycles);
    const estimate = this.estimate(request);
    signal?.throwIfAborted();
    await eventLog.commit({ type: "history_compacted", compactionId, strategy, trigger,
      inputTokensBefore: before, inputTokensAfter: estimate,
      summarizedCompleteToolCycles: strategy === "summary" ? older.length : 0,
      retainedCompleteToolCycles: cycles.length, droppedCompleteToolCycles: all.length - cycles.length,
      summary: summary === undefined ? null : messageText(summary) });
    signal?.throwIfAborted();
    const removedCycles = surface.replaceHistory(summary, cycles);
    return { request, estimate, removedCycles };
  }

  /** Folds cycles into the running summary, as many per request as the context window takes. */
  private async summarize(
    older: readonly CompletedToolCycle[],
    previous: string | undefined,
    compactionId: string,
    trigger: "input_budget" | "provider_overflow",
    signal?: AbortSignal,
  ): Promise<Readonly<{ summary: string | undefined; reason?: string }>> {
    const { model, eventLog } = this.options;
    const maxOutputTokens = Math.min(SUMMARY_MAX_OUTPUT_TOKENS, model.limits.maxOutputTokens);
    const summaryRequest = (summary: string | undefined, cycles: readonly unknown[]): ModelRequest => ({
      messages: [
        textMessage("system", HISTORY_SUMMARY_INSTRUCTION),
        textMessage("user", JSON.stringify({ previous_summary: summary ?? null, completed_tool_cycles: cycles })),
      ],
      maxOutputTokens,
    });
    // A summary request shares no text with the measured decision request, so it is sized at the dense rate.
    const budgetBytes = (model.limits.contextWindowTokens - maxOutputTokens) * 2;
    const rendered = older.map(summaryCycle);
    const sizes = rendered.map(cycle => Buffer.byteLength(JSON.stringify(cycle), "utf8") + 1);
    let summary = previous;
    for (let next = 0; next < rendered.length;) {
      let bytes = requestWeight(summaryRequest(summary, [])) + sizes[next]!;
      if (bytes > budgetBytes) return { summary, reason: "summary_input_budget" };
      let end = next + 1;
      while (end < rendered.length && bytes + sizes[end]! <= budgetBytes) bytes += sizes[end++]!;
      const request = summaryRequest(summary, rendered.slice(next, end));
      const requestId = randomUUID();
      await eventLog.commit({ type: "history_compaction_started", compactionId, requestId, trigger,
        inputTokenEstimate: Math.ceil(bytes / 2), inputBudgetTokens: this.inputBudget,
        summarizedCompleteToolCycles: end - next, summaryMaxOutputTokens: maxOutputTokens });
      let response;
      try {
        response = await model.complete(request, { requestId, ...(signal === undefined ? {} : { signal }),
          onAttempt: event => eventLog.commit({ ...event, requestId, compactionId, purpose: "compaction" }) });
      } catch (error) {
        signal?.throwIfAborted();
        await eventLog.commit({ type: "history_compaction_call_finished", compactionId, requestId,
          outcome: "error", errorDetails: modelErrorDetails(error) });
        return { summary, reason: "summary_failure" };
      }
      signal?.throwIfAborted();
      await eventLog.commit({ type: "history_compaction_call_finished", compactionId, requestId, outcome: "ok",
        assistant: response.message, usage: response.usage ?? null, finishReason: response.finishReason ?? null,
        rawFinishReason: response.rawFinishReason ?? null, reasoningTokens: response.reasoningTokens ?? null,
        cacheReadTokens: response.cacheReadTokens ?? null, cacheWriteTokens: response.cacheWriteTokens ?? null });
      const text = messageText(response.message).trim();
      if (text === "") return { summary, reason: "empty_summary" };
      summary = text;
      next = end;
    }
    return { summary };
  }

  private createRequest(input: ContextInput, summary: ModelMessage | undefined, cycles: readonly CompletedToolCycle[]): ModelRequest {
    return { messages: [
      ...this.options.surface.previewHistory(summary, cycles),
      ...(input.correction === undefined ? [] : [textMessage("user", input.correction)]),
    ], tools: input.tools };
  }
}

const HISTORY_SUMMARY_INSTRUCTION = [
  "Summarize older history for one External Agent Harness Run.",
  "Combine previous_summary and completed_tool_cycles chronologically, preserving still-relevant facts.",
  "Preserve confirmed facts, locations, Tool outcomes, failure causes, constraints, the current Agent Plan and unfinished work.",
  "Distinguish observations from plans and uncertainty. Do not invent facts or replay nested calls.",
  "Return concise plain text, aiming for about 2000 tokens; omit repetition and obsolete details.",
  "This summary accompanies recent evidence and a fresh observation; it is memory, not new world evidence.",
].join("\n");

/** One Tool Cycle as the summarizer reads it: what was decided, what was called, what came back. */
function summaryCycle(cycle: CompletedToolCycle): unknown {
  const text = messageText(cycle.assistant).trim();
  return {
    decision_context: clip(messageText(cycle.decisionContext)),
    assistant: {
      ...(text === "" ? {} : { text: clip(text) }),
      tool_calls: messageToolCalls(cycle.assistant).map(call => ({ name: call.name, arguments: clip(call.arguments) })),
    },
    tool_result: clip(messageText(cycle.toolResult)),
    ...(cycle.attachment === undefined ? {} : { attachment: "[capture_view image]" }),
  };
}

function clip(text: string): string {
  if (text.length <= SUMMARY_TEXT_CHARS) return text;
  const half = Math.floor(SUMMARY_TEXT_CHARS / 2);
  return text.slice(0, half).replace(/[\uD800-\uDBFF]$/, "") + CLIPPED + text.slice(-half).replace(/^[\uDC00-\uDFFF]/, "");
}

/**
 * Size of a request in bytes of readable text; each image counts as the text of its token estimate.
 * Opaque provider continuation data is not prompt content.
 */
function requestWeight(request: ModelRequest): number {
  const images = request.messages.reduce((count, message) => count + messageImageCount(message), 0);
  const text = JSON.stringify({ messages: request.messages.map(message => withoutImages(message, "")), tools: request.tools },
    (key, value) => key === "providerOptions" ? undefined : value);
  return Buffer.byteLength(text, "utf8") + images * IMAGE_TOKEN_ESTIMATE * 3;
}
