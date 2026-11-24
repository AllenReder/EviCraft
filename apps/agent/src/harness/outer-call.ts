import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CAMERA_UNAVAILABLE_ERROR_CODE, RuntimeSdkError } from "@evicraft/runtime-sdk";

import type { AgentPlanItem, AgentPlanProjection } from "./agent-plan.js";
import { AbilityRuntime, ProgrammaticExecutionError, ToolCallError, type AbilityExecutionContext } from "./ability-runtime.js";
import type { ToolMode } from "./config.js";
import { captureViewControl, harnessStateControls, loadSkillControl, updatePlanControl } from "./control-tools.js";
import { harnessControlToolNames } from "./control-tool-names.js";
import { imageMessage, type AgentToolProjection, type ModelMessage } from "./model-surface-message.js";
import { programmaticCodeContract } from "./programmatic-code-contract.js";
import type { ProjectSkillLoadExecution, ProjectSkillLoadInput } from "./project-skills/project-skill-library.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import { ActorUnavailableError } from "./runtime-errors.js";
import { executeToolContract, projectToolContract } from "./tool-contract.js";
import type { InferToolSchema } from "./tool-schema.js";
import { errorMessage } from "./util.js";

/** What one Tool call of the model, or one selection of the operator, came to. */
export interface OuterResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string | Readonly<{ name: string; code: string; message: string }>;
  readonly programmatic?: Readonly<Record<string, unknown>>;
  readonly runtimeTrace?: Readonly<Record<string, unknown>>;
  readonly modelContent?: string;
  /** Image message committed right after the tool result; journaled as its placeholder text. */
  readonly attachment?: Readonly<{ message: ModelMessage; journalPlaceholder: string }>;
  /**
   * Marks a placeholder outcome produced from the abort reason itself. It is left out of the
   * hazard_action_interrupted audit event because the Ability's actual settled outcome is journaled separately.
   */
  readonly interruptedSuppressed?: boolean;
}

export interface HarnessControlServices {
  loadProjectSkill(input: ProjectSkillLoadInput): ProjectSkillLoadExecution;
  updatePlan(items: readonly AgentPlanItem[]): AgentPlanProjection;
  /** Present only when the run enables vision and a camera client serves the World Run. */
  captureView?(input: InferToolSchema<typeof captureViewControl.input>, signal?: AbortSignal): Promise<Readonly<{
    result: InferToolSchema<typeof captureViewControl.output>;
    attachment?: Readonly<{ message: ModelMessage; journalPlaceholder: string }>;
  }>>;
}

/** Turns the Bot, stores the frame under `views/` beside the journal, and returns it as an image attachment. */
export function captureViewService(adapter: RuntimeAdapter, journalPath: string): NonNullable<HarnessControlServices["captureView"]> {
  let capturedViews = 0;
  return async (input, signal) => {
    if (input.target !== undefined && (input.yaw !== undefined || input.pitch !== undefined)) {
      return { result: { ok: false as const, error: "INVALID_ARGUMENTS" as const,
        message: "Give either target or yaw/pitch, not both." } };
    }
    let view;
    try {
      view = await adapter.captureView({
        ...(input.yaw === undefined ? {} : { yaw: input.yaw }),
        ...(input.pitch === undefined ? {} : { pitch: input.pitch }),
        ...(input.target === undefined ? {} : { target_block: input.target }),
      }, signal);
    } catch (error) {
      const unavailable = error instanceof RuntimeSdkError && error.code === CAMERA_UNAVAILABLE_ERROR_CODE;
      return { result: { ok: false as const, message: errorMessage(error),
        error: unavailable ? "CAMERA_UNAVAILABLE" as const : "CAPTURE_FAILED" as const } };
    }
    const file = join("views", `view-${String(++capturedViews).padStart(4, "0")}.png`);
    await mkdir(join(dirname(journalPath), "views"), { recursive: true });
    await writeFile(join(dirname(journalPath), file), Buffer.from(view.image_base64, "base64"));
    const data = { dimension: view.dimension, eye: view.eye, yaw: view.yaw, pitch: view.pitch,
      width: view.width, height: view.height, server_tick: view.server_tick,
      ...(view.target_block === undefined ? {} : { target: view.target_block }) };
    return {
      result: { ok: true as const, data },
      attachment: {
        message: imageMessage(`capture_view image: yaw ${view.yaw.toFixed(1)}, pitch ${view.pitch.toFixed(1)}`
          + (view.target_block === undefined ? "" : `, aimed at block (${view.target_block.x}, ${view.target_block.y}, ${view.target_block.z})`),
        view.image_base64),
        journalPlaceholder: `[image file ${file}]`,
      },
    };
  };
}

/** The Tools one mode exposes: every Ability in Native Mode, run_code in Code Mode, and the state controls in both. */
export function modeTools(mode: ToolMode, runtime: AbilityRuntime, vision: boolean): readonly AgentToolProjection[] {
  const stateControls = [...harnessStateControls, ...(vision ? [captureViewControl] : [])].map(projectToolContract);
  if (mode === "native") return [...runtime.modelTools(), ...stateControls];
  return [
    projectToolContract(programmaticCodeContract.tool),
    ...stateControls,
  ];
}

export async function executeOuterCall(
  name: string,
  argumentsJson: string,
  mode: ToolMode,
  runtime: AbilityRuntime,
  context: AbilityExecutionContext,
  controls: HarnessControlServices,
): Promise<OuterResult> {
  try {
    if (name === loadSkillControl.name) {
      let runtimeTrace: Readonly<Record<string, unknown>> | undefined;
      const execution = await executeToolContract(
        loadSkillControl,
        parseJson(argumentsJson, name),
        async (input) => {
          const loaded = controls.loadProjectSkill(input);
          runtimeTrace = loaded.trace;
          return loaded.result;
        },
      );
      return {
        ok: execution.canonicalOutput.ok,
        result: execution.canonicalOutput,
        ...(runtimeTrace === undefined ? {} : { runtimeTrace }),
        modelContent: execution.modelContent,
      };
    }
    if (name === captureViewControl.name && controls.captureView !== undefined) {
      const captureView = controls.captureView;
      let attachment: Readonly<{ message: ModelMessage; journalPlaceholder: string }> | undefined;
      const execution = await executeToolContract(
        captureViewControl,
        parseJson(argumentsJson, name),
        async (input) => {
          const captured = await captureView(input, context.signal);
          attachment = captured.attachment;
          return captured.result;
        },
      );
      return {
        ok: execution.canonicalOutput.ok,
        result: execution.canonicalOutput,
        modelContent: execution.modelContent,
        ...(attachment === undefined ? {} : { attachment }),
      };
    }
    if (name === updatePlanControl.name) {
      const execution = await executeToolContract(
        updatePlanControl,
        parseJson(argumentsJson, name),
        async (input) => controls.updatePlan(input.items),
      );
      return {
        ok: true,
        result: execution.canonicalOutput,
        modelContent: execution.modelContent,
      };
    }
    if (mode === "code" && name === harnessControlToolNames.runCode) {
      let programmatic: Readonly<Record<string, unknown>> | undefined;
      const execution = await executeToolContract(
        programmaticCodeContract.tool,
        parseJson(argumentsJson, name),
        async (input) => {
          const result = await runtime.runCode(input.code, context);
          programmatic = Object.freeze({
            rootId: result.rootId,
            executionId: result.executionId,
            logs: result.logs.map((log) => Object.freeze({ ...log })),
          });
          return {
            logs: result.logs.map((log) => log.text),
            ...(result.result === undefined ? {} : { result: result.result }),
          };
        },
      );
      return {
        ok: true,
        result: execution.canonicalOutput,
        ...(programmatic === undefined ? {} : { programmatic }),
        modelContent: execution.modelContent,
      };
    }
    if (mode === "native") {
      const execution = await runtime.dispatchTool(name, parseJson(argumentsJson, name), context);
      return {
        ok: true,
        result: execution.canonicalOutput,
        modelContent: execution.modelContent,
      };
    }
    throw new ToolCallError(name, `Tool ${name} is unavailable in ${mode} mode`);
  } catch (error) {
    if (error instanceof ActorUnavailableError) throw error;
    if (error instanceof ProgrammaticExecutionError) {
      return {
        ok: false,
        error: { name: error.name, code: error.code, message: error.message },
        programmatic: {
          ...(error.rootId === undefined ? {} : { rootId: error.rootId }),
          ...(error.executionId === undefined ? {} : { executionId: error.executionId }),
          logs: error.logs,
          failure: { code: error.code, message: error.message },
        },
        modelContent: error.modelOutput
          ?? `Programmatic Execution failed (${error.code}): ${error.message}`,
      };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Renders the model-visible INTERRUPTED tool result for a hazard-preempted
 * Programmatic Execution, reusing the failure-rendering shape
 * (header plus the output already captured at abort time).
 */
export function renderInterruptedProgrammaticExecution(
  reason: string,
  result: OuterResult | undefined,
): string {
  const header = `Programmatic Execution interrupted (${reason})`;
  const error = result?.error;
  // A Programmatic Execution's outer error is always its structured failure
  // ({ name, code, message }); the plain cancellation adds no detail.
  const detail = error !== undefined && typeof error !== "string" && error.message !== "Programmatic Execution canceled"
    ? `: ${error.message}`
    : "";
  const modelContent = result?.modelContent;
  const captured = modelContent === undefined ? ""
    : modelContent.slice(modelContent.indexOf("Captured output:\n"));
  return captured === "" ? header + detail : `${header}${detail}\n${captured}`;
}

/**
 * Whether an interrupted outer call reported an outcome of its own: an Ability's typed failure (its own
 * INTERRUPTED result, for one) or a failed Programmatic Execution with its captured output. A call that still
 * reports success, or one that failed only because it was cut off before it started, did not.
 */
export function reportedOwnOutcome(result: OuterResult): boolean {
  if (!result.ok) return result.programmatic !== undefined;
  const canonical = result.result;
  return canonical !== null && typeof canonical === "object" && !Array.isArray(canonical)
    && (canonical as Readonly<Record<string, unknown>>).ok === false;
}

/**
 * Renders the model-visible INTERRUPTED tool result for a hazard-preempted
 * Native Mode Ability call. Whatever the Ability's state at interruption —
 * started (its typed INTERRUPTED result), queued-not-started (a raw rejection
 * reason), or signal-unresponsive (a normally settled result) — the cycle
 * commits as one uniform INTERRUPTED shape whose text faithfully carries the
 * Ability's actual settled outcome. A queued call never produced an outcome,
 * so the raw rejection reason it raced with stays out of the model surface.
 */
export function renderInterruptedAbilityCall(
  name: string,
  reason: string,
  result: OuterResult | undefined,
): string {
  const header = `Ability ${name} interrupted (${reason})`;
  if (result?.interruptedSuppressed === true) return `${header}: no outcome settled before the interruption`;
  const state = result?.modelContent ?? (result === undefined ? "no outcome settled before the interruption"
    : JSON.stringify(result.result ?? (result.error === undefined ? { ok: result.ok } : { ok: result.ok, error: result.error })));
  return `${header}: ${state}`;
}

function parseJson(value: string, tool: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new ToolCallError(tool, `${tool} arguments must be valid JSON`); }
}

export function canonicalJson(value: unknown, tool: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new ToolCallError(tool, `${tool} arguments must be JSON-serializable`);
  return serialized;
}
