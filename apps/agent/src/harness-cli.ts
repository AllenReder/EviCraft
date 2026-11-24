import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  loadHarnessSecrets,
  validateHarnessConfig,
  type HarnessConfig,
  type HarnessSecrets,
} from "./harness/config.js";
import { createConfiguredLanguageModel } from "./harness/model-route.js";
import { createLiveHarnessTranscript } from "./harness/live-harness-transcript.js";
import type { LanguageModel } from "ai";
import type { OperatorInteraction } from "./harness/operator-interaction.js";
import { createManualOperatorInteraction } from "./harness/manual-operator-interaction.js";
import { RuntimeAdapter } from "./harness/runtime-adapter.js";
import { createProjectSkillSnapshotBuilder } from "./harness/project-skills/project-skill-library.js";
import {
  ownedRuntimeSession,
  runHarness as executeHarness,
  type AgentVisibleContextSnapshot,
  type HarnessRunResult,
  type RunHarnessOptions,
} from "./harness/run-harness.js";

const USAGE = [
  "usage: node apps/agent/dist/cli.js          play the task in EVICRAFT_TASK_FILE with the configured model",
  "       node apps/agent/dist/cli.js manual   choose the Bot's Abilities by hand on that task's world",
  "Both read EVICRAFT_TASK_FILE and EVICRAFT_RUNTIME_BEARER_TOKEN; see docs/harness-interface.md.",
].join("\n");

export interface RunCliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly isTTY: boolean;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly noColor?: boolean;
}

export interface RunCliDependencies {
  readonly runHarness?: (options: RunHarnessOptions) => Promise<HarnessRunResult>;
  readonly createOperatorInteraction?: () => OperatorInteraction;
  readonly registerInterrupt?: (handler: () => void) => () => void;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createLanguageModel?: (config: HarnessConfig, secrets: HarnessSecrets) => LanguageModel;
}

/** The reference Harness as a Harness process: every run starts from the task file the benchmark wrote. */
export async function runCli(
  arguments_: readonly string[] = process.argv.slice(2),
  output: ((line: string) => void) | RunCliIo = defaultIo(),
  dependencies: RunCliDependencies = {},
): Promise<number> {
  const io = typeof output === "function"
    ? { stdout: output, stderr: output, isTTY: false }
    : output;
  if (arguments_.length === 0) return await runTaskCli(io, dependencies);
  if (arguments_.length === 1 && arguments_[0] === "manual") return await runManualCli(io, dependencies);
  io.stdout(USAGE);
  return 2;
}

/** What a run takes from the task file. */
interface HarnessTask {
  readonly assignment: AgentVisibleContextSnapshot;
  readonly botId: string;
  /** The task file's `config` with the Runtime address, the Bot and the output directories filled in. */
  readonly config: unknown;
  readonly harnessConfig: HarnessConfig;
  readonly hazardDecisions?: "enabled" | "disabled";
  readonly skillsPath?: string;
}

/**
 * Reads the task file: the assignment, the Bot that already exists, the Runtime address, an output directory,
 * and this Harness's own settings under `config`. Those are a Harness configuration without `runtime`, `bot`,
 * `data` and `artifacts`, plus optional `hazardDecisions` and `skillsPath` (relative to the working directory).
 */
async function loadHarnessTask(environment: NodeJS.ProcessEnv): Promise<HarnessTask> {
  if (environment.EVICRAFT_TASK_FILE === undefined) throw new Error("EVICRAFT_TASK_FILE is required");
  const task = JSON.parse(await readFile(environment.EVICRAFT_TASK_FILE, "utf8")) as {
    assignment: string; bot: { id: string; username: string }; runtime: { url: string }; outputDirectory: string;
    config: Record<string, unknown> | null;
  };
  const { hazardDecisions, skillsPath, ...settings } = task.config ?? {};
  if (hazardDecisions !== undefined && hazardDecisions !== "enabled" && hazardDecisions !== "disabled") throw new Error("config.hazardDecisions must be enabled or disabled");
  if (skillsPath !== undefined && typeof skillsPath !== "string") throw new Error("config.skillsPath must be a path");
  const config = { ...settings, runtime: { url: task.runtime.url }, bot: { username: task.bot.username },
    data: { directory: task.outputDirectory }, artifacts: { directory: join(task.outputDirectory, "harness") } };
  return {
    assignment: { revision: 0, assertions: [{ id: "assignment", text: task.assignment }] },
    botId: task.bot.id, config, harnessConfig: validateHarnessConfig(config),
    ...(hazardDecisions === undefined ? {} : { hazardDecisions }),
    ...(skillsPath === undefined ? {} : { skillsPath }),
  };
}

/** Plays the task with the configured model until SIGINT or SIGTERM. On a terminal it also shows what the agent does. */
async function runTaskCli(io: RunCliIo, dependencies: RunCliDependencies): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  let task: HarnessTask;
  let secrets: HarnessSecrets;
  try {
    task = await loadHarnessTask(environment);
    secrets = loadHarnessSecrets(task.harnessConfig.model, environment);
  } catch (error) {
    io.stdout(JSON.stringify(configFailure(error instanceof Error ? error.message : "Task file could not be read")));
    return 2;
  }
  const controller = new AbortController();
  const unregisterInterrupt = (dependencies.registerInterrupt ?? registerProcessStop)(() => {
    controller.abort(new Error("Task stopped the Harness"));
  });
  const transcript = io.isTTY
    ? createLiveHarnessTranscript({ verbose: false, color: io.noColor !== true, write: io.stderr })
    : undefined;
  try {
    const result = await (dependencies.runHarness ?? executeHarness)({
      config: task.config,
      agentContext: task.assignment,
      secrets,
      languageModel: (dependencies.createLanguageModel
        ?? ((route, configuredSecrets) => createConfiguredLanguageModel(route.model, configuredSecrets)))(task.harnessConfig, secrets),
      modelLimits: task.harnessConfig.model.limits,
      existingBotId: task.botId,
      signal: controller.signal,
      ...(task.hazardDecisions === undefined ? {} : { hazardDecisions: task.hazardDecisions }),
      ...(task.skillsPath === undefined ? {} : { projectSkillSnapshotBuilder: createProjectSkillSnapshotBuilder({ sourceRoot: resolve(task.skillsPath) }) }),
      createRuntimeSession: async (input) => ownedRuntimeSession(
        await connectRuntimeAdapterWithRetry(input, RuntimeAdapter.connect),
      ),
      ...(transcript === undefined ? {} : { onProgress: (event) => { transcript.render(event); } }),
    });
    io.stdout(JSON.stringify(result));
    // The benchmark ends a healthy run by stopping it; any other ending is a failure of this Harness.
    return result.status !== "setup_failure" && (result.endReason === "external_stop" || result.endReason === "tracer_complete") ? 0 : 1;
  } finally {
    unregisterInterrupt();
  }
}

/**
 * A Manual Ability Session: a person at the terminal chooses the Abilities and their arguments, and no model is
 * called. It reads the same task file, so it runs wherever the Harness does.
 */
async function runManualCli(io: RunCliIo, dependencies: RunCliDependencies): Promise<number> {
  if (!(io.stdinIsTTY ?? io.isTTY) || !(io.stdoutIsTTY ?? io.isTTY)) {
    io.stdout("Manual Ability Session requires an interactive TTY");
    return 2;
  }
  const environment = dependencies.environment ?? process.env;
  let task: HarnessTask;
  try {
    task = await loadHarnessTask(environment);
  } catch (error) {
    io.stdout(`Task file could not be read or is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const runtimeBearerToken = environment.EVICRAFT_RUNTIME_BEARER_TOKEN;
  const secrets: HarnessSecrets = {
    ...(typeof runtimeBearerToken === "string" && runtimeBearerToken.trim() !== ""
      ? { runtimeBearerToken }
      : {}),
  };
  const controller = new AbortController();
  const unregisterInterrupt = (dependencies.registerInterrupt ?? registerProcessInterrupt)(() => {
    controller.abort(new Error("Manual Ability Session interrupted"));
  });
  const operator = (dependencies.createOperatorInteraction ?? createManualOperatorInteraction)();
  const transcript = createLiveHarnessTranscript({
    verbose: false,
    color: io.isTTY && io.noColor !== true,
    write: io.stderr,
  });
  try {
    const result = await (dependencies.runHarness ?? executeHarness)({
      config: task.config,
      agentContext: task.assignment,
      secrets,
      mode: "native",
      operator,
      existingBotId: task.botId,
      hazardDecisions: "disabled",
      signal: controller.signal,
      createRuntimeSession: async (input) => ownedRuntimeSession(
        await connectRuntimeAdapterWithRetry(input, RuntimeAdapter.connect),
      ),
      onProgress: (event) => { transcript.render(event); },
    });
    if (result.status === "setup_failure") {
      io.stdout(`Manual Ability Session failed (${result.failure.code}): ${result.failure.message}`);
    } else {
      io.stdout(`Manual Ability Session ${result.status} (${result.endReason})`);
    }
    io.stdout(`Artifacts: ${task.harnessConfig.artifacts.directory}`);
    return result.status === "ended" || result.status === "completed" ? 0 : 1;
  } finally {
    operator.close?.();
    unregisterInterrupt();
  }
}

export async function connectRuntimeAdapterWithRetry(
  input: Readonly<{ config: HarnessConfig; secrets: HarnessSecrets }>,
  connect: (config: HarnessConfig, secrets: HarnessSecrets) => Promise<RuntimeAdapter>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<RuntimeAdapter> {
  const deadline = Date.now() + input.config.runtime.connectTimeoutMs;
  let lastError: unknown;
  do {
    try {
      return await connect(input.config, input.secrets);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await wait(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw lastError instanceof Error ? lastError : new Error("Runtime connection could not be established");
}

function defaultIo(): RunCliIo {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    isTTY: process.stderr.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    noColor: process.env.NO_COLOR !== undefined,
  };
}

function registerProcessInterrupt(handler: () => void): () => void {
  process.once("SIGINT", handler);
  return () => { process.off("SIGINT", handler); };
}

function registerProcessStop(handler: () => void): () => void {
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => { process.off("SIGINT", handler); process.off("SIGTERM", handler); };
}

function configFailure(message: string): HarnessRunResult {
  return { status: "setup_failure", failure: { code: "CONFIG_INVALID", message } };
}
