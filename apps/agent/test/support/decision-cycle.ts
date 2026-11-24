import { runDecisionCycle, type CycleInput } from "../../src/harness/agent-loop.js";
import type { AiSdkModelSession } from "../../src/harness/ai-sdk-model-session.js";
import type { HarnessRunEventLog } from "../../src/harness/harness-run-event-log.js";
import { ModelDecisions } from "../../src/harness/model-decisions.js";
import type { ModelSurface } from "../../src/harness/model-surface.js";
import type { AgentToolProjection } from "../../src/harness/model-surface-message.js";
import type { HarnessProgressEvent } from "../../src/harness/progress.js";

/** One model-driven decide-act cycle over a Model Surface, as the run loop performs it. */
export function decisionCycle(options: Readonly<{
  mode: "code" | "native";
  model: AiSdkModelSession;
  surface: ModelSurface;
  eventLog: HarnessRunEventLog;
  onProgress?: (event: HarnessProgressEvent) => void;
}>) {
  const source = new ModelDecisions(options);
  return {
    run: (input: Readonly<{
      tools: readonly AgentToolProjection[];
      continuitySignal: AbortSignal;
      executeOuterCall: CycleInput["execute"];
      signal?: AbortSignal;
      prepareDecision?: CycleInput["refresh"];
      onInterrupted?: CycleInput["onInterrupted"];
      interruptedResultContent?: CycleInput["interruptedResult"];
      onInterruptionSnapshot?: CycleInput["onInterruption"];
    }>) => runDecisionCycle({
      source, tools: input.tools, eventLog: options.eventLog, continuity: input.continuitySignal, execute: input.executeOuterCall,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.prepareDecision === undefined ? {} : { refresh: input.prepareDecision }),
      ...(input.onInterrupted === undefined ? {} : { onInterrupted: input.onInterrupted }),
      ...(input.interruptedResultContent === undefined ? {} : { interruptedResult: input.interruptedResultContent }),
      ...(input.onInterruptionSnapshot === undefined ? {} : { onInterruption: input.onInterruptionSnapshot }),
    }),
  };
}
