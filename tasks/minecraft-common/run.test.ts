import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BenchmarkSample, TaskContext, TaskHarness } from "@evicraft/benchmark";
import { runMinecraftBenchmark } from "./run.ts";
import { readObservations } from "./observation-test-support.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });

function sample(elapsedTick: number, overrides: Partial<BenchmarkSample> = {}): BenchmarkSample {
  return { elapsedTick, fenceSequence: elapsedTick + 1, serverTick: 100 + elapsedTick, gameTime: elapsedTick, actorDeathCount: 0,
    actor: { present: true, uuid: "bot", name: "Bot", lifecycle: "alive", dimension: "minecraft:overworld",
      position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20 },
    inventory: { selectedHotbarSlot: 0, slots: Array.from({ length: 36 }, (_, slot) => ({ slot, item: null })),
      mainhand: null, offhand: null, armor: { head: null, chest: null, legs: null, feet: null } },
    blocks: [], evaluation: { location: { status: "unavailable", reason: "test" },
      advancements: { status: "ok", value: [] }, nearbyPortals: { status: "unavailable", reason: "test" } },
    ...overrides };
}

/** A Harness process that runs until it is stopped, unless a test ends or fails it first. */
function fakeHarness() {
  let exit!: () => void;
  let fail!: (error: Error) => void;
  const exited = new Promise<void>(resolve => { exit = resolve; });
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  void failure.catch(() => {});
  const harness = { failure, exited, start: vi.fn(async () => {}), stop: vi.fn(async () => { exit(); }) } satisfies TaskHarness;
  return { harness, exit, fail };
}

async function attempt(scheduled: AsyncIterable<BenchmarkSample>, initial = sample(0), signal = new AbortController().signal) {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-run-"));
  directories.push(directory);
  const process = fakeHarness();
  const pause = vi.fn(async () => {});
  const startRun = vi.fn(async () => ({ startTick: 100, initial, samples: () => scheduled }));
  const context: TaskContext = { identity: { taskId: "minecraft-survival", taskRevision: "2", attemptIndex: 0, repetitions: 1,
    directory, taskDirectory: directory, runnerDirectory: directory },
    taskDirectory: directory, signal, bot: { id: "bot" },
    world: { snapshot: async () => initial,
      advancementDefinitions: async () => ({ definitions: [], fenceSequence: 1, serverTick: 100, gameTime: 0 }),
      teleportActor: async () => ({ ...initial.actor, fenceSequence: 1, serverTick: 100, gameTime: 0 }),
      setRespawnPoint: async () => {}, giveItem: async () => {}, setInventorySlot: async () => {},
      setEquipment: async () => {}, setBlock: async () => ({ fenceSequence: 1, serverTick: 100, gameTime: 0, previousBlockState: "minecraft:air", currentBlockState: "minecraft:air" }),
      executeMinecraftCommand: async () => ({ success: true, result: 1 }),
      startRun, time: { pause, resume: async () => {}, isPaused: async () => true } },
    harness: process.harness };
  const result = async () => JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
  return { context, directory, process, pause, startRun, result };
}

async function* samples(...values: BenchmarkSample[]) { yield* values; }
/** Samples that arrive, then a run that never reaches its budget. */
async function* samplesThenSilence(...values: BenchmarkSample[]) { yield* values; await new Promise(() => {}); }

const options = { tickBudget: 60, spawn: { dimension: "minecraft:overworld", x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, metadata: {} };

it("records the initial and every scheduled sample and ends when the Runtime reaches the tick budget", async () => {
  const withItem = sample(40, { inventory: null, actorDeathCount: 2 });
  const f = await attempt(samples(sample(20), withItem, sample(60, { actorDeathCount: 2 })));
  await expect(runMinecraftBenchmark(f.context, options)).resolves.toEqual({ status: "timeout", reason: "Game tick budget elapsed" });

  expect(f.startRun).toHaveBeenCalledWith({ tickBudget: 60, sampleIntervalTicks: 20 });
  expect(f.process.harness.start).toHaveBeenCalledOnce();
  expect(f.process.harness.stop).toHaveBeenCalledOnce();
  expect(f.pause).toHaveBeenCalled();
  const rows = await readObservations(join(f.directory, "observations.jsonl.gz"));
  expect(rows.map(row => [row.kind, row.elapsedTick, row.receipt.serverTick])).toEqual([
    ["initial", 0, 100], ["scheduled", 20, 120], ["scheduled", 40, 140], ["scheduled", 60, 160],
  ]);
  expect(rows.every(row => row.schemaVersion === "2")).toBe(true);
  expect(rows[2].inventory).toBeNull();
  expect(await f.result()).toMatchObject({ schemaVersion: "2", tickBudget: 60, sampleIntervalTicks: 20, startTick: 100,
    elapsedTerminalTick: 60, samples: 4, deaths: 2, outcome: { status: "timeout" }, error: null, cleanupErrors: [] });
});

it("fails the attempt when the Harness exits before the tick budget", async () => {
  const f = await attempt(samplesThenSilence(sample(20)));
  const running = runMinecraftBenchmark(f.context, options);
  await vi.waitFor(() => expect(f.process.harness.start).toHaveBeenCalled());
  f.process.exit();
  await expect(running).rejects.toThrow("Harness ended before game tick budget");
  expect(await f.result()).toMatchObject({ outcome: null, error: "Error: Harness ended before game tick budget" });
  expect((await readObservations(join(f.directory, "observations.jsonl.gz"))).length).toBeGreaterThan(0);
});

it("fails the attempt with the Harness's own failure", async () => {
  const f = await attempt(samplesThenSilence());
  const running = runMinecraftBenchmark(f.context, options);
  await vi.waitFor(() => expect(f.process.harness.start).toHaveBeenCalled());
  f.process.fail(new Error("Harness exited: 1"));
  await expect(running).rejects.toThrow("Harness exited: 1");
  expect(f.process.harness.stop).toHaveBeenCalledOnce();
});

it("fails the attempt when the sample stream breaks", async () => {
  const f = await attempt((async function* () { yield sample(20); throw new Error("Benchmark Authority connection closed"); })());
  await expect(runMinecraftBenchmark(f.context, options)).rejects.toThrow("Benchmark Authority connection closed");
  expect(await f.result()).toMatchObject({ samples: 2, error: "Error: Benchmark Authority connection closed" });
});

it("stops when the attempt is cancelled and keeps what was recorded", async () => {
  const controller = new AbortController();
  const f = await attempt(samplesThenSilence(sample(20)), sample(0), controller.signal);
  const running = runMinecraftBenchmark(f.context, options);
  await vi.waitFor(() => expect(f.process.harness.start).toHaveBeenCalled());
  controller.abort(new Error("operator stopped"));
  await expect(running).rejects.toThrow("operator stopped");
  expect(f.process.harness.stop).toHaveBeenCalledOnce();
  expect((await readObservations(join(f.directory, "observations.jsonl.gz")))[0].kind).toBe("initial");
});

it("requires a living Bot with full health and food at the start", async () => {
  const hurt = sample(0);
  const f = await attempt(samplesThenSilence(), { ...hurt, actor: { ...hurt.actor, health: 12 } as BenchmarkSample["actor"] });
  await expect(runMinecraftBenchmark(f.context, options)).rejects.toThrow("Initialized Bot must be alive");
  expect(f.process.harness.start).not.toHaveBeenCalled();
});

it("reports a cleanup failure without hiding the failure that ended the attempt", async () => {
  const f = await attempt(samplesThenSilence());
  f.process.harness.stop.mockRejectedValueOnce(new Error("Harness did not stop"));
  const running = runMinecraftBenchmark(f.context, options);
  await vi.waitFor(() => expect(f.process.harness.start).toHaveBeenCalled());
  f.process.fail(new Error("Harness exited: 1"));
  await expect(running).rejects.toThrow("Harness exited: 1");
  expect(await f.result()).toMatchObject({ error: "Error: Harness exited: 1",
    cleanupErrors: [{ phase: "harness_stop", error: "Error: Harness did not stop" }] });
});
