import type { AbilityExecutionKind, AbilityInvocationSource, AbilityRuntimeEvent } from "./ability-runtime.js";
import type { ToolMode } from "./config.js";
import type { DecisionRequestSection } from "./decision-request-assembler.js";

/** What a live view of a run is told: the same story as the journal, with durations and readable text. */
export type HarnessProgressEvent =
  | Readonly<{ type: "harness_run_started"; runId: string; runStartedAt: string; mode: ToolMode; username: string; model: string }>
  | Readonly<{ type: "operating_contract"; mode: ToolMode; sections: readonly DecisionRequestSection[]; wireText: string }>
  | Readonly<{ type: "decision_context"; cycle: number; sections: readonly DecisionRequestSection[]; wireText: string }>
  | Readonly<{ type: "model_reasoning"; requestId: string; text: string }>
  | Readonly<{ type: "model_context_overflow"; retry: number }>
  | Readonly<{ type: "history_compaction"; removedCycles: number; retry: number }>
  | Readonly<{ type: "outer_call_started"; requestId: string; toolCallId: string; tool: string; title: string; arguments: string }>
  | Readonly<{
    type: "outer_call_finished";
    requestId: string;
    toolCallId: string;
    tool: string;
    title: string;
    outcome: "ok" | "error" | "interrupted";
    result: unknown;
    modelContent?: string;
    durationMs: number;
  }>
  | Readonly<{ type: "programmatic_execution_started"; rootId: string; executionId: string; depth: number; source: AbilityInvocationSource }>
  | Readonly<{
    type: "programmatic_execution_finished";
    rootId: string;
    executionId: string;
    outcome: "succeeded" | "error";
    message?: string;
    durationMs: number;
    source: AbilityInvocationSource;
  }>
  | Readonly<{
    type: "ability_call_started";
    rootId: string;
    executionId: string;
    parentExecutionId?: string;
    ability: string;
    execution: AbilityExecutionKind;
    depth: number;
    input: unknown;
    source: AbilityInvocationSource;
  }>
  | Readonly<{
    type: "ability_call_finished";
    rootId: string;
    executionId: string;
    ability: string;
    outcome: "succeeded" | "failed" | "error";
    result?: unknown;
    message?: string;
    runtimeTrace?: unknown;
    durationMs: number;
    source: AbilityInvocationSource;
  }>;

/** Turns Ability Runtime events into progress events, adding how long each call or execution took. */
export function abilityProgressProjector(publish: (event: HarnessProgressEvent) => void): (event: AbilityRuntimeEvent) => void {
  const startedAt = new Map<string, number>();
  const elapsed = (key: string): number => {
    const start = startedAt.get(key);
    startedAt.delete(key);
    return start === undefined ? 0 : Math.max(0, performance.now() - start);
  };
  return (event) => {
    const key = `${String(event.rootId)}:${String(event.executionId)}`;
    if (event.type === "programmatic_execution_started" || event.type === "ability_call_started") startedAt.set(key, performance.now());
    if (event.type === "programmatic_execution_started" || event.type === "ability_call_started") {
      const { concurrency: _concurrency, dispatchCount: _dispatchCount, ...progress } = event;
      publish(progress as HarnessProgressEvent);
    } else if (event.type === "programmatic_execution_finished" || event.type === "ability_call_finished") {
      publish({ ...event, durationMs: elapsed(key) } as HarnessProgressEvent);
    }
  };
}
