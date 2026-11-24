import { randomUUID } from "node:crypto";

import type { AiSdkModelSession } from "./ai-sdk-model-session.js";
import type { ToolMode } from "./config.js";
import type { Decision, DecisionSource } from "./agent-loop.js";
import type { HarnessRunEventLog } from "./harness-run-event-log.js";
import { ModelContextManager } from "./model-context-manager.js";
import { modelErrorDetails } from "./model-error-details.js";
import type { ModelSurface } from "./model-surface.js";
import {
  ModelContextOverflowError,
  ModelProviderError,
  messageReasoning,
  messageToolCalls,
  toolResultMessage,
  type ModelProtocolErrorCode,
  type ModelSessionDecision,
} from "./model-surface-message.js";
import type { HarnessProgressEvent } from "./progress.js";
import { programmaticCodeContract } from "./programmatic-code-contract.js";
import { anySignal, errorMessage } from "./util.js";

/**
 * Consecutive unusable responses (no Tool Call, unknown Tool, malformed arguments) tolerated for one decision.
 * A weak model produces these occasionally; only a model that cannot recover ends the run.
 */
const MAX_PROTOCOL_RETRIES = 16;
/** Upper bound on one Tool result in the model context, in characters. */
const MAX_TOOL_RESULT_CHARS = 48_000;
const SHORTENED_RESULT = "\n[Tool result shortened to fit context; original output is in the run log.]\n";

/** Asks the model for the next Tool Call and keeps the request inside the context window. */
export class ModelDecisions implements DecisionSource {
  readonly #context: ModelContextManager;

  public constructor(private readonly options: Readonly<{
    mode: ToolMode;
    model: AiSdkModelSession;
    surface: ModelSurface;
    eventLog: HarnessRunEventLog;
    onProgress?: (event: HarnessProgressEvent) => void;
  }>) {
    this.#context = new ModelContextManager(options);
  }

  public async decide(input: Parameters<DecisionSource["decide"]>[0]): Promise<Decision> {
    const { mode, model, surface, eventLog, onProgress } = this.options;
    const { tools, signal, continuity } = input;
    const working = anySignal(signal, continuity);
    // Lost continuity drops the decision; an outside stop ends the run.
    const stopped = (): Extract<Decision, { status: "discarded" | "terminal" }> | undefined =>
      continuity.aborted ? { status: "discarded" }
        : signal?.aborted ? { status: "terminal", endReason: "external_stop" } : undefined;
    let overflowRetries = 0;
    let protocolRetries = 0;
    let correction: string | undefined;
    for (;;) {
      const contextInput = { tools, ...(correction === undefined ? {} : { correction }) };
      let prepared;
      try {
        prepared = await this.#context.prepare(contextInput, working);
      } catch (error) {
        const stop = stopped();
        if (stop !== undefined) return stop;
        throw error;
      }
      if (prepared.removedCycles > 0) onProgress?.({ type: "history_compaction", removedCycles: prepared.removedCycles, retry: overflowRetries });
      const requestId = randomUUID();
      await eventLog.commit({
        type: "model_call_started",
        requestId,
        mode,
        ...(overflowRetries === 0 ? {} : { retry: overflowRetries, trigger: "context_overflow" }),
        protocolRetries,
        ...(correction === undefined ? {} : { correction }),
        limits: model.limits,
        inputTokenEstimate: prepared.estimate,
        inputBudgetTokens: model.limits.contextWindowTokens - model.limits.maxOutputTokens,
        requestSurfaceBytes: Buffer.byteLength(JSON.stringify(prepared.request), "utf8"),
        completedToolCycles: surface.completedCycles.length,
        tools: tools.map((tool) => tool.name),
      });
      const stopBeforeRequest = stopped();
      if (stopBeforeRequest !== undefined) return stopBeforeRequest;

      let decision: ModelSessionDecision;
      try {
        decision = await model.complete(prepared.request, {
          requestId,
          onAttempt: (event) => eventLog.commit({ ...event, requestId }),
          ...(working === undefined ? {} : { signal: working }),
        });
      } catch (error) {
        if (continuity.aborted) {
          await eventLog.commit({ type: "model_call_discarded", request_id: requestId, reason: "continuity_boundary" });
          return { status: "discarded" };
        }
        const failed = { type: "model_call_finished", requestId, outcome: "error", errorDetails: modelErrorDetails(error) };
        if (signal?.aborted || !(error instanceof ModelContextOverflowError)) {
          await eventLog.commit({ ...failed, message: errorMessage(error),
            ...(error instanceof ModelProviderError ? { category: error.category, statusCode: error.statusCode, attempts: error.attempts } : {}) });
          return { status: "terminal", endReason: signal?.aborted ? "external_stop" : "model_transport_error" };
        }
        await eventLog.commit({ ...failed, code: "context_overflow" });
        // After two recoveries only the summary is left: a request that still does not fit is a provider or
        // configuration failure, not a history problem.
        if (overflowRetries === 2) return { status: "terminal", endReason: "model_transport_error" };
        overflowRetries += 1;
        await eventLog.commit({ type: "model_context_overflow", requestId, retry: overflowRetries, message: error.message,
          errorDetails: modelErrorDetails(error) });
        onProgress?.({ type: "model_context_overflow", retry: overflowRetries });
        let removedCycles;
        try {
          removedCycles = await this.#context.recoverOverflow(contextInput, overflowRetries as 1 | 2, working);
        } catch (recoveryError) {
          const stop = stopped();
          if (stop !== undefined) return stop;
          throw recoveryError;
        }
        if (removedCycles > 0) onProgress?.({ type: "history_compaction", removedCycles, retry: overflowRetries });
        const stop = stopped();
        if (stop !== undefined) return stop;
        continue;
      }

      const calls = messageToolCalls(decision.message);
      const response = { finishReason: decision.finishReason ?? null, rawFinishReason: decision.rawFinishReason ?? null,
        reasoningTokens: decision.reasoningTokens ?? null, usage: decision.usage ?? null };
      await eventLog.commit({
        type: "model_call_finished",
        requestId,
        outcome: "ok",
        decisionContext: surface.currentContext,
        assistant: decision.message,
        toolCallCount: calls.length,
        providerToolCallCount: decision.serialToolCallReduction?.received ?? calls.length,
        ...response,
        cacheReadTokens: decision.cacheReadTokens ?? null,
        cacheWriteTokens: decision.cacheWriteTokens ?? null,
      });
      const stopAfterResponse = stopped();
      if (stopAfterResponse !== undefined) return stopAfterResponse;
      this.#context.observe(prepared.request, decision.usage?.inputTokens);

      const call = calls[0];
      const issue = decision.toolCallIssue
        ?? (call === undefined ? { code: "missing_tool_call" as const, message: "Assistant message has no Tool Call" } : undefined);
      if (issue !== undefined || call === undefined) {
        // The unusable response is not committed; the model is asked again with a correction.
        const willRetry = protocolRetries < MAX_PROTOCOL_RETRIES;
        await eventLog.commit({ type: "model_protocol_error", requestId, code: issue!.code, message: issue!.message,
          ...response, protocolRetries, willRetry });
        if (!willRetry) return { status: "terminal", endReason: "model_protocol_error" };
        protocolRetries += 1;
        correction = protocolCorrection(issue!, decision.finishReason);
        continue;
      }
      const reasoning = messageReasoning(decision.message);
      return {
        status: "accepted",
        requestId,
        call,
        title: outerCallTitle(mode, call.name, call.arguments),
        ...(reasoning === "" ? {} : { reasoning }),
        commit: async (result, attachment) => {
          const cycle = surface.commit(decision.message, toolResultMessage(call.id, call.name, boundedToolResult(result, model.limits)), attachment);
          await eventLog.commit({ type: "committed_tool_cycle", requestId, toolCallId: call.id, ...cycle });
        },
      };
    }
  }
}

function protocolCorrection(
  issue: Readonly<{ code: ModelProtocolErrorCode; message: string }>,
  finishReason: string | undefined,
): string {
  const cause = issue.code === "missing_tool_call"
    ? (finishReason === "length"
      ? "Your previous response reached the output limit without a structured tool call. "
      : "Your previous response did not include a structured tool call. ")
    : issue.code === "invalid_tool_call_arguments"
      ? `Your previous tool call could not be used${finishReason === "length" ? " because the response reached the output limit" : ""}: ${issue.message}. `
      : `Your previous tool call could not be used: ${issue.message}. `;
  return cause + "Call one available tool directly to perform the next action, with complete and valid JSON arguments. "
    + "Prioritize producing the tool call; do not only describe a plan or write a textual representation of a tool invocation.";
}

/**
 * One result may fill at most a quarter of the input budget (counted at two characters a token), so a single
 * oversized output cannot push the next request past the context window. The head and the tail are kept.
 */
function boundedToolResult(content: string, limits: Readonly<{ contextWindowTokens: number; maxOutputTokens: number }>): string {
  const limit = Math.min(MAX_TOOL_RESULT_CHARS, Math.floor((limits.contextWindowTokens - limits.maxOutputTokens) / 4) * 2);
  if (content.length <= limit) return content;
  const half = Math.floor(limit / 2);
  return content.slice(0, half).replace(/[\uD800-\uDBFF]$/, "") + SHORTENED_RESULT + content.slice(-half).replace(/^[\uDC00-\uDFFF]/, "");
}

/** A run_code call is shown under the title its author gave it. */
function outerCallTitle(mode: ToolMode, name: string, argumentsJson: string): string {
  if (mode !== "code" || name !== programmaticCodeContract.tool.name) return name;
  try {
    return programmaticCodeContract.tool.input.parse(JSON.parse(argumentsJson), "run_code input").description.trim();
  } catch {
    return name;
  }
}
