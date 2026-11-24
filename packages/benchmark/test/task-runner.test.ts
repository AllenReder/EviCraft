import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runTask, TaskPreparationError, type TaskPlatform } from "../src/task-runner.js";
import type { ExecutableTask, TaskWorld } from "../src/task.js";

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "task-runner-test-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const world: TaskWorld = {
  snapshot: async () => ({ actor: { present: false }, inventory: null, blocks: [], fenceSequence: 0, serverTick: 0, gameTime: 0 }),
  teleportActor: async () => ({ present: false, fenceSequence: 0, serverTick: 0, gameTime: 0 }), setRespawnPoint: async () => {},
  giveItem: async () => {}, setInventorySlot: async () => {}, setEquipment: async () => {},
  setBlock: async () => ({ previousBlockState: "minecraft:air", currentBlockState: "minecraft:air", fenceSequence: 0, serverTick: 0, gameTime: 0 }), executeMinecraftCommand: async () => ({ success: true, result: 1 }),
  startRun: async () => { throw new Error("not used"); },
  time: { pause: async () => {}, resume: async () => {}, isPaused: async () => true },
};
function platform(close: () => Promise<void> = async () => {}): TaskPlatform {
  return { async prepare({ identity }) { return { world, bot: { id: `bot-${identity.attemptIndex}` }, harness: { failure: new Promise<never>(() => {}), exited: new Promise<void>(() => {}), start: async () => {}, stop: async () => {} }, close }; } };
}
const options = { repetitions: 1, concurrency: 1, watchdogMs: 1000 };
describe("task runner external contract", () => {
  it("loads a real task.ts directory through the CLI", async () => {
    const source = await directory();
    const output = await directory();
    await writeFile(join(source, "task.ts"), `export default {
      id: "cli-task", revision: "1", async configure() { return {
      platform: { async prepare() { return { world: {}, bot: { id: "existing" }, harness: {}, async close() {} }; } },
      async run(context: { bot: { id: string } }) {
        if (context.bot.id !== "existing") throw new Error("Bot missing");
        return { status: "success" };
      }
    }; } };`);
    await writeFile(join(source, "config.json"), "{}\n");
    const run = join(output, "run");
    const { stdout } = await promisify(execFile)(process.execPath, ["apps/cli/dist/index.js", "run", source, "--config", join(source, "config.json"), "--out", run, "--repetitions", "2", "--concurrency", "2", "--set", "harness.config.model.baseUrl=http://127.0.0.1:1/v1"]);
    expect(JSON.parse(stdout).attempts).toHaveLength(2);
    // The run directory is laid out for the scorers, and --set lands in the frozen copy only.
    const plan = JSON.parse(await readFile(join(run, "dry-run.json"), "utf8"));
    expect(plan.instances).toHaveLength(1);
    const frozen = JSON.parse(await readFile(plan.executions[0].instance.configPath, "utf8"));
    expect(frozen).toEqual({ harness: { config: { model: { baseUrl: "http://127.0.0.1:1/v1" } }, workingDirectory: source } });
    expect(await readFile(join(source, "config.json"), "utf8")).toBe("{}\n");
    expect(await readdir(join(run, "raw"))).toHaveLength(1);
  });
  it("narrows a batch and swaps the Harness through the CLI without touching the configs", async () => {
    const source = await directory();
    const output = await directory();
    await writeFile(join(source, "task.ts"), `export default {
      id: "cli-task", revision: "1", async configure() { return {
      platform: { async prepare() { return { world: {}, bot: { id: "existing" }, harness: {}, async close() {} }; } },
      async run() { return { status: "success" }; }
    }; } };`);
    const original = `${JSON.stringify({ camera: { clientTemplatePath: "camera" }, harness: { config: { model: { model: "paper" } } } })}\n`;
    await writeFile(join(source, "a.json"), original);
    await writeFile(join(source, "b.json"), original);
    await writeFile(join(source, "batch.yaml"), "concurrency: 50\ninstances:\n"
      + "  - { id: a, taskPath: ., configPath: a.json, repetitions: 5 }\n  - { id: b, taskPath: ., configPath: b.json, repetitions: 5 }\n");
    await writeFile(join(output, "mine.json"), `${JSON.stringify({ temperature: 0 })}\n`);
    const run = join(output, "run");
    const { stdout } = await promisify(execFile)(process.execPath, [join(process.cwd(), "apps/cli/dist/index.js"), "run", join(source, "batch.yaml"), "--out", run,
      "--instance", "b", "--repetitions", "2", "--concurrency", "1", "--harness-config", "mine.json", "--set", "camera=null",
      "--", "python3", "agent.py", "--verbose"], { cwd: output });
    expect(JSON.parse(stdout).attempts).toHaveLength(2);
    const plan = JSON.parse(await readFile(join(run, "dry-run.json"), "utf8"));
    expect(plan.instances.map((entry: { instance: { id: string } }) => entry.instance.id)).toEqual(["b"]);
    const batch = JSON.parse(await readFile(join(run, "inputs", "batch.yaml"), "utf8"));
    expect(batch).toMatchObject({ concurrency: 1, instances: [{ id: "b", repetitions: 2 }] });
    // The Harness runs from where the command was given, with its own config and nothing of the paper's.
    expect(JSON.parse(await readFile(join(run, "inputs", "configs", "b.json"), "utf8"))).toEqual({
      camera: null, harness: { command: ["python3", "agent.py", "--verbose"], workingDirectory: output, config: { temperature: 0 } },
    });
    expect(JSON.parse(await readFile(join(run, "inputs", "overrides.json"), "utf8"))).toEqual({
      set: [{ key: "camera", value: null }],
      harness: { command: ["python3", "agent.py", "--verbose"], workingDirectory: output, config: { temperature: 0 } },
    });
    expect(await readFile(join(source, "b.json"), "utf8")).toBe(original);
  });
  it("rejects an instance the batch does not have", async () => {
    const source = await directory();
    await writeFile(join(source, "task.ts"), "export default {};\n");
    await writeFile(join(source, "a.json"), "{}\n");
    await writeFile(join(source, "batch.yaml"), "concurrency: 1\ninstances:\n  - { id: a, taskPath: ., configPath: a.json, repetitions: 1 }\n");
    await expect(promisify(execFile)(process.execPath, ["apps/cli/dist/index.js", "run", join(source, "batch.yaml"), "--dry-run", "--instance", "z"]))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Unknown instance "z"; the plan has a') });
  });
  it("persists the effective watchdog before preparation and after completion", async () => {
    const task: ExecutableTask = {id:"limits",revision:"1",platform:{async prepare(input) {
      expect(JSON.parse(await readFile(join(input.identity.runnerDirectory,"attempt.json"),"utf8"))).toMatchObject({watchdogMs:4321,runnerStatus:"running"});
      return platform().prepare(input);
    }}, async run(){return {status:"success"};}};
    const [attempt] = await runTask({...options,task,outputDirectory:await directory(),watchdogMs:4321});
    expect(attempt).toMatchObject({watchdogMs:4321,runnerStatus:"completed"});
    expect(JSON.parse(await readFile(join(attempt!.identity.runnerDirectory,"attempt.json"),"utf8"))).toMatchObject({watchdogMs:4321,runnerStatus:"completed"});
  });
  it("runs every repetition once under a global limit and preserves opaque output", async () => {
    let active = 0; let maximum = 0; let closed = 0;
    const task: ExecutableTask = { id: "independent", revision: "1", platform: platform(async () => { closed++; }), async run(context) {
      active++; maximum = Math.max(maximum, active);
      expect(context.bot.id).toBe(`bot-${context.identity.attemptIndex}`);
      await writeFile(join(context.taskDirectory, "opaque.bin"), Buffer.from([255, context.identity.attemptIndex]));
      await delay(10); active--; return { status: "success" };
    } };
    const attempts = await runTask({ ...options, task, outputDirectory: await directory(), repetitions: 5, concurrency: 2 });
    expect(attempts.map(a => a.identity.attemptIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(maximum).toBe(2); expect(closed).toBe(5);
    expect(new Set(attempts.map(a => a.identity.directory)).size).toBe(5);
    for (const attempt of attempts) {
      expect(await readFile(join(attempt.identity.taskDirectory, "opaque.bin"))).toEqual(Buffer.from([255, attempt.identity.attemptIndex]));
      expect(JSON.parse(await readFile(join(attempt.identity.runnerDirectory, "attempt.json"), "utf8"))).toMatchObject({ runnerStatus: "completed", taskOutcome: { status: "success" } });
    }
  });
  it("stops admitting queued attempts after cancellation", async () => {
    const controller = new AbortController();
    let invoked = 0;
    const task: ExecutableTask = { id: "cancel", revision: "1", platform: platform(), async run() { invoked++; controller.abort(); return { status: "success" }; } };
    const attempts = await runTask({ ...options, task, outputDirectory: await directory(), repetitions: 8, signal: controller.signal });
    expect(invoked).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.runnerStatus).toBe("cancelled");
  });
  it("accepts no result file and keeps experimental timeout distinct from watchdog", async () => {
    const task: ExecutableTask = { id: "budget", revision: "1", platform: platform(), async run() { return { status: "timeout", reason: "tick budget" }; } };
    const [attempt] = await runTask({ ...options, task, outputDirectory: await directory() });
    expect(attempt).toMatchObject({ runnerStatus: "completed", taskOutcome: { status: "timeout" } });
  });
  it("bounds uncooperative execution and cleans up after watchdog", async () => {
    let closed = false;
    const task: ExecutableTask = { id: "stuck", revision: "1", platform: platform(async () => { closed = true; }), run: () => new Promise(() => {}) };
    const [attempt] = await runTask({ ...options, task, outputDirectory: await directory(), watchdogMs: 20 });
    expect(attempt).toMatchObject({ runnerStatus: "watchdog_timeout", taskOutcome: null });
    expect(closed).toBe(true);
  });
  it("records cleanup failures separately without replacing a task outcome", async () => {
    const task: ExecutableTask = { id: "cleanup", revision: "1", platform: platform(async () => { throw new Error("cleanup broke"); }), async run() { return { status: "failure", reason: "goal missed" }; } };
    const [attempt] = await runTask({ ...options, task, outputDirectory: await directory() });
    expect(attempt).toMatchObject({ runnerStatus: "completed", taskOutcome: { status: "failure" }, cleanup: { status: "failed" } });
  });
});

it("records a server crash while task work is waiting and still closes resources", async () => {
  let closed = false;
  const task: ExecutableTask = { id: "crash", revision: "1", platform: { async prepare(input) {
    const resources = await platform(async () => { closed = true; }).prepare(input);
    return { ...resources, failure: delay(5).then(() => { throw new Error("server exited"); }) };
  } }, run: () => new Promise(() => {}) };
  const [attempt] = await runTask({ ...options, task, outputDirectory: await directory() });
  expect(attempt).toMatchObject({ runnerStatus: "process_failure", taskOutcome: null, cleanup: { status: "completed" } });
  expect(closed).toBe(true);
});

it("does not report cleanup complete when cancelled preparation never settles", async () => {
  const task: ExecutableTask = { id: "stuck-prepare", revision: "1", platform: { prepare: () => new Promise(() => {}) }, async run() { return { status: "success" }; } };
  const [attempt] = await runTask({ ...options, task, watchdogMs: 10, cleanupTimeoutMs: 10, outputDirectory: await directory() });
  expect(attempt).toMatchObject({ runnerStatus: "watchdog_timeout", cleanup: { status: "failed" } });
});

it.each([false, true])("records failed partial cleanup after preparation rejection (watchdog=%s)", async (watchdog) => {
  const task: ExecutableTask = {
    id: "startup-cleanup", revision: "1",
    platform: { async prepare({ signal }) {
      if (watchdog) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new TaskPreparationError(new Error("startup broke"), new Error("port remains open"));
    } },
    async run() { throw new Error("Task must not run after startup failure"); },
  };
  const [attempt] = await runTask({ ...options, task, watchdogMs: watchdog ? 10 : 1000, outputDirectory: await directory() });
  expect(attempt).toMatchObject({
    runnerStatus: watchdog ? "watchdog_timeout" : "process_failure",
    taskOutcome: null,
    cleanup: { status: "failed", error: "Error: port remains open" },
  });
  const persisted = JSON.parse(await readFile(join(attempt!.identity.runnerDirectory, "attempt.json"), "utf8"));
  expect(persisted.cleanup).toEqual(attempt!.cleanup);
});

it("records successful partial cleanup separately from preparation failure", async () => {
  const task: ExecutableTask = { id: "startup", revision: "1", platform: { async prepare() { throw new Error("startup broke after cleanup"); } }, async run() { return { status: "success" }; } };
  const [attempt] = await runTask({ ...options, task, outputDirectory: await directory() });
  expect(attempt).toMatchObject({ runnerStatus: "process_failure", cleanup: { status: "completed" } });
});

it.each(["completed", "rejected", "hung"] as const)("awaits a shared cleanup after preparation resolves following watchdog (%s)", async (cleanupKind) => {
  let closes = 0;
  let cleanupFinished = false;
  const task: ExecutableTask = {
    id: "late-preparation", revision: "1",
    platform: { async prepare(input) {
      await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      return platform(async () => {
        closes++;
        if (cleanupKind === "hung") return new Promise<void>(() => {});
        await delay(20);
        cleanupFinished = true;
        if (cleanupKind === "rejected") throw new Error("late cleanup failed");
      }).prepare(input);
    } },
    async run() { throw new Error("Cancelled attempt must not run"); },
  };
  const [attempt] = await runTask({ ...options, task, watchdogMs: 10, cleanupTimeoutMs: 100, outputDirectory: await directory() });
  expect(closes).toBe(1);
  expect(attempt).toMatchObject({ runnerStatus: "watchdog_timeout", cleanup: { status: cleanupKind === "completed" ? "completed" : "failed" } });
  expect(cleanupFinished).toBe(cleanupKind !== "hung");
  if (cleanupKind === "rejected") expect(attempt?.cleanup.error).toContain("late cleanup failed");
  if (cleanupKind === "hung") expect(attempt?.cleanup.error).toContain("timed out");
});
