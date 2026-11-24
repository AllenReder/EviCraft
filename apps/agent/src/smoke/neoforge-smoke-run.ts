import { type ChildProcess } from "node:child_process";
import { spawnServerProcess as spawn } from "@evicraft/server-host";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNotListening,
  hasExited,
  reservePorts,
  stopServer as stopNeoForgeServer,
} from "./neoforge-server-process.js";
import { parseRuntimeSdkSmokeScope } from "./runtime-sdk-smoke.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const RUNTIME_ROOT = join(REPOSITORY_ROOT, "runtime");
const expectedServerStops = new WeakSet<ChildProcess>();
const neoForgeProcessLifecycles = new WeakMap<
  NeoForgeSmokeServerProcess, NeoForgeProcessLifecycle
>();
export const DEFAULT_NEOFORGE_SMOKE_RUNS = resolve(
  REPOSITORY_ROOT, "build", "neoforge-smoke-runs",
);

export interface NeoForgeSmokeServerDirectory {
  readonly directory: string;
  readonly logPath: string;
  readonly minecraftPort: number;
  readonly runtimePort: number;
  readonly authorityPort: number;
}

export interface AuthenticatedNeoForgeSmokeServerDirectory
  extends NeoForgeSmokeServerDirectory {
  readonly rconPort: number;
  readonly rconPassword: string;
}

export interface NeoForgeSmokeRun {
  readonly runDirectory: string;
  readonly missingToken: NeoForgeSmokeServerDirectory;
  readonly authenticated: AuthenticatedNeoForgeSmokeServerDirectory;
  startServer(
    server: NeoForgeSmokeServerDirectory,
    options?: Readonly<{
      bearerToken?: string;
      authorityBearerToken?: string;
      worldKnowledgeProfile?: string;
      pauseWhenIdle?: boolean;
    }>,
  ): Promise<NeoForgeSmokeServerProcess>;
  stopServer(server: NeoForgeSmokeServerProcess): Promise<void>;
}

export interface NeoForgeSmokeServerProcess
  extends NeoForgeSmokeServerDirectory {
  readonly output: () => string;
  readonly failure: () => Error | undefined;
  readonly exited: () => boolean;
}

type NeoForgeSmokeProcessTesting = Readonly<{
  /** A controlled child launch used by focused lifecycle tests. */
  spawn: () => ChildProcess;
  stopTimeoutMs?: number;
  /** Overrides NeoForge shutdown escalation for deterministic lifecycle tests. */
  stop?: (child: ChildProcess, timeoutMs: number) => Promise<void>;
  /** Overrides port-release checks without changing the real NeoForge path. */
  assertPortReleased?: (port: number) => Promise<void>;
  /** Supplies a controlled log stream for log-close/error tests. */
  createLog?: (path: string) => WriteStream;
}>;

/**
 * Runs one of the two fixed Standard NeoForge Smoke Gate GameTest shapes.
 * The caller supplies only the Gate-specific Gradle namespace, receipt assertion,
 * and receipt. Ports, artifacts, stream capture, shutdown, and retention stay here.
 */
export async function runNeoForgeGameTest(input: Readonly<{
  id: "route-mutation" | "world-knowledge-profile";
  namespace: string;
  assertOutput: (output: string) => void;
  receipt: (ports: Readonly<{ minecraftPort: number; runtimePort: number }>) => void;
  /** A controlled NeoForge GameTest launch used by the focused lifecycle tests. */
  testing?: NeoForgeSmokeProcessTesting;
}>): Promise<void> {
  const runDirectory = await createRunDirectory(`gametest-${input.id}`);
  const gameDirectory = join(runDirectory, "server");
  const logPath = join(runDirectory, "server.log");
  try {
    await mkdir(gameDirectory);
    const [minecraftPort, runtimePort] = await reservePorts(2);
    if (minecraftPort === undefined || runtimePort === undefined) {
      throw new Error(`Could not reserve ${input.id} GameTest ports`);
    }
    await runNeoForgeProcess({
      id: `${input.id} GameTests`,
      runDirectory,
      logPath,
      ports: [minecraftPort, runtimePort],
      spawn: input.testing?.spawn ?? (() => spawn("./gradlew", [
        `-Dmcagent.gametest.namespace=${input.namespace}`,
        ":core:neoforge:runGameTestServer",
        "--no-daemon",
        "--console=plain",
        `-PgameTestMinecraftPort=${minecraftPort}`,
        `-PgameTestGameDir=${gameDirectory}`,
      ], {
        cwd: RUNTIME_ROOT,
        env: {
          ...process.env,
          EVICRAFT_RUNTIME_PORT: String(runtimePort),
          EVICRAFT_RUNTIME_BEARER_TOKEN: `${input.id}-gametest-${randomUUID()}`,
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })),
      ...(input.testing?.stopTimeoutMs === undefined
        ? {} : { stopTimeoutMs: input.testing.stopTimeoutMs }),
      ...(input.assertOutput === undefined ? {} : { assertOutput: input.assertOutput }),
      receipt: () => input.receipt({ minecraftPort, runtimePort }),
      failureMessage: (result, output) =>
        `${input.id} GameTests failed (${result.code ?? result.signal ?? "unknown"})\n${output}`,
      echoOutput: true,
      ...(input.testing === undefined ? {} : { testing: input.testing }),
    });
  } catch (error) {
    if (error instanceof NeoForgeSmokeRunError) throw error;
    throw new NeoForgeSmokeRunError(errorMessage(error), runDirectory, [], undefined, { cause: error });
  }
}

/** Runs the thin Runtime SDK smoke entrypoint with Standard-gate process ownership. */
export async function runRuntimeSdkSmoke(input: Readonly<{
  profile?: "grounded_evidence" | "loaded_world_state";
  scope?: string;
  assertOutput?: (output: string) => void;
  /** A controlled SDK-smoke launch used only by focused lifecycle tests. */
  testing?: NeoForgeSmokeProcessTesting;
}> = {}): Promise<void> {
  const scope = parseRuntimeSdkSmokeScope(input.scope);
  const runDirectory = await createRunDirectory("sdk-smoke");
  const logPath = join(runDirectory, "sdk-smoke.log");
  const environment = { ...process.env };
  delete environment.EVICRAFT_WORLD_KNOWLEDGE_PROFILE;
  delete environment.EVICRAFT_SMOKE_SCOPE;
  if (input.profile !== undefined) environment.EVICRAFT_WORLD_KNOWLEDGE_PROFILE = input.profile;
  if (scope !== undefined) environment.EVICRAFT_SMOKE_SCOPE = scope;
  await runNeoForgeProcess({
    id: "NeoForge smoke",
    runDirectory,
    logPath,
    ports: [],
    spawn: input.testing?.spawn ?? (() => spawn(process.execPath, ["apps/agent/test/integration/runtime-sdk/runner.mjs"], {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: ["inherit", "pipe", "pipe"],
    })),
    ...(input.testing?.stopTimeoutMs === undefined
      ? {} : { stopTimeoutMs: input.testing.stopTimeoutMs }),
    ...(input.assertOutput === undefined ? {} : { assertOutput: input.assertOutput }),
    failureMessage: (result, output) =>
      `NeoForge smoke exited with ${result.code ?? result.signal ?? "unknown"}\n${output}`,
    echoOutput: true,
    ...(input.testing === undefined ? {} : { testing: input.testing }),
  });
}

type NeoForgeSmokeProcessInput = Readonly<{
  id: string;
  runDirectory: string;
  logPath: string;
  ports: readonly number[];
  spawn: () => ChildProcess;
  stopTimeoutMs?: number;
  assertOutput?: (output: string) => void;
  receipt?: () => void;
  failureMessage?: (result: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>, output: string) => string;
  echoOutput?: boolean;
  testing?: NeoForgeSmokeProcessTesting;
}>;

type NeoForgeProcessResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}>;

/**
 * The private lifecycle seam shared by one-shot gate children and interactive
 * Runtime server children.  The public smoke interfaces deliberately expose
 * only the scenario-relevant handle; all process and resource mechanics stay
 * behind this Standard-gate-only implementation.
 */
interface NeoForgeProcessLifecycle {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly failure: () => Error | undefined;
  readonly completed: Promise<NeoForgeProcessResult>;
  readonly stop: () => Promise<void>;
}

type NeoForgeProcessLifecycleInput = Readonly<{
  logPath: string;
  ports: readonly number[];
  spawn: () => ChildProcess;
  stopTimeoutMs?: number;
  echoOutput?: boolean;
  testing?: NeoForgeSmokeProcessTesting;
  unexpectedExit?: (
    result: NeoForgeProcessResult,
    output: string,
  ) => Error;
}>;

/**
 * Owns the lifecycle shared by the fixed GameTest and SDK smoke child shapes.
 * Keep this seam specific to the Standard NeoForge Smoke Gate; conformance
 * scenarios intentionally retain their own orchestration and oracle semantics.
 */
async function runNeoForgeProcess(input: NeoForgeSmokeProcessInput): Promise<void> {
  const cleanupFailures: string[] = [];
  let primaryFailure: unknown;
  let interruptedSignal: NodeJS.Signals | undefined;
  let lifecycle: NeoForgeProcessLifecycle | undefined;
  let onInterrupt = () => {};
  let onTerminate = () => {};
  let resolveInterruptStop!: () => void;
  let rejectInterruptStop!: (error: unknown) => void;
  const interruptStop = new Promise<void>((resolve, reject) => {
    resolveInterruptStop = resolve;
    rejectInterruptStop = reject;
  });

  const recordCleanupFailure = (error: unknown) => {
    for (const message of cleanupErrorMessages(error)) {
      if (!cleanupFailures.includes(message)) cleanupFailures.push(message);
    }
  };

  const stopAfterInterrupt = (signal: NodeJS.Signals) => {
    interruptedSignal ??= signal;
    const stop = lifecycle?.stop();
    if (stop !== undefined) {
      void stop.then(resolveInterruptStop, rejectInterruptStop);
    }
  };
  onInterrupt = () => stopAfterInterrupt("SIGINT");
  onTerminate = () => stopAfterInterrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    lifecycle = await openNeoForgeProcess({
      logPath: input.logPath,
      ports: input.ports,
      spawn: input.spawn,
      ...(input.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: input.stopTimeoutMs }),
      ...(input.echoOutput === undefined ? {} : { echoOutput: input.echoOutput }),
      ...(input.testing === undefined ? {} : { testing: input.testing }),
    });
    if (interruptedSignal !== undefined) {
      void lifecycle.stop().then(resolveInterruptStop, rejectInterruptStop);
    }

    try {
      const result = await Promise.race<NeoForgeProcessResult>([
        lifecycle.completed,
        interruptStop.then(
          () => ({ code: 0, signal: null } satisfies NeoForgeProcessResult),
          (error: unknown) => { throw error; },
        ),
      ]);
      if (result.error !== undefined) throw result.error;
      if (result.code !== 0) {
        throw new Error(input.failureMessage?.(result, lifecycle.output())
          ?? `${input.id} failed (${result.code ?? result.signal ?? "unknown"})\n${lifecycle.output()}`);
      }
    } catch (error) {
      primaryFailure = error;
    }
  } catch (error) {
    primaryFailure ??= error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (lifecycle !== undefined) {
      try {
        await lifecycle.stop();
      } catch (error) {
        recordCleanupFailure(error);
        if (!hasExited(lifecycle.child)) {
          try {
            await lifecycle.stop();
          } catch (retryError) {
            recordCleanupFailure(retryError);
          }
        }
        if (!hasExited(lifecycle.child)) {
          recordCleanupFailure(new Error("NeoForge process remained alive after cleanup"));
        }
      }
    } else {
      for (const port of input.ports) {
        try {
          await (input.testing?.assertPortReleased ?? assertNotListening)(port);
        } catch (error) {
          recordCleanupFailure(error);
        }
      }
    }
  }

  if (primaryFailure === undefined && interruptedSignal !== undefined) {
    primaryFailure = new Error(`NeoForge Smoke Run interrupted by ${interruptedSignal}`);
  }
  if (primaryFailure === undefined && cleanupFailures.length === 0) {
    try {
      if (input.assertOutput !== undefined) {
        input.assertOutput(await readFile(input.logPath, "utf8"));
      }
      input.receipt?.();
    } catch (error) {
      primaryFailure = error;
    }
  }
  if (primaryFailure !== undefined || cleanupFailures.length > 0 || interruptedSignal !== undefined) {
    throw new NeoForgeSmokeRunError(
      errorMessage(primaryFailure), input.runDirectory, cleanupFailures, interruptedSignal,
      { ...(primaryFailure === undefined ? {} : { cause: primaryFailure }) },
    );
  }
  try {
    await rm(input.runDirectory, { recursive: true });
  } catch (error) {
    throw new NeoForgeSmokeRunError(
      errorMessage(error), input.runDirectory, [], undefined, { cause: error },
    );
  }
}

interface NeoForgeLogLifecycle {
  readonly completed: Promise<Error | undefined>;
  readonly closed: () => boolean;
  readonly failure: () => Error | undefined;
  readonly output: () => string;
  readonly append: (text: string) => void;
  readonly record: (error: unknown) => void;
  readonly close: () => void;
}

function observeNeoForgeLog(log: WriteStream): NeoForgeLogLifecycle {
  let failure: Error | undefined;
  let tail = "";
  let ended = false;
  let settle!: (error: Error | undefined) => void;
  const completed = new Promise<Error | undefined>((resolvePromise) => {
    let settled = false;
    settle = (error) => {
      if (settled) return;
      settled = true;
      resolvePromise(error);
    };
  });
  const record = (error: unknown) => {
    failure ??= asError(error);
    if (ended) settle(failure);
  };
  log.once("error", record);
  log.once("close", () => settle(failure));
  return {
    completed,
    closed: () => ended,
    failure: () => failure,
    output: () => tail,
    append(text) {
      tail = `${tail}${text}`.slice(-64 * 1024);
    },
    record,
    close() {
      if (ended) return;
      ended = true;
      try {
        log.end();
      } catch (error) {
        record(error);
      }
    },
  };
}

async function openNeoForgeProcess(
  input: NeoForgeProcessLifecycleInput,
): Promise<NeoForgeProcessLifecycle> {
  let log: WriteStream | undefined;
  let observedLog: NeoForgeLogLifecycle | undefined;
  let child: ChildProcess;
  try {
    log = input.testing?.createLog?.(input.logPath)
      ?? createWriteStream(input.logPath, { flags: "a" });
    observedLog = observeNeoForgeLog(log);
    child = input.spawn();
  } catch (error) {
    if (observedLog !== undefined) {
      const cleanupFailures: string[] = [];
      observedLog.close();
      const logFailure = await observedLog.completed;
      if (logFailure !== undefined) cleanupFailures.push(errorMessage(logFailure));
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures.map((message) => new Error(message))],
          [errorMessage(error), ...cleanupFailures].join("; "),
        );
      }
    }
    throw error;
  }

  let completionSettled = false;
  let processErrorSeen = false;
  let processClosed = false;
  let exitResult: NeoForgeProcessResult | undefined;
  let exitDrainFallback: NodeJS.Immediate | undefined;
  let settleCompletion!: (result: NeoForgeProcessResult) => void;
  const completed = new Promise<NeoForgeProcessResult>((resolvePromise) => {
    settleCompletion = (result) => {
      if (completionSettled) return;
      completionSettled = true;
      resolvePromise(result);
    };
  });
  const capture = (chunk: Buffer | string, output?: NodeJS.WriteStream) => {
    const text = String(chunk);
    if (!observedLog.closed() && !log.destroyed && observedLog.failure() === undefined) {
      try {
        log.write(text);
      } catch (error) {
        observedLog.record(error);
      }
    }
    if (input.echoOutput && output !== undefined) {
      try {
        output.write(text);
      } catch (error) {
        observedLog.record(error);
      }
    }
    observedLog.append(text);
  };
  const onError = (error: Error) => {
    processErrorSeen = true;
    observedLog.append(`\n${error.message}`);
    observedLog.record(error);
    observedLog.close();
    processClosed = true;
    settleCompletion({ code: null, signal: null, error });
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    const result = { code, signal } satisfies NeoForgeProcessResult;
    exitResult = result;
    if (!processErrorSeen && !expectedServerStops.has(child) && input.unexpectedExit !== undefined) {
      observedLog.record(input.unexpectedExit(result, observedLog.output()));
    }
    exitDrainFallback = setImmediate(() => {
      exitDrainFallback = undefined;
      finalizeProcess(exitResult ?? result);
    });
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exitDrainFallback !== undefined) {
      clearImmediate(exitDrainFallback);
      exitDrainFallback = undefined;
    }
    finalizeProcess(exitResult ?? { code, signal });
  };
  const finalizeProcess = (result: NeoForgeProcessResult) => {
    if (processClosed) return;
    processClosed = true;
    observedLog.close();
    settleCompletion(result);
  };
  child.stdout?.on("data", (chunk: Buffer) => capture(chunk, process.stdout));
  child.stderr?.on("data", (chunk: Buffer) => capture(chunk, process.stderr));
  child.once("error", onError);
  child.once("exit", onExit);
  child.once("close", onClose);

  // The enclosing Standard-gate adapter owns signal listeners and calls this
  // lifecycle's stop state machine. Attaching a direct forwarder here would
  // send SIGTERM ahead of the graceful SIGINT wait and bypass escalation.
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopPromise = stopNeoForgeProcess({
      child,
      ports: input.ports,
      observedLog,
      stopTimeoutMs: input.stopTimeoutMs ?? input.testing?.stopTimeoutMs ?? 30_000,
      ...(input.testing?.stop === undefined ? {} : { stop: input.testing.stop }),
      ...(input.testing?.assertPortReleased === undefined
        ? {} : { assertPortReleased: input.testing.assertPortReleased }),
    }).catch((error) => {
      // A failed escalation may be retried by the enclosing Run's active set.
      stopPromise = undefined;
      throw error;
    });
    return stopPromise;
  };

  // A controlled child can already have exited before this adapter is opened.
  // Real ChildProcess instances emit `exit`, but settling here keeps the seam
  // deterministic for focused adapters that expose only exitCode/signalCode.
  if (hasExited(child)) {
    queueMicrotask(() => onExit(child.exitCode, child.signalCode));
  }

  return {
    child,
    output: observedLog.output,
    failure: observedLog.failure,
    completed,
    stop,
  };
}

async function stopNeoForgeProcess(input: Readonly<{
  child: ChildProcess;
  ports: readonly number[];
  observedLog: NeoForgeLogLifecycle;
  stopTimeoutMs: number;
  stop?: (child: ChildProcess, timeoutMs: number) => Promise<void>;
  assertPortReleased?: (port: number) => Promise<void>;
}>): Promise<void> {
  const failures: string[] = [];
  const recordFailure = (error: unknown) => {
    const message = errorMessage(error);
    if (!failures.includes(message)) failures.push(message);
  };
  try {
    if (!hasExited(input.child)) expectedServerStops.add(input.child);
    await (input.stop ?? stopNeoForgeServer)(input.child, input.stopTimeoutMs);
  } catch (error) {
    if (!hasExited(input.child)) expectedServerStops.delete(input.child);
    recordFailure(error);
  }
  for (const port of input.ports) {
    try {
      await (input.assertPortReleased ?? assertNotListening)(port);
    } catch (error) {
      recordFailure(error);
    }
  }
  input.observedLog.close();
  const logFailure = await input.observedLog.completed;
  if (logFailure !== undefined) recordFailure(logFailure);
  const finalFailure = input.observedLog.failure();
  if (finalFailure !== undefined) recordFailure(finalFailure);
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((message) => new Error(message)), failures.join("; "),
    );
  }
}


export async function runWithNeoForgeSmokeRun(input: Readonly<{
  runsRoot?: string;
  /** A controlled NeoForge server launch used by focused lifecycle tests. */
  testing?: NeoForgeSmokeProcessTesting;
  execute: (run: NeoForgeSmokeRun) => Promise<void>;
}>): Promise<Readonly<{ retained: false; runDirectory: string }>> {
  const runsRoot = resolve(input.runsRoot ?? DEFAULT_NEOFORGE_SMOKE_RUNS);
  const runId = uniqueSmokeRunId();
  const runDirectory = resolve(runsRoot, runId);
  if (runDirectory === runsRoot || !runDirectory.startsWith(`${runsRoot}${sep}`)) {
    throw new Error("NeoForge Smoke Run escapes runs root");
  }
  await mkdir(runsRoot, { recursive: true });
  await mkdir(runDirectory).catch((error: unknown) => {
    if (isCode(error, "EEXIST")) throw new Error(`NeoForge Smoke Run already exists: ${runDirectory}`);
    throw error;
  });

  const active = new Set<NeoForgeSmokeServerProcess>();
  let primaryFailure: unknown;
  let interruptedSignal: NodeJS.Signals | undefined;
  const cleanupFailures: string[] = [];
  const recordCleanupFailure = (error: unknown) => {
    for (const message of cleanupErrorMessages(error)) {
      if (!cleanupFailures.includes(message)) cleanupFailures.push(message);
    }
  };
  const stopActiveServers = () => {
    for (const server of active) {
      void stopRuntimeServer(server)
        .catch(recordCleanupFailure)
        .finally(() => {
          if (server.exited()) active.delete(server);
        });
    }
  };
  const onInterrupt = () => {
    interruptedSignal ??= "SIGINT";
    stopActiveServers();
  };
  const onTerminate = () => {
    interruptedSignal ??= "SIGTERM";
    stopActiveServers();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const ports = await reservePorts(7);
    const [missingMinecraftPort, missingRuntimePort, missingAuthorityPort,
      minecraftPort, runtimePort, authorityPort, rconPort] = ports;
    if (missingMinecraftPort === undefined || missingRuntimePort === undefined
        || missingAuthorityPort === undefined || minecraftPort === undefined
        || runtimePort === undefined || authorityPort === undefined || rconPort === undefined) {
      throw new Error("Could not reserve NeoForge Smoke Run ports");
    }
    const missingToken = await createServerDirectory({
      directory: join(runDirectory, "missing-token-server"),
      minecraftPort: missingMinecraftPort,
      runtimePort: missingRuntimePort,
      authorityPort: missingAuthorityPort,
    });
    const rconPassword = `neoforge-${randomUUID()}`;
    const authenticated = await createAuthenticatedServerDirectory({
      directory: join(runDirectory, "authenticated-server"),
      minecraftPort,
      runtimePort,
      rcon: { port: rconPort, password: rconPassword },
      authorityPort,
    });
    const run: NeoForgeSmokeRun = {
      runDirectory,
      missingToken,
      authenticated,
      async startServer(server, options) {
        if (interruptedSignal !== undefined) {
          throw new Error(`NeoForge Smoke Run interrupted by ${interruptedSignal}`);
        }
        const running = await startRuntimeServer(server, options, input.testing);
        active.add(running);
        if (interruptedSignal !== undefined) {
          throw new Error(`NeoForge Smoke Run interrupted by ${interruptedSignal}`);
        }
        return running;
      },
      async stopServer(server) {
        try {
          await stopRuntimeServer(server);
          active.delete(server);
        } catch (error) {
          // Keep a still-running child tracked so the run-level finally block
          // gets one more bounded shutdown attempt instead of orphaning it.
          for (const message of cleanupErrorMessages(error)) {
            if (!cleanupFailures.includes(message)) cleanupFailures.push(message);
          }
          if (server.exited()) active.delete(server);
          throw error;
        }
      },
    };
    await input.execute(run);
  } catch (error) {
    primaryFailure = error;
  } finally {
    for (const server of [...active]) {
      try {
        await stopRuntimeServer(server);
      } catch (error) {
        recordCleanupFailure(error);
      }
      if (server.exited()) active.delete(server);
    }
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
  if (primaryFailure === undefined && interruptedSignal !== undefined) {
    primaryFailure = new Error(`NeoForge Smoke Run interrupted by ${interruptedSignal}`);
  }
  if (primaryFailure !== undefined || cleanupFailures.length > 0 || interruptedSignal !== undefined) {
    throw new NeoForgeSmokeRunError(
      errorMessage(primaryFailure), runDirectory, cleanupFailures, interruptedSignal,
      { ...(primaryFailure === undefined ? {} : { cause: primaryFailure }) },
    );
  }
  try {
    await rm(runDirectory, { recursive: true });
  } catch (error) {
    throw new NeoForgeSmokeRunError(errorMessage(error), runDirectory, [], undefined, { cause: error });
  }
  return { retained: false, runDirectory };
}

export class NeoForgeSmokeRunError extends Error {
  public constructor(
    message: string,
    public readonly retainedRunDirectory: string,
    public readonly cleanupFailures: readonly string[] = [],
    public readonly interruptedSignal?: NodeJS.Signals,
    options?: ErrorOptions,
  ) {
    super([
      message,
      ...(cleanupFailures.length === 0 ? [] : [`Cleanup failures: ${cleanupFailures.join("; ")}`]),
      ...(interruptedSignal === undefined ? [] : [`Interrupted by: ${interruptedSignal}`]),
      `Retained NeoForge Smoke Run: ${retainedRunDirectory}`,
    ].join("\n"), options);
    this.name = "NeoForgeSmokeRunError";
  }
}

async function createServerDirectory(input: Readonly<{
  directory: string;
  minecraftPort: number;
  runtimePort: number;
  authorityPort: number;
}>): Promise<NeoForgeSmokeServerDirectory> {
  await writeServerDirectory(input);
  return serverDirectory(input);
}

async function startRuntimeServer(
  server: NeoForgeSmokeServerDirectory,
  options: Readonly<{
    bearerToken?: string;
    authorityBearerToken?: string;
    worldKnowledgeProfile?: string;
    /** Start the World Run in pause-when-idle mode; the SDK scenarios otherwise assume real time. */
    pauseWhenIdle?: boolean;
  }> = {},
  testing?: NeoForgeSmokeProcessTesting,
): Promise<NeoForgeSmokeServerProcess> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    EVICRAFT_RUNTIME_PORT: String(server.runtimePort),
    EVICRAFT_BENCHMARK_AUTHORITY_PORT: String(server.authorityPort),
    ...(options.pauseWhenIdle === true ? { EVICRAFT_RUNTIME_PAUSE_WHEN_IDLE: "true" } : {}),
  };
  if (options.bearerToken === undefined) delete environment.EVICRAFT_RUNTIME_BEARER_TOKEN;
  else environment.EVICRAFT_RUNTIME_BEARER_TOKEN = options.bearerToken;
  if (options.authorityBearerToken === undefined) {
    delete environment.EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN;
  } else {
    environment.EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN = options.authorityBearerToken;
  }
  if (options.worldKnowledgeProfile !== undefined) {
    environment.EVICRAFT_WORLD_KNOWLEDGE_PROFILE = options.worldKnowledgeProfile;
  }
  let lifecycle: NeoForgeProcessLifecycle;
  try {
    lifecycle = await openNeoForgeProcess({
      logPath: server.logPath,
      ports: serverPorts(server),
      spawn: testing?.spawn ?? (() => spawn("./gradlew", [
        `-Dmcagent.minecraft.port=${server.minecraftPort}`,
        ":core:neoforge:runServer",
        "--no-daemon",
        "--console=plain",
        `-PruntimeServerGameDir=${server.directory}`,
      ], {
        cwd: RUNTIME_ROOT,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      })),
      ...(testing?.stopTimeoutMs === undefined
        ? {} : { stopTimeoutMs: testing.stopTimeoutMs }),
      ...(testing === undefined ? {} : { testing }),
      unexpectedExit: (result, output) => new Error(
        `NeoForge server exited with ${result.code ?? result.signal ?? "unknown"}\n${output}`,
      ),
    });
  } catch (error) {
    const failures = [...cleanupErrorMessages(error)];
    for (const port of serverPorts(server)) {
      try {
        await (testing?.assertPortReleased ?? assertNotListening)(port);
      } catch (portError) {
        for (const message of cleanupErrorMessages(portError)) {
          if (!failures.includes(message)) failures.push(message);
        }
      }
    }
    if (failures.length > cleanupErrorMessages(error).length) {
      throw new AggregateError(
        failures.map((message) => new Error(message)), failures.join("; "),
      );
    }
    throw error;
  }
  const running = {
    ...server,
    output: lifecycle.output,
    failure: lifecycle.failure,
    exited: () => hasExited(lifecycle.child),
  };
  neoForgeProcessLifecycles.set(running, lifecycle);
  return running;
}

async function stopRuntimeServer(server: NeoForgeSmokeServerProcess): Promise<void> {
  const lifecycle = neoForgeProcessLifecycles.get(server);
  if (lifecycle === undefined) return;
  try {
    await lifecycle.stop();
  } finally {
    if (hasExited(lifecycle.child)) neoForgeProcessLifecycles.delete(server);
  }
}

function serverPorts(
  server: NeoForgeSmokeServerDirectory & Readonly<{ rconPort?: number }>,
): readonly number[] {
  return [
    server.minecraftPort,
    server.runtimePort,
    server.authorityPort,
    ...("rconPort" in server && typeof server.rconPort === "number" ? [server.rconPort] : []),
  ];
}

async function createAuthenticatedServerDirectory(input: Readonly<{
  directory: string;
  minecraftPort: number;
  runtimePort: number;
  authorityPort: number;
  rcon: Readonly<{ port: number; password: string }>;
}>): Promise<AuthenticatedNeoForgeSmokeServerDirectory> {
  await writeServerDirectory(input);
  return {
    ...serverDirectory(input),
    rconPort: input.rcon.port,
    rconPassword: input.rcon.password,
  };
}

async function writeServerDirectory(input: Readonly<{
  directory: string;
  minecraftPort: number;
  runtimePort: number;
  authorityPort: number;
  rcon?: Readonly<{ port: number; password: string }>;
}>): Promise<void> {
  await mkdir(input.directory);
  await writeFile(join(input.directory, "eula.txt"), "eula=true\n", { flag: "wx" });
  await writeFile(join(input.directory, "server.properties"), [
    "allow-flight=false",
    "allow-nether=true",
    "difficulty=easy",
    `enable-rcon=${input.rcon === undefined ? "false" : "true"}`,
    "gamemode=survival",
    "generate-structures=true",
    "level-name=world",
    "level-seed=302",
    "max-players=4",
    "online-mode=false",
    "server-ip=127.0.0.1",
    `server-port=${input.minecraftPort}`,
    "spawn-monsters=false",
    "spawn-protection=0",
    "spawn-radius=0",
    ...(input.rcon === undefined ? [] : [
      `rcon.port=${input.rcon.port}`,
      `rcon.password=${input.rcon.password}`,
    ]),
  ].join("\n") + "\n", { flag: "wx" });
}

function serverDirectory(input: Readonly<{
  directory: string;
  minecraftPort: number;
  runtimePort: number;
  authorityPort: number;
}>): NeoForgeSmokeServerDirectory {
  return {
    directory: input.directory,
    logPath: join(input.directory, "server.log"),
    minecraftPort: input.minecraftPort,
    runtimePort: input.runtimePort,
    authorityPort: input.authorityPort,
  };
}

function uniqueSmokeRunId(): string {
  return `neoforge-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
}

async function createRunDirectory(label: string): Promise<string> {
  const runsRoot = resolve(DEFAULT_NEOFORGE_SMOKE_RUNS);
  const runDirectory = resolve(runsRoot, `${label}-${uniqueSmokeRunId()}`);
  if (runDirectory === runsRoot || !runDirectory.startsWith(`${runsRoot}${sep}`)) {
    throw new Error("NeoForge Smoke Run escapes runs root");
  }
  await mkdir(runsRoot, { recursive: true });
  await mkdir(runDirectory).catch((error: unknown) => {
    if (isCode(error, "EEXIST")) throw new Error(`NeoForge Smoke Run already exists: ${runDirectory}`);
    throw error;
  });
  return runDirectory;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "NeoForge Smoke Run failed";
}

function cleanupErrorMessages(error: unknown): readonly string[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap((nested) => cleanupErrorMessages(nested));
  }
  return [errorMessage(error)];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function isCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
