import { randomUUID } from "node:crypto";

import { ToolCallError } from "./ability-runtime.js";
import type { HarnessRunEventLog } from "./harness-run-event-log.js";
import type { AgentToolProjection } from "./model-surface-message.js";
import type { OperatorInteraction } from "./operator-interaction.js";
import { canonicalJson, type OuterResult } from "./outer-call.js";
import type { HarnessProgressEvent } from "./progress.js";
import { anySignal } from "./util.js";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** What the model or the operator chose to do next, or why no choice will be acted on. */
export type Decision =
  | Readonly<{
    status: "accepted";
    requestId: string;
    call: ToolCall;
    /** Operator-facing name of the action. */
    title: string;
    reasoning?: string;
    /** Records the outcome where the next decision will see it. */
    commit(result: string, attachment?: OuterResult["attachment"]): Promise<void>;
  }>
  /** Continuity was lost while deciding; the next cycle decides again from fresh context. */
  | Readonly<{ status: "discarded" }>
  | Readonly<{ status: "terminal"; endReason: "model_protocol_error" | "model_transport_error" | "external_stop" }>;

export interface DecisionSource {
  decide(input: Readonly<{ tools: readonly AgentToolProjection[]; signal?: AbortSignal; continuity: AbortSignal }>): Promise<Decision>;
}

export type CycleResult =
  | Readonly<{ status: "committed" }>
  | Readonly<{ status: "discarded" }>
  | Readonly<{ status: "terminal"; endReason: "model_protocol_error" | "model_transport_error" | "external_stop" }>;

export interface CycleInput {
  readonly source: DecisionSource;
  readonly tools: readonly AgentToolProjection[];
  readonly eventLog: HarnessRunEventLog;
  /** The run is being stopped from outside. */
  readonly signal?: AbortSignal;
  /**
   * Aborts when the plan this cycle is following stops being valid: a hazard appeared, or the Runtime
   * connection was lost. A pending decision is dropped and a running action is cancelled.
   */
  readonly continuity: AbortSignal;
  readonly onProgress?: (event: HarnessProgressEvent) => void;
  /** Brings the decision context up to date; runs once, before the decision. */
  refresh?(): Promise<void>;
  execute(call: ToolCall, signal: AbortSignal): Promise<OuterResult>;
  /**
   * Runs synchronously at the moment continuity is lost during the action. A hazard that arrives later, while the
   * interrupted action settles, then belongs to the next decision and not to this one's result.
   */
  onInterruption?(): void;
  /** Audit receipt for an interrupted action; `result` is absent when the action did not settle in time. */
  onInterrupted?(call: ToolCall, result: OuterResult | undefined): Promise<void>;
  /** The result text of an interrupted action. Returning undefined drops the cycle instead of committing it. */
  interruptedResult?(call: ToolCall, result: OuterResult | undefined): string | undefined;
}

/** How long an interrupted action may take to report its own outcome before the cycle moves on without it. */
const INTERRUPTION_SETTLE_GRACE_MS = 500;

/** One cycle: decide, act, and record the outcome for the next decision. */
export async function runDecisionCycle(input: CycleInput): Promise<CycleResult> {
  const { continuity, signal, eventLog } = input;
  if (continuity.aborted) return { status: "discarded" };
  if (signal?.aborted) return { status: "terminal", endReason: "external_stop" };
  await input.refresh?.();
  const decision = await input.source.decide({ tools: input.tools, continuity, ...(signal === undefined ? {} : { signal }) });
  if (decision.status !== "accepted") return decision;

  const { requestId, call, title } = decision;
  if (decision.reasoning) input.onProgress?.({ type: "model_reasoning", requestId, text: decision.reasoning });
  const outerCall = { requestId, toolCallId: call.id, tool: call.name, title };
  const startedAt = performance.now();
  await eventLog.commit({ type: "outer_call_started", ...outerCall, arguments: call.arguments });
  input.onProgress?.({ type: "outer_call_started", ...outerCall, arguments: call.arguments });
  const discard = async (): Promise<CycleResult> => {
    await eventLog.commit({ type: "model_call_discarded", request_id: requestId, reason: "hazard_preemption" });
    return { status: "discarded" };
  };
  // Nothing was done yet, so nothing was interrupted: whatever broke continuity stays for the next decision.
  if (continuity.aborted) return await discard();
  continuity.addEventListener("abort", () => input.onInterruption?.(), { once: true });

  let result: OuterResult | undefined;
  let failure: Readonly<{ error: unknown }> | undefined;
  try {
    if (!signal?.aborted) result = await settledOrAbandoned(input.execute(call, anySignal(signal, continuity)!), continuity);
  } catch (error) { failure = { error }; }
  if (continuity.aborted) await input.onInterrupted?.(call, result);
  if (failure !== undefined) throw failure.error;
  if (signal?.aborted) return { status: "terminal", endReason: "external_stop" };

  let interruptedContent: string | undefined;
  if (continuity.aborted) {
    interruptedContent = input.interruptedResult?.(call, result);
    if (interruptedContent === undefined) return await discard();
  }
  if (result === undefined && interruptedContent === undefined) throw new Error("Action settled without a result");
  const { modelContent, attachment, interruptedSuppressed: _suppressed, ...audited } = result ?? { ok: false };
  const finished = {
    ...outerCall,
    outcome: interruptedContent !== undefined ? "interrupted" as const : result?.ok === true ? "ok" as const : "error" as const,
    result: interruptedContent !== undefined ? { interrupted: true } : audited,
  };
  await eventLog.commit({ type: "outer_call_finished", ...finished });
  input.onProgress?.({ type: "outer_call_finished", ...finished, ...(modelContent === undefined ? {} : { modelContent }),
    durationMs: Math.max(0, performance.now() - startedAt) });
  await decision.commit(interruptedContent ?? modelContent ?? JSON.stringify(audited), interruptedContent === undefined ? attachment : undefined);
  return { status: "committed" };
}

/**
 * Waits for the action. Once continuity is lost, the action has a short grace period to report its own
 * outcome (a cancelled Runtime task normally does at once); after that the cycle continues without it, and a
 * late outcome or failure reaches only the journal.
 */
async function settledOrAbandoned(action: Promise<OuterResult>, continuity: AbortSignal): Promise<OuterResult | undefined> {
  let grace: ReturnType<typeof setTimeout> | undefined;
  let startGrace!: () => void;
  const abandoned = new Promise<undefined>((resolve) => {
    startGrace = () => { grace = setTimeout(() => resolve(undefined), INTERRUPTION_SETTLE_GRACE_MS); };
  });
  if (continuity.aborted) startGrace();
  else continuity.addEventListener("abort", startGrace, { once: true });
  try {
    return await Promise.race([action, abandoned]);
  } finally {
    clearTimeout(grace);
    continuity.removeEventListener("abort", startGrace);
    action.catch(() => { /* a failure after the grace period is already journaled by the Ability Runtime */ });
  }
}

/** A person choosing each Ability call; the choice is journaled and its outcome shown with the next choice. */
export class OperatorDecisions implements DecisionSource {
  #previousResult: string | undefined;

  public constructor(private readonly options: Readonly<{
    operator: OperatorInteraction;
    eventLog: HarnessRunEventLog;
    /** The rendered observation the operator chooses from. */
    observation(): string;
  }>) {}

  public async decide(input: Parameters<DecisionSource["decide"]>[0]): Promise<Decision> {
    const { operator, eventLog } = this.options;
    let selection;
    try {
      selection = await operator.choose({
        observation: this.options.observation(),
        ...(this.#previousResult === undefined ? {} : { previousResult: this.#previousResult }),
        tools: input.tools,
      }, { signal: anySignal(input.signal, input.continuity)! });
    } catch (error) {
      if (input.continuity.aborted) return { status: "discarded" };
      if (input.signal?.aborted) return { status: "terminal", endReason: "external_stop" };
      throw error;
    }
    if (!input.tools.some((tool) => tool.name === selection.toolName)) {
      throw new ToolCallError(selection.toolName, `Operator selected unavailable Ability ${selection.toolName}`);
    }
    const selectionId = randomUUID();
    await eventLog.commit({ type: "operator_selection", selectionId, provenance: "operator", tool: selection.toolName, input: selection.input });
    return {
      status: "accepted",
      requestId: selectionId,
      call: { id: selectionId, name: selection.toolName, arguments: canonicalJson(selection.input, selection.toolName) },
      title: selection.toolName,
      commit: async (result) => { this.#previousResult = result; },
    };
  }
}
