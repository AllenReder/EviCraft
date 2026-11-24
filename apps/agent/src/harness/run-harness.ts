import { randomUUID } from "node:crypto";
import type { RuntimeObservation, RuntimeOccurrence } from "@evicraft/runtime-sdk";
import type { LanguageModel } from "ai";

import { AgentPlanState } from "./agent-plan.js";
import { AbilityRuntime, type AbilityExecutionContext } from "./ability-runtime.js";
import { selectHarnessAbilities } from "./ability-set.js";
import { OperatorDecisions, runDecisionCycle, type DecisionSource } from "./agent-loop.js";
import { AiSdkModelSession, type AiSdkModelLimits } from "./ai-sdk-model-session.js";
import {
  loadHarnessSecrets,
  validateHarnessConfig,
  validateHarnessSecrets,
  type HarnessConfig,
  type HarnessSecrets,
  type ToolMode,
} from "./config.js";
import { harnessControlToolNames } from "./control-tool-names.js";
import { assembleFreshObservation, decisionContext, operatingContract } from "./decision-request-assembler.js";
import { HarnessRunEventLog, type CommittedHarnessEvent } from "./harness-run-event-log.js";
import { HazardDecisionController, HAZARD_DECISION_POLICY, type HazardKind } from "./hazard-decision-controller.js";
import { ModelDecisions } from "./model-decisions.js";
import { modelProviderAdapter } from "./model-provider-adapter.js";
import { ModelSurface } from "./model-surface.js";
import type { OperatorInteraction } from "./operator-interaction.js";
import {
  captureViewService,
  executeOuterCall,
  modeTools,
  reportedOwnOutcome,
  renderInterruptedAbilityCall,
  renderInterruptedProgrammaticExecution,
  type HarnessControlServices,
} from "./outer-call.js";
import { abilityProgressProjector, type HarnessProgressEvent } from "./progress.js";
import { createProjectSkillSnapshotBuilder, type ProjectSkillSnapshotBuilder } from "./project-skills/project-skill-library.js";
import { RuntimeAdapter, type HarnessReadyState } from "./runtime-adapter.js";
import { ActorUnavailableError, type SetupFailureCode } from "./runtime-errors.js";
import type { ObserveSelfResult } from "./turn-observation.js";
import { errorMessage } from "./util.js";

export type { ToolMode } from "./config.js";
export type { HarnessProgressEvent } from "./progress.js";

export type HarnessEndReason =
  | "tracer_complete"
  | "model_protocol_error"
  | "model_transport_error"
  | "actor_unavailable"
  | "runtime_disconnected"
  | "external_stop"
  | "internal_error";

export type HarnessRunResult =
  | Readonly<{ status: "setup_failure"; failure: Readonly<{ code: SetupFailureCode; message: string }> }>
  | Readonly<{
    status: "ended" | "completed";
    endReason: HarnessEndReason;
    ready: HarnessReadyState;
    runId: string;
    runStartedAt: string;
    latestObservation?: ObserveSelfResult;
  }>;

/** A Runtime connection for one run, and what closing it means for whoever opened it. */
export interface HarnessRuntimeSession {
  readonly adapter: RuntimeAdapter;
  close(): void;
}

/** The run closes the connection when it ends. */
export function ownedRuntimeSession(adapter: RuntimeAdapter): HarnessRuntimeSession {
  return Object.freeze({ adapter, close: () => { adapter.close(); } });
}

/** The connection belongs to the caller; the run only stops listening to it. */
export function borrowedRuntimeSession(adapter: RuntimeAdapter): HarnessRuntimeSession {
  return Object.freeze({ adapter, close: () => { adapter.dispose(); } });
}

export interface AgentVisibleContextSnapshot {
  readonly revision: 0;
  readonly assertions: readonly Readonly<{ readonly id: string; readonly text: string }> [];
}

export function staticGoalContext(goal: string): AgentVisibleContextSnapshot {
  if (goal.trim() === "") throw new Error("Agent-visible goal must be non-blank");
  return freezeAgentContext({ revision: 0, assertions: [{ id: "goal", text: goal }] });
}

export interface RunHarnessOptions {
  readonly config: unknown;
  readonly agentContext: AgentVisibleContextSnapshot;
  readonly secrets?: HarnessSecrets;
  readonly mode?: ToolMode;
  /** The model that decides; exactly one of `languageModel` and `operator` is given. */
  readonly languageModel?: LanguageModel;
  readonly modelLimits?: AiSdkModelLimits;
  /** A person who decides instead of a model; Native Mode only. */
  readonly operator?: OperatorInteraction;
  /** Attach to this Bot instead of creating one. */
  readonly existingBotId?: string;
  /** Supplies the Runtime connection; by default the run connects to `config.runtime.url` and owns the connection. */
  readonly createRuntimeSession?: (input: Readonly<{ config: HarnessConfig; secrets: HarnessSecrets }>) => Promise<HarnessRuntimeSession>;
  readonly hazardDecisions?: "enabled" | "disabled";
  readonly projectSkillSnapshotBuilder?: ProjectSkillSnapshotBuilder;
  /** Stops the run; it ends with `external_stop`. */
  readonly signal?: AbortSignal;
  /** Ends the run as `completed` after this many committed cycles. */
  readonly decisionCycleLimit?: number;
  readonly onProgress?: (event: HarnessProgressEvent) => void;
  readonly onCommittedEvent?: (event: CommittedHarnessEvent) => void | Promise<void>;
}

/** Runtime Occurrences carried into one decision. */
const MAX_TURN_RUNTIME_OCCURRENCES = 64;
/** Ability results kept for the audit receipt of one interrupted action. */
const MAX_INTERRUPTED_ACTION_RESULTS = 64;
/**
 * Consecutive decisions without any game time passing after which the model history is cleared. A model that
 * believes its run is over keeps calling Tools that take no game time, and its history keeps that belief alive.
 */
export const STALLED_DECISIONS_BEFORE_HISTORY_RESET = 20;

/**
 * Plays one Harness Run: connects to the Runtime, takes control of the Bot, and repeats decide-act cycles until
 * the run is stopped, the cycle limit is reached, or something fails that the run cannot recover from.
 */
export async function runHarness(options: RunHarnessOptions): Promise<HarnessRunResult> {
  let config: HarnessConfig;
  let secrets: HarnessSecrets;
  let mode: ToolMode;
  let agentContext: AgentVisibleContextSnapshot;
  try {
    config = validateHarnessConfig(options.config);
    secrets = options.secrets === undefined
      ? loadHarnessSecrets(config.model, process.env, { requireModelProvider: false })
      : validateHarnessSecrets(options.secrets, config.model, { requireModelProvider: false });
    mode = options.mode ?? config.mode;
    if (mode !== "code" && mode !== "native") throw new Error("Tool Mode must be code or native; both is unsupported");
    if (options.operator !== undefined && options.languageModel !== undefined) throw new Error("Specify exactly one of languageModel or operator");
    if (options.operator === undefined && options.languageModel === undefined) throw new Error("Harness Run requires an AI SDK LanguageModel from the CLI");
    if (options.operator !== undefined && mode !== "native") throw new Error("operator requires native Tool Mode");
    if (options.languageModel !== undefined && !validModelLimits(options.modelLimits)) {
      throw new Error("languageModel requires positive modelLimits with maxOutputTokens smaller than contextWindowTokens");
    }
    agentContext = freezeAgentContext(options.agentContext);
  } catch (error) {
    return setupFailure("CONFIG_INVALID", errorMessage(error));
  }

  let session: HarnessRuntimeSession;
  try {
    session = options.createRuntimeSession === undefined
      ? ownedRuntimeSession(await RuntimeAdapter.connect(config, secrets))
      : await options.createRuntimeSession({ config, secrets });
  } catch (error) {
    return setupFailure("RUNTIME_CONNECTION_FAILED", errorMessage(error));
  }
  const adapter = session.adapter;
  let eventLog: HarnessRunEventLog | undefined;
  let ready: HarnessReadyState;
  let abilitySet: ReturnType<typeof selectHarnessAbilities>;
  try {
    eventLog = await HarnessRunEventLog.create(config.artifacts.directory, config.artifacts.runLabel, options.onCommittedEvent);
    ready = options.existingBotId === undefined
      ? await adapter.resolveBot(config.bot.username, options.signal)
      : await adapter.attachBot(options.existingBotId, options.signal);
    abilitySet = selectHarnessAbilities(await adapter.worldKnowledgeProfile(options.signal), config.abilitySet);
  } catch (error) {
    await eventLog?.close().catch(() => {});
    session.close();
    return setupFailure("RUNTIME_CONNECTION_FAILED", errorMessage(error));
  }

  const journal = eventLog;
  const runId = randomUUID();
  const runStartedAt = new Date().toISOString();
  let latestObservation: ObserveSelfResult | undefined;
  let disconnectFailure: Error | undefined;
  const finish = async (endReason: HarnessEndReason, status: "ended" | "completed" = "ended"): Promise<HarnessRunResult> => {
    await journal.commit({ type: "run_finished", endReason });
    return { status, endReason, ready, runId, runStartedAt, ...(latestObservation === undefined ? {} : { latestObservation }) };
  };
  const subscriptions: Array<() => void> = [];
  let hazards: HazardDecisionController | undefined;
  try {
    const hazardsEnabled = options.operator === undefined && options.hazardDecisions !== "disabled";
    const projectSkills = await (options.projectSkillSnapshotBuilder ?? createProjectSkillSnapshotBuilder()).build();
    const agentPlan = new AgentPlanState();
    await journal.commit({ type: "run_started", runId, runStartedAt, mode,
      hazardDecisions: hazardsEnabled ? "enabled" : "disabled", hazardDecisionPolicy: HAZARD_DECISION_POLICY, agentContext });
    options.onProgress?.({ type: "harness_run_started", runId, runStartedAt, mode, username: ready.username, model: config.model.model });

    const runtime = new AbilityRuntime();
    for (const definition of abilitySet.definitions) await runtime.register(definition);
    // Results of the Abilities the current action ran, for the audit receipt if that action is interrupted.
    let actionResults: Readonly<Record<string, unknown>>[] | undefined;
    let omittedActionResults = 0;
    const publishAbilityProgress = options.onProgress === undefined ? undefined : abilityProgressProjector(options.onProgress);
    subscriptions.push(runtime.subscribeEvents(async (event) => {
      await journal.commit(event);
      if (actionResults !== undefined && event.type === "ability_call_finished") {
        if (actionResults.length === MAX_INTERRUPTED_ACTION_RESULTS) { actionResults.shift(); omittedActionResults++; }
        actionResults.push({ ability: event.ability, executionId: event.executionId, rootId: event.rootId,
          outcome: event.outcome, result: event.result });
      }
      publishAbilityProgress?.(event);
    }));
    await journal.commit({ type: "registry_view", abilitySet: abilitySet.metadata, abilities: runtime.names });
    await journal.commit({ type: "project_skill_view", snapshotId: projectSkills.identity, catalog: projectSkills.catalog });

    const controls: HarnessControlServices = {
      loadProjectSkill: (input) => projectSkills.load(input),
      updatePlan: (items) => agentPlan.replace(items),
      ...(config.vision === undefined ? {} : { captureView: captureViewService(adapter, journal.path) }),
    };
    const vision = controls.captureView !== undefined;
    const executionContext = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      runtime: adapter,
    } satisfies AbilityExecutionContext;

    // Continuity is what the current cycle relies on: no new hazard, and a live Runtime connection.
    let continuity: AbortController | undefined;
    const watch = hazards = new HazardDecisionController({
      onTrace: (event) => { void journal.commit(event); },
      onYield: (reasons) => {
        const interrupted = continuity;
        continuity = undefined;
        interrupted?.abort(`Hazard decision requested: ${reasons.join(", ")}`);
      },
    });
    if (!hazardsEnabled) watch.stop();
    const occurrences: RuntimeOccurrence[] = [];
    subscriptions.push(adapter.onOccurrence((occurrence) => {
      // Only the latest body state matters to a decision; other occurrences are kept up to a bound.
      if (occurrence.type === "body_state_changed") {
        const previous = occurrences.findIndex((candidate) => candidate.type === "body_state_changed");
        if (previous >= 0) occurrences.splice(previous, 1);
      }
      occurrences.push(occurrence);
      if (occurrences.length > MAX_TURN_RUNTIME_OCCURRENCES) occurrences.splice(0, occurrences.length - MAX_TURN_RUNTIME_OCCURRENCES);
      void journal.commit({ type: "runtime_occurrence", occurrence });
      watch.handleOccurrence(occurrence);
    }));
    subscriptions.push(adapter.onDisconnect((error) => {
      disconnectFailure ??= error;
      continuity?.abort(disconnectFailure);
      watch.stop();
    }));

    let observationSequence = 0;
    let rendered = "";
    let navigationPolicy: Record<string, unknown> = {};
    const observe = async (): Promise<RuntimeObservation> => {
      if (disconnectFailure !== undefined) throw disconnectFailure;
      const receipt = await adapter.observe(options.signal);
      const assembled = await assembleFreshObservation(runtime, { ...executionContext, invocationSource: "turn_observation_assembler" });
      watch.seed(assembled.hazardBody);
      await journal.commit({ type: "observation", source: "minecraft_pre_step", reason: "decision",
        decisionObservationSequence: ++observationSequence, receipt, observation: assembled.observation, rendered: assembled.rendered });
      latestObservation = assembled.self;
      rendered = assembled.rendered;
      navigationPolicy = assembled.navigationPolicy;
      return receipt;
    };

    let source: DecisionSource;
    let refresh = async (): Promise<void> => { await observe(); };
    if (options.operator !== undefined) {
      source = new OperatorDecisions({ operator: options.operator, eventLog: journal, observation: () => rendered });
    } else {
      const model = new AiSdkModelSession(options.languageModel!, options.modelLimits!, modelProviderAdapter(config.model).capabilities.toolChoice);
      const contract = operatingContract({ mode, runtime, projectSkills: projectSkills.catalog, vision });
      const surface = new ModelSurface(contract.message, decisionContext({ cycle: 0, agentContext, agentPlan: agentPlan.snapshot(),
        navigationPolicy: {}, runtimeOccurrences: [], renderedObservation: "" }), config.vision?.retainedImages);
      source = new ModelDecisions({ mode, model, surface, eventLog: journal,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }) });
      options.onProgress?.({ type: "operating_contract", mode, sections: contract.sections, wireText: contract.wireText });
      let lastTick: number | undefined;
      let stalledDecisions = 0;
      refresh = async () => {
        const { server_tick: tick } = await observe();
        stalledDecisions = tick === lastTick ? stalledDecisions + 1 : 0;
        lastTick = tick;
        if (stalledDecisions >= STALLED_DECISIONS_BEFORE_HISTORY_RESET) {
          const removedCycles = surface.replaceHistory(undefined, []);
          await journal.commit({ type: "history_reset", reason: "no_game_time_advanced", serverTick: tick, stalledDecisions, removedCycles });
          stalledDecisions = 0;
        }
        // Reasons still pending here reached no interrupted Tool result: they were seeded at run start, arrived
        // between cycles, or dropped a pending decision. A committed INTERRUPTED result carries its own reasons.
        const reasons = watch.takeReasons();
        const context = decisionContext({ cycle: observationSequence, agentContext, agentPlan: agentPlan.snapshot(), navigationPolicy,
          runtimeOccurrences: occurrences.splice(0), renderedObservation: rendered,
          ...(reasons.length === 0 ? {} : { trigger: { hazard_reasons: reasons } }) });
        surface.replaceCurrentContext(context);
        options.onProgress?.({ type: "decision_context", cycle: observationSequence, sections: context.sections, wireText: context.wireText });
      };
    }
    // The operator chooses among Abilities only; a model also has the state controls of its mode.
    const tools = options.operator !== undefined ? runtime.modelTools() : modeTools(mode, runtime, vision);

    for (let committed = 0; ;) {
      if (disconnectFailure !== undefined) throw disconnectFailure;
      if (options.signal?.aborted) return await finish("external_stop");
      const cycle = continuity = new AbortController();
      // The hazards that interrupted this cycle's action, taken at the moment it was interrupted.
      let interruptionReasons: readonly HazardKind[] = [];
      let result;
      try {
        result = await runDecisionCycle({
          source, tools, eventLog: journal, continuity: cycle.signal, refresh,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
          execute: async (call, signal) => {
            actionResults = [];
            omittedActionResults = 0;
            const outcome = await executeOuterCall(call.name, call.arguments, mode, runtime, { ...executionContext, signal, invocationSource: "agent" }, controls);
            // An interrupted action keeps the outcome it reported itself, such as an Ability's typed INTERRUPTED
            // result. One that still reports success, or that never started and only echoes the interruption,
            // has no outcome of its own.
            if (signal.aborted && !reportedOwnOutcome(outcome)) return { ok: false, error: errorMessage(signal.reason), interruptedSuppressed: true };
            return outcome;
          },
          onInterruption: () => { interruptionReasons = watch.takeInterruptionReasons(); },
          onInterrupted: async (call, outcome) => {
            await journal.commit({ type: "hazard_action_interrupted", tool: call.name, toolCallId: call.id,
              ...(outcome === undefined || outcome.interruptedSuppressed === true ? {} : { outer_result: outcome }),
              ability_results: actionResults ?? [], omitted_ability_results: omittedActionResults });
          },
          // Without a hazard to name, the interruption came after the action or from a lost connection: the cycle is dropped.
          interruptedResult: (call, outcome) => {
            if (interruptionReasons.length === 0 || (mode === "code" && call.name !== harnessControlToolNames.runCode)) return undefined;
            return mode === "code"
              ? renderInterruptedProgrammaticExecution(interruptionReasons.join(", "), outcome)
              : renderInterruptedAbilityCall(call.name, interruptionReasons.join(", "), outcome);
          },
        });
      } finally {
        actionResults = undefined;
        if (continuity === cycle) continuity = undefined;
      }
      if (result.status === "terminal") return await finish(result.endReason);
      if (result.status === "discarded") continue;
      if (options.signal?.aborted) return await finish("external_stop");
      if (++committed === options.decisionCycleLimit) return await finish("tracer_complete", "completed");
    }
  } catch (error) {
    if (options.signal?.aborted && error === options.signal.reason) return await finish("external_stop");
    const endReason = error === disconnectFailure ? "runtime_disconnected"
      : error instanceof ActorUnavailableError ? "actor_unavailable"
      : "internal_error";
    await journal.commit({ type: "failure", reason: endReason, message: errorMessage(error) });
    return await finish(endReason);
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe();
    hazards?.stop();
    await journal.close();
    session.close();
  }
}

function freezeAgentContext(input: AgentVisibleContextSnapshot): AgentVisibleContextSnapshot {
  if (input.revision !== 0) throw new Error("Agent-visible context revision must be 0");
  const assertionIds = new Set<string>();
  const assertions = input.assertions.map((assertion) => {
    if (assertion.id.trim() === "") throw new Error("Agent-visible assertion id must be non-blank");
    if (assertion.text.trim() === "") throw new Error("Agent-visible assertion text must be non-blank");
    if (assertionIds.has(assertion.id)) throw new Error(`Agent-visible assertion id is duplicated: ${assertion.id}`);
    assertionIds.add(assertion.id);
    return Object.freeze({ id: assertion.id, text: assertion.text });
  });
  return Object.freeze({ revision: 0, assertions: Object.freeze(assertions) });
}

function validModelLimits(limits: AiSdkModelLimits | undefined): limits is AiSdkModelLimits {
  return limits !== undefined
    && Number.isSafeInteger(limits.contextWindowTokens)
    && Number.isSafeInteger(limits.maxOutputTokens)
    && limits.maxOutputTokens > 0
    && limits.maxOutputTokens < limits.contextWindowTokens;
}

function setupFailure(code: SetupFailureCode, message: string): HarnessRunResult {
  return { status: "setup_failure", failure: { code, message } };
}
