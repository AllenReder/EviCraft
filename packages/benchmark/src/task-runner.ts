import { parse } from "yaml";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { defineTask, type BenchmarkTask, type ExecutableTask, type BenchmarkInstance, type TaskAttemptIdentity, type TaskWorld, type TaskHarness, type TaskOutcome } from "./task.js";

export interface TaskResources {
  readonly world: TaskWorld;
  readonly bot: Readonly<{ id: string }>;
  readonly harness: TaskHarness;
  /** Must stop every owned resource, including Harness, and release ports by the
   * absolute performance.now() deadline, when provided. */
  close(deadline?: number): Promise<void>;
  readonly failure?: Promise<never>;
  captureDiagnostics?(): Promise<void>;
}
export interface TaskPlatform {
  /** Returns an existing Bot and paused world. On rejection, release partial resources.
   * If releasing them fails, reject with TaskPreparationError so cleanup is not reported complete.
   * cleanupDeadline starts the shared cleanup budget on first call; invoke only
   * when cleanup begins (including preparation failure or cancellation). */
  prepare(input: Readonly<{ task: ExecutableTask; identity: TaskAttemptIdentity; signal: AbortSignal; cleanupDeadline?: () => number }>): Promise<TaskResources>;
}
/** A failed startup whose partially acquired resources also failed to close. */
export class TaskPreparationError extends Error {
  public constructor(cause: unknown, public readonly cleanupError: unknown) {
    super(`Task preparation failed: ${String(cause)}; cleanup failed: ${String(cleanupError)}`, { cause });
    this.name = "TaskPreparationError";
  }
}

export interface RunTaskOptions {
  readonly task: ExecutableTask;
  readonly outputDirectory: string;
  readonly repetitions: number;
  readonly concurrency: number;
  readonly watchdogMs: number;
  readonly cleanupTimeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface TaskAttemptRecord {
  readonly watchdogMs: number;
  readonly identity: TaskAttemptIdentity;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runnerStatus: "completed" | "process_failure" | "task_protocol_error" | "watchdog_timeout" | "cancelled";
  readonly taskOutcome: TaskOutcome | null;
  readonly error?: string;
  readonly cleanup: Readonly<{ status: "completed" | "failed"; error?: string }>;
}

export async function loadTask(directory: string): Promise<BenchmarkTask> {
  const module = await import(pathToFileURL(resolve(directory, "task.ts")).href);
  return defineTask(module.default);
}

export async function runTask(options: RunTaskOptions): Promise<readonly TaskAttemptRecord[]> {
  for (const [name, value] of [["repetitions", options.repetitions], ["concurrency", options.concurrency], ["watchdogMs", options.watchdogMs], ["cleanupTimeoutMs", options.cleanupTimeoutMs ?? 10_000]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  const task = options.task;
  const batchDirectory = resolve(options.outputDirectory, randomUUID());
  await mkdir(batchDirectory, { recursive: true });
  const records: TaskAttemptRecord[] = new Array(options.repetitions);
  await dispatchAttempts(options.repetitions, options.concurrency, options.signal, async attemptIndex => {
    const directory = join(batchDirectory, `attempt-${attemptIndex}`);
    const identity: TaskAttemptIdentity = { taskId: task.id, taskRevision: task.revision, attemptIndex, repetitions: options.repetitions, directory, taskDirectory: join(directory, "task"), runnerDirectory: join(directory, "runner") };
    const record = await runAttempt(options, identity);
    records[attemptIndex] = record;
    return record;
  });
  return records.filter(record => record !== undefined);
}

async function runAttempt(options: Omit<RunTaskOptions, "task" | "repetitions" | "concurrency"> & { task: ExecutableTask | (() => Promise<ExecutableTask>) }, identity: TaskAttemptIdentity): Promise<TaskAttemptRecord> {
  await Promise.all([mkdir(identity.taskDirectory, { recursive: true }), mkdir(identity.runnerDirectory, { recursive: true })]);
  const startedAt = new Date().toISOString();
  await saveJson(join(identity.runnerDirectory, "attempt.json"), { identity, startedAt, watchdogMs: options.watchdogMs, runnerStatus: "running", taskOutcome: null });
  const controller = new AbortController();
  let resources: TaskResources | undefined;
  let preparation: Promise<TaskResources> | undefined;
  let runnerStatus: TaskAttemptRecord["runnerStatus"] = "completed";
  let taskOutcome: TaskOutcome | null = null;
  let error: string | undefined;
  let cleanup: TaskAttemptRecord["cleanup"] = { status: "completed" };
  let timedOut = false;
  let cleanupEndsAt: number | undefined;
  const cleanupDeadline = () => cleanupEndsAt ??= performance.now() + (options.cleanupTimeoutMs ?? 10_000);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!resources) return Promise.resolve();
    const ownedResources = resources;
    return closing ??= Promise.resolve().then(() => ownedResources.close(cleanupDeadline()));
  };
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("Run cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Runner watchdog expired")); }, options.watchdogMs);
  let abortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      if (controller.signal.aborted) abortListener();
      else controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const execute = async () => {
      controller.signal.throwIfAborted();
      const task = typeof options.task === "function" ? await options.task() : options.task;
      controller.signal.throwIfAborted();
      identity = { ...identity, taskId: task.id, taskRevision: task.revision };
      await saveJson(join(identity.runnerDirectory, "attempt.json"), { identity, startedAt, watchdogMs: options.watchdogMs, runnerStatus: "running", taskOutcome: null });
      if (task.configuration !== undefined) await writeFile(join(identity.taskDirectory, "configuration.json"), `${JSON.stringify(task.configuration, null, 2)}\n`);
      controller.signal.throwIfAborted();
      preparation = task.platform.prepare({ task, identity, signal: controller.signal, cleanupDeadline });
      resources = await preparation;
      if (controller.signal.aborted) { await close(); controller.signal.throwIfAborted(); }
      const running = task.run({ identity, signal: controller.signal, world: resources.world, bot: resources.bot, harness: resources.harness, taskDirectory: identity.taskDirectory });
      return resources.failure ? Promise.race([running, resources.failure]) : running;
    };
    const outcome = await Promise.race([execute(), aborted]);
    if (!outcome || !["success", "failure", "timeout"].includes(outcome.status)) throw new TaskProtocolError("Task must return a TaskOutcome");
    if (outcome.reason !== undefined && typeof outcome.reason !== "string") throw new TaskProtocolError("Task outcome reason must be a string");
    taskOutcome = { status: outcome.status, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) };
  } catch (cause) {
    runnerStatus = timedOut ? "watchdog_timeout" : options.signal?.aborted ? "cancelled" : cause instanceof TaskProtocolError ? "task_protocol_error" : "process_failure";
    error = String(cause);
    if (resources?.captureDiagnostics && runnerStatus === "process_failure") {
      try { await boundedClose(resources.captureDiagnostics(), 10_000); }
      catch (diagnosticError) { await writeFile(join(identity.runnerDirectory, "diagnostics-error.txt"), String(diagnosticError)); }
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    cleanupDeadline();
    controller.abort(new Error("Attempt finished"));
    try { await boundedClose((async () => {
      // A cancelled prepare must settle its own partial cleanup before claiming success.
      if (preparation) {
        try { await preparation; }
        catch (cause) {
          if (cause instanceof TaskPreparationError) throw cause.cleanupError;
          return;
        }
      }
      await close();
    })(), Math.max(0, cleanupDeadline() - performance.now())); } catch (cause) { cleanup = { status: "failed", error: String(cause) }; }
  }
  const record: TaskAttemptRecord = { watchdogMs: options.watchdogMs, identity, startedAt, finishedAt: new Date().toISOString(), runnerStatus, taskOutcome, ...(error === undefined ? {} : { error }), cleanup };
  await saveJson(join(identity.runnerDirectory, "attempt.json"), record);
  return record;
}

async function boundedClose(closing: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closing, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Resource cleanup timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

class TaskProtocolError extends Error {}

export interface BatchExecution {
  readonly instance: BenchmarkInstance;
  /** Zero-based planned repetition, stable across recovery Attempts. */
  readonly repetition: number;
}
export interface BatchPlan {
  readonly concurrency: number;
  readonly executions: readonly BatchExecution[];
}

export async function loadBatch(path: string): Promise<BatchPlan> {
  const value = parse(await readFile(path, "utf8"));
  if (!value || !Array.isArray(value.instances) || value.instances.length === 0) throw new Error("Batch instances must be a nonempty array");
  positiveInteger(value.concurrency, "concurrency");
  const ids = new Set<string>();
  const executions: BatchExecution[] = [];
  for (const entry of value.instances) {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id)) throw new Error("Instance id must be nonempty and unique in the Batch");
    ids.add(entry.id);
    for (const key of ["taskPath", "configPath"] as const) {
      if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error(`${key} must be a nonempty path`);
    }
    positiveInteger(entry.repetitions, "repetitions");
    const instance = { id: entry.id, taskPath: resolve(dirname(path), entry.taskPath), configPath: resolve(dirname(path), entry.configPath) };
    for (let repetition = 0; repetition < entry.repetitions; repetition++) executions.push({ instance, repetition });
  }
  return { concurrency: value.concurrency, executions };
}

function positiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

export interface RunBatchOptions {
  readonly plan: BatchPlan;
  readonly outputDirectory: string;
  readonly watchdogMs: number;
  readonly cleanupTimeoutMs?: number;
  readonly signal?: AbortSignal;
}
interface SavedBatch {
  readonly plan: BatchPlan;
  readonly watchdogMs: number;
  readonly cleanupTimeoutMs: number;
}
/** A process can stop after its initial checkpoint, before outcome or cleanup is known. */
export type TaskAttemptCheckpoint = TaskAttemptRecord | Readonly<Pick<TaskAttemptRecord, "identity" | "startedAt" | "watchdogMs"> & { runnerStatus: "running"; taskOutcome: null }>;

export interface BatchResult {
  readonly batchDirectory: string;
  readonly status: "completed" | "incomplete";
  readonly attempts: readonly TaskAttemptCheckpoint[];
}

export async function runBatch(options: RunBatchOptions): Promise<BatchResult> {
  positiveInteger(options.plan.concurrency, "concurrency");
  positiveInteger(options.watchdogMs, "watchdogMs");
  positiveInteger(options.cleanupTimeoutMs ?? 10_000, "cleanupTimeoutMs");
  const batchDirectory = resolve(options.outputDirectory, randomUUID());
  await mkdir(batchDirectory, { recursive: true });
  const saved: SavedBatch = { plan: options.plan, watchdogMs: options.watchdogMs, cleanupTimeoutMs: options.cleanupTimeoutMs ?? 10_000 };
  await saveJson(join(batchDirectory, "batch.json"), saved);
  return executeBatch(batchDirectory, saved, options.signal);
}

export async function resumeBatch(batchDirectory: string, signal?: AbortSignal): Promise<BatchResult> {
  batchDirectory = resolve(batchDirectory);
  const saved: SavedBatch = JSON.parse(await readFile(join(batchDirectory, "batch.json"), "utf8"));
  return executeBatch(batchDirectory, saved, signal);
}

/** Configure without preparing resources. Effective conditions remain opaque to the Runner. */
export async function inspectBatch(plan: BatchPlan) {
  const instances = new Map<string, { instance: BenchmarkInstance; taskId: string; taskRevision: string; configuration: unknown }>();
  for (const { instance } of plan.executions) {
    if (instances.has(instance.id)) continue;
    const task = await loadTask(instance.taskPath);
    const configured = await task.configure(instance.configPath);
    instances.set(instance.id, { instance, taskId: task.id, taskRevision: task.revision, configuration: configured.configuration ?? null });
  }
  return { ...plan, instances: [...instances.values()] };
}

async function executeBatch(batchDirectory: string, saved: SavedBatch, signal?: AbortSignal): Promise<BatchResult> {
  const histories = await Promise.all(saved.plan.executions.map(async (_execution, index) => {
    const directory = join(batchDirectory, `execution-${index}`);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records = await Promise.all(names.map(async name => {
      const path = join(directory, name, "runner", "attempt.json");
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null; // Interrupted before the initial checkpoint.
        throw error;
      });
      return text === null ? null : JSON.parse(text) as TaskAttemptCheckpoint;
    }));
    return records.filter(record => record !== null).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }));
  const complete = (record: TaskAttemptCheckpoint) => record.runnerStatus === "completed" && record.cleanup?.status === "completed";
  await dispatchAttempts(saved.plan.executions.length, saved.plan.concurrency, signal, async index => {
    if (histories[index]!.some(complete)) return undefined;
    const execution = saved.plan.executions[index]!;
    const attemptId = randomUUID();
    const directory = join(batchDirectory, `execution-${index}`, attemptId);
    const identity: TaskAttemptIdentity = {
      instanceId: execution.instance.id, attemptId, taskId: "unloaded", taskRevision: "unknown",
      attemptIndex: execution.repetition,
      repetitions: saved.plan.executions.filter(item => item.instance.id === execution.instance.id).length,
      directory, taskDirectory: join(directory, "task"), runnerDirectory: join(directory, "runner"),
    };
    const record = await runAttempt({
      task: async () => {
        const task = await loadTask(execution.instance.taskPath);
        return { ...await task.configure(execution.instance.configPath), id: task.id, revision: task.revision };
      },
      outputDirectory: batchDirectory, watchdogMs: saved.watchdogMs, cleanupTimeoutMs: saved.cleanupTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }, identity);
    histories[index]!.push(record);
    return record;
  });
  const result: BatchResult = {
    batchDirectory, status: histories.every(records => records.some(complete)) ? "completed" : "incomplete",
    attempts: histories.flat(),
  };
  await saveJson(join(batchDirectory, "result.json"), result);
  return result;
}

async function saveJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

/** Shared admission and settlement policy for configured smoke runs and persisted Batches. */
async function dispatchAttempts(count: number, concurrency: number, signal: AbortSignal | undefined,
  execute: (index: number) => Promise<TaskAttemptRecord | undefined>): Promise<void> {
  let next = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    try {
      while (next < count && !stopped && !signal?.aborted) {
        const record = await execute(next++);
        if (record?.cleanup.status === "failed") stopped = true;
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  });
  // Even persistence errors must let other active Attempts settle their resources.
  const results = await Promise.allSettled(workers);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
