import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { whileHarnessRuns, type AuthorityTeleport, type BenchmarkSample, type TaskContext, type TaskOutcome } from "@evicraft/benchmark";
import { initialize } from "./initialize.ts";
import { createObservationLog } from "./observation-log.ts";

export const observationSchemaVersion = "2";
/** `initial` is the sample at elapsed tick 0; every later sample is `scheduled`: one per interval, and one each time the World Run comes to rest. */
export type ObservationKind = "initial" | "scheduled";

export interface BenchmarkOptions {
  readonly tickBudget: number;
  /** Game ticks between samples; defaults to 20, one second of game time. */
  readonly sampleIntervalTicks?: number;
  readonly spawn: AuthorityTeleport;
  readonly metadata: unknown;
}

/**
 * Sets the world up, starts the benchmark clock and the Harness, and records every sample the Runtime takes
 * until the tick budget ends. The Runtime owns the clock: samples fall on exact game ticks and the world
 * stops on the budget tick, whatever the Harness does.
 */
export async function runMinecraftBenchmark(context: TaskContext, options: BenchmarkOptions): Promise<TaskOutcome> {
  const { world, harness, signal, taskDirectory, identity } = context;
  const sampleIntervalTicks = options.sampleIntervalTicks ?? 20;
  if (!Number.isSafeInteger(sampleIntervalTicks) || sampleIntervalTicks < 1) throw new Error("sampleIntervalTicks must be a positive integer");
  let observations: ReturnType<typeof createObservationLog> | undefined;
  let startTick: number | undefined;
  let lastTick: number | undefined;
  let samples = 0;
  let initialDeaths = 0;
  let deaths = 0;
  let outcome: TaskOutcome | undefined;
  let primaryFailure: unknown;
  const cleanupErrors: Array<{ phase: string; error: unknown }> = [];

  const record = async (kind: ObservationKind, sample: BenchmarkSample): Promise<void> => {
    if (!sample.evaluation) throw new Error("Runtime did not return evaluation facts");
    if (lastTick !== undefined && sample.serverTick < lastTick) throw new Error("Authority receipt tick regressed");
    lastTick = sample.serverTick;
    deaths = (sample.actorDeathCount ?? 0) - initialDeaths;
    observations ??= createObservationLog(join(taskDirectory, "observations.jsonl.gz"));
    await observations.append({ schemaVersion: observationSchemaVersion, attempt: identity,
      kind, elapsedTick: sample.elapsedTick, capturedAt: new Date().toISOString(),
      receipt: { fenceSequence: sample.fenceSequence, serverTick: sample.serverTick, gameTime: sample.gameTime },
      actor: sample.actor, inventory: sample.inventory, evaluation: sample.evaluation,
      actorDeathCount: sample.actorDeathCount ?? null });
    samples++;
  };

  try {
    signal.throwIfAborted();
    await initialize(world, options.spawn);
    const definitions = await world.advancementDefinitions();
    await writeFile(join(taskDirectory, "advancement-definitions.json"), JSON.stringify({ schemaVersion: observationSchemaVersion, ...definitions }, null, 2) + "\n");
    const run = await world.startRun({ tickBudget: options.tickBudget, sampleIntervalTicks });
    startTick = run.startTick;
    const initial = run.initial;
    if (!initial.actor.present || initial.actor.lifecycle !== "alive" || initial.actor.health !== 20 || initial.actor.food !== 20 || !initial.inventory) throw new Error("Initialized Bot must be alive with full health, food, and inventory");
    initialDeaths = initial.actorDeathCount ?? 0;
    await record("initial", initial);
    await harness.start();
    const running = whileHarnessRuns(harness, signal);
    const scheduled = run.samples()[Symbol.asyncIterator]();
    while (!outcome) {
      const next = await running(scheduled.next());
      if (next.done) outcome = { status: "timeout", reason: "Game tick budget elapsed" };
      else await record("scheduled", next.value);
    }
  } catch (error) { primaryFailure = error; }

  try { await world.time.pause(); } catch (error) { cleanupErrors.push({ phase: "pause", error }); }
  try { await harness.stop("Benchmark Task finished"); } catch (error) { cleanupErrors.push({ phase: "harness_stop", error }); }
  try { await observations?.close(); } catch (error) { cleanupErrors.push({ phase: "observation_close", error }); }
  let resultWriteFailure: unknown;
  try {
    await writeFile(join(taskDirectory, "result.json"), JSON.stringify({ schemaVersion: observationSchemaVersion,
      identity, metadata: options.metadata, tickBudget: options.tickBudget, sampleIntervalTicks,
      startTick: startTick ?? null, elapsedTerminalTick: startTick === undefined || lastTick === undefined ? null : lastTick - startTick,
      samples, deaths, outcome: outcome ?? null,
      error: primaryFailure === undefined ? null : String(primaryFailure),
      cleanupErrors: cleanupErrors.map(({ phase, error }) => ({ phase, error: String(error) })) }, null, 2) + "\n");
  } catch (error) { resultWriteFailure = error; }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors.map(entry => entry.error), "Benchmark Task cleanup failed");
  if (resultWriteFailure !== undefined) throw resultWriteFailure;
  return outcome!;
}
