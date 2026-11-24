import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

const cli = resolve("apps/cli/dist/index.js");

// Answers the Benchmark Authority calls that preparing and starting an Attempt makes, and never ticks.
const fakeServer = `
import { WebSocketServer } from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
const receipt = { fence_sequence: 1, server_tick: 100, game_time: 0 };
const actor = { present: true, uuid: "bot-uuid", name: "bot", lifecycle: "alive", dimension: "minecraft:overworld",
  position: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, pitch: 0, health: 20, food: 20 };
const inventory = { selected_hotbar_slot: 0, slots: Array.from({ length: 36 }, (_, slot) => ({ slot, item: null })),
  mainhand: null, offhand: null, armor: { head: null, chest: null, legs: null, feet: null } };
const unavailable = { status: "unavailable", reason: "test" };
const results = {
  "benchmark.info": { protocol_version: 1, build_version: "test", minecraft_version: "test", neoforge_version: "test", readiness: "ready",
    world_knowledge_profile: process.env.EVICRAFT_WORLD_KNOWLEDGE_PROFILE, grounded_block_expiry_ticks: 400, grounded_entity_expiry_ticks: 400, capabilities: [] },
  "world.time.get": { paused: true }, "actor.create": actor, "actor.teleport": actor,
  "world.command.execute": { success: true, result: 1 },
  "benchmark.advancement_definitions.get": { definitions: [] },
  "benchmark.run.start": { start_tick: 100, sample: { ...receipt, elapsed_tick: 0, actor, inventory, blocks: [], actor_death_count: 0,
    evaluation: { location: unavailable, advancements: { status: "ok", value: [] }, nearby_portals: unavailable } } },
};
new WebSocketServer({ host: "127.0.0.1", port: Number(process.env.EVICRAFT_BENCHMARK_AUTHORITY_PORT) }).on("connection", socket => socket.on("message", wire => {
  const request = JSON.parse(String(wire));
  if (request.method === "benchmark.run.start") console.log(JSON.stringify({ started: request.params, profile: process.env.EVICRAFT_WORLD_KNOWLEDGE_PROFILE }));
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ...results[request.method], ...receipt } }));
}));
`;

// A Harness that reports how it was started and exits.
const reportingHarness = `
import { readFileSync } from "node:fs";
console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), task: JSON.parse(readFileSync(process.env.EVICRAFT_TASK_FILE, "utf8")),
  url: process.env.EVICRAFT_RUNTIME_URL, token: process.env.EVICRAFT_RUNTIME_BEARER_TOKEN }));
`;

it.skipIf(process.platform === "win32")("holds one config's world open and starts Harnesses on it with the Runner's inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "evicraft-world-"));
  const env = { ...process.env, EVICRAFT_WORLD_STATE: join(root, "state.json") };
  const run = async (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env });
  await mkdir(join(root, "template"));
  await mkdir(join(root, "snapshot", "world"), { recursive: true });
  await writeFile(join(root, "snapshot", "world", "level.dat"), "frozen world");
  await writeFile(join(root, "snapshot", "manifest.json"), JSON.stringify({ revision: "1", seed: "7", sha256: "unused",
    spawn: { dimension: "minecraft:overworld", x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0 }, feasibility: { status: "verified", receipt: null } }));
  await writeFile(join(root, "server.mjs"), fakeServer);
  await writeFile(join(root, "harness.mjs"), reportingHarness);
  await writeFile(join(root, "mine.json"), JSON.stringify({ mine: true }));
  await writeFile(join(root, "config.json"), JSON.stringify({
    serverTemplatePath: "template", serverCommand: [process.execPath, join(root, "server.mjs")], snapshotPath: "snapshot",
    profile: "grounded_evidence", tickBudget: 2400, harness: { command: [process.execPath, "harness.mjs"], config: { named: true } },
  }));

  await expect(run("harness")).rejects.toThrow("No world is ready");
  const world = spawn(process.execPath, [cli, "world", resolve("tasks/minecraft-survival"), "--config", join(root, "config.json"),
    "--set", "profile=loaded_world_state", "--out", join(root, "world")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  world.stderr.on("data", (chunk: Buffer) => { log += chunk.toString("utf8"); });
  const exited = once(world, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  try {
    await vi.waitFor(() => expect(log).toContain("world ready"), { timeout: 30_000, interval: 100 });
    await expect(run("world", resolve("tasks/minecraft-survival"), "--config", join(root, "config.json"), "--out", join(root, "second"))).rejects.toThrow("already running");

    // The Harness the config names: its command, its directory and its config, on the world's Bot and Runtime.
    const named = JSON.parse((await run("harness", "extra")).stdout);
    expect(named).toMatchObject({ cwd: root, args: ["extra"], url: named.task.runtime.url,
      task: { bot: { id: "bot-uuid", username: "bot" }, config: { named: true } } });
    expect(named.task.assignment).toContain("survival progression");
    expect(named.task.runtime.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rpc$/u);
    expect(named.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(named.task.outputDirectory.startsWith(join(root, "world"))).toBe(true);

    // Another Harness: the command after --, in the caller's directory, with the config it was given or none.
    const mine = JSON.parse((await run("harness", "--harness-config", join(root, "mine.json"), "--", process.execPath, join(root, "harness.mjs"), "x")).stdout);
    expect(mine).toMatchObject({ cwd: process.cwd(), args: ["x"], token: named.token, task: { bot: named.task.bot, config: { mine: true } } });
    expect(mine.task.outputDirectory).not.toBe(named.task.outputDirectory);
    expect(JSON.parse((await run("harness", "--", process.execPath, join(root, "harness.mjs"))).stdout).task.config).toBeNull();
    await expect(run("harness", "--harness-config", join(root, "mine.json"))).rejects.toThrow("needs a Harness command");

    // The world is that config's Attempt with the overrides applied and no deadline.
    const [batch] = await readdir(join(root, "world", "raw"));
    const [attempt] = await readdir(join(root, "world", "raw", batch!, "execution-0"));
    const serverLog = await readFile(join(root, "world", "raw", batch!, "execution-0", attempt!, "runner", "server.log"), "utf8");
    expect(JSON.parse(serverLog.trim().split("\n").at(-1)!)).toEqual({ started: { tick_budget: 2_000_000_000, sample_interval_ticks: 20 }, profile: "loaded_world_state" });

    world.kill("SIGINT");
    expect(await exited).toEqual([0, null]);
    await expect(stat(join(root, "state.json"))).rejects.toThrow("ENOENT");
    await expect(run("harness")).rejects.toThrow("No world is ready");
  } finally {
    if (world.exitCode === null && world.signalCode === null) { world.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
