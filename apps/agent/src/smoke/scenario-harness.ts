import type { RuntimeClient } from "@evicraft/runtime-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { runHarness, type HarnessProgressEvent, type RunHarnessOptions } from "../harness/run-harness.js";

const SCENARIO_END_CALL_ID = "scenario-end";

function scenarioProgress(
  onProgress: RunHarnessOptions["onProgress"],
  stop: () => void,
) {
  return (event: HarnessProgressEvent) => {
    if (event.type === "outer_call_finished" && event.toolCallId === SCENARIO_END_CALL_ID) {
      stop();
    } else {
      onProgress?.(event);
    }
  };
}

/** Creates the Bot and waits until it is alive, so a scenario can arrange the scene before its Harness Run. */
export async function ensureScenarioBot(client: RuntimeClient, username = "bot"): Promise<void> {
  let actor = await client.ensureBot(username);
  for (let attempt = 0; actor.lifecycle_state !== "alive" && attempt < 200; attempt++) {
    await delay(50);
    actor = await client.actorGet() ?? actor;
  }
  if (actor.lifecycle_state !== "alive") throw new Error("Scenario Bot did not become alive");
}

/** Stop scripted scenarios externally after their final ordinary Tool cycle. */
export function runScenarioHarness(options: RunHarnessOptions) {
  const controller = new AbortController();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
  return runHarness({ ...options, signal,
    onProgress: scenarioProgress(options.onProgress, () => { controller.abort(new Error("Scenario operator stop")); }),
  });
}

export function scriptedToolDecision(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    message: {
      role: "assistant" as const,
      content: [{ type: "tool-call" as const, toolCallId: id, toolName: name, input }],
    },
  };
}

export function scriptedScenarioEnd() {
  return scriptedToolDecision(SCENARIO_END_CALL_ID, "update_plan", { items: [] });
}
