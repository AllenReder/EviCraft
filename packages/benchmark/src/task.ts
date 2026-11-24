import type { TaskPlatform } from "./task-runner.js";
import type { AuthoritySnapshotSelection, AuthoritySnapshot, AuthorityTeleport, AuthorityActor, AuthorityBlockPosition, AuthorityBlockSetResult, AuthorityAdvancementDefinitions, Json } from "./index.js";

/** Experiment code owns configuration parsing; importing it acquires no resources. */
export interface BenchmarkTask {
  readonly id: string;
  readonly revision: string;
  configure(configPath: string): Promise<ConfiguredTask>;
}

export interface BenchmarkInstance {
  readonly id: string;
  readonly taskPath: string;
  readonly configPath: string;
}

export interface ConfiguredTask {
  /** Non-secret Task-owned effective conditions, also available to dry-run. */
  readonly configuration?: unknown;
  readonly platform: TaskPlatform;
  run(context: TaskContext): Promise<TaskOutcome>;
}

export interface ExecutableTask extends ConfiguredTask {
  readonly id: string;
  readonly revision: string;
}

/** The outcome returned by a task after it has written any task-owned results. */
export type TaskOutcome = Readonly<{
  readonly status: "success" | "failure" | "timeout";
  readonly reason?: string;
}>;

/** Identity and filesystem locations for one task execution. */
export interface TaskAttemptIdentity {
  readonly instanceId?: string;
  readonly attemptId?: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly attemptIndex: number;
  readonly repetitions: number;
  readonly directory: string;
  readonly taskDirectory: string;
  readonly runnerDirectory: string;
}

/** Minimal context supplied by the task runner; task owns all task-directory output. */
export interface TaskContext {
  readonly identity: TaskAttemptIdentity;
  readonly signal: AbortSignal;
  readonly bot: Readonly<{ id: string }>;
  readonly world: TaskWorld;
  readonly harness: TaskHarness;
  readonly taskDirectory: string;
}

/**
 * The agent under test: a separate process that plays through the Runtime endpoint. The benchmark starts it,
 * stops it, and learns nothing from it; scoring reads the world.
 */
export interface TaskHarness {
  /** Rejects when the process cannot start or exits with a failure; never resolves. */
  readonly failure: Promise<never>;
  /** Resolves once the process has exited, for whatever reason. */
  readonly exited: Promise<void>;
  start(): Promise<void>;
  /** Optional absolute performance.now() deadline supplied by platform cleanup. */
  stop(reason?: string, deadline?: number): Promise<void>;
}

/** A Harness that never plays: for tools and checks that only need the world. */
export function idleHarness(): TaskHarness {
  return { failure: new Promise<never>(() => {}), exited: new Promise<void>(() => {}), async start() {}, async stop() {} };
}

/**
 * Returns a function that awaits one operation, and throws as soon as the Harness fails, the Harness exits, or the
 * attempt is cancelled. Each call owns its promise, so a long attempt accumulates nothing on the Harness promises.
 */
export function whileHarnessRuns(harness: TaskHarness, signal: AbortSignal): <T>(operation: Promise<T>) => Promise<T> {
  let stopped: Readonly<{ error: unknown }> | undefined;
  let rejectCurrent: ((error: unknown) => void) | undefined;
  const stop = (error: unknown) => { stopped ??= { error }; rejectCurrent?.(stopped.error); };
  harness.failure.catch(stop);
  void harness.exited.then(() => stop(new Error("Harness ended before game tick budget")));
  if (signal.aborted) stop(signal.reason);
  else signal.addEventListener("abort", () => stop(signal.reason), { once: true });
  return operation => new Promise((resolve, reject) => {
    if (stopped !== undefined) { reject(stopped.error); return; }
    rejectCurrent = reject;
    operation.then(resolve, reject);
  });
}

/** World facts the Runtime took on one game tick. */
export interface BenchmarkSample extends AuthoritySnapshot { readonly elapsedTick: number; }

export interface BenchmarkRun {
  readonly startTick: number;
  /** The sample at elapsed tick 0. */
  readonly initial: BenchmarkSample;
  /** One sample per interval in tick order; ends after the sample taken on the budget tick. */
  samples(): AsyncIterable<BenchmarkSample>;
}

/** World operations available to tasks during setup and evaluation. */
export interface TaskWorld {
  snapshot(input?: AuthoritySnapshotSelection): Promise<AuthoritySnapshot>;
  advancementDefinitions(): Promise<AuthorityAdvancementDefinitions>;
  teleportActor(input: AuthorityTeleport): Promise<AuthorityActor>;
  setRespawnPoint(input: AuthorityBlockPosition & { yaw?: number }): Promise<void>;
  giveItem(input: { itemId: string; count: number }): Promise<void>;
  setInventorySlot(input: { slot: number; itemId: string; count: number }): Promise<void>;
  setEquipment(input: { slot: "mainhand" | "offhand" | "head" | "chest" | "legs" | "feet"; itemId: string; count: number }): Promise<void>;
  setBlock(input: AuthorityBlockPosition & { blockId: string }): Promise<AuthorityBlockSetResult>;
  executeMinecraftCommand(command: string): Promise<{ success: boolean; result: number }>;
  /** Starts the benchmark clock and releases the World Run that was held for setup. */
  startRun(input: Readonly<{ tickBudget: number; sampleIntervalTicks: number }>): Promise<BenchmarkRun>;
  /** Holds or releases the World Run. A released pause-when-idle World Run still advances only on demand. */
  readonly time: Readonly<{ pause(): Promise<void>; resume(): Promise<void>; isPaused(): Promise<boolean> }>;
}

export function defineTask(task: BenchmarkTask): BenchmarkTask {
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(task.id)) throw new Error("Task id is invalid");
  if (task.revision.trim() === "") throw new Error("Task revision must be non-blank");
  if (typeof task.configure !== "function") throw new Error("Task configure must be a function");
  return Object.freeze(task);
}
