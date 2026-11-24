import { mkdtemp, mkdir, writeFile, readFile, rm, open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { createLocalTaskPlatform } from "../src/local-task-platform.js";
import { runTask } from "../src/task-runner.js";

it.skipIf(process.platform !== "linux")("keeps Authority RPCs progressing while server output waits for a reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "authority-log-isolation-"));
  let fifo: string | undefined;
  let reader: FileHandle | undefined;
  try {
    const template = join(root, "template");
    await mkdir(template);
    const script = join(root, "server.mjs");
    await writeFile(script, `
      import { WebSocketServer } from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
      process.on('SIGINT', () => process.exit(0));
      const server = new WebSocketServer({host:'127.0.0.1',port:Number(process.env.EVICRAFT_BENCHMARK_AUTHORITY_PORT)});
      let actorCreated = false;
      server.on('connection', socket => socket.on('message', async wire => {
        const request = JSON.parse(String(wire));
        const result = request.method === 'benchmark.info'
          ? {protocol_version:1,build_version:'test',minecraft_version:'test',neoforge_version:'test',readiness:'ready',world_knowledge_profile:'grounded_evidence',grounded_block_expiry_ticks:-1,grounded_entity_expiry_ticks:400,capabilities:[]}
          : request.method === 'actor.create'
            ? {present:true,uuid:'bot',name:'bot',lifecycle:'alive',dimension:'minecraft:overworld',position:{x:0,y:64,z:0},yaw:0,pitch:0,health:20,food:20}
            : {paused:true};
        if (actorCreated) {
          console.log('server output with no reader');
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        if (request.method === 'actor.create') actorCreated = true;
        socket.send(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{...result,fence_sequence:1,server_tick:0,game_time:0}}));
      }));
    `);
    const platform = createLocalTaskPlatform({ serverWorkingDirectoryTemplate: template, serverCommand: [process.execPath, script],
      world: { source: { kind: "generated", seed: "509" }, worldKnowledgeProfile: "grounded_evidence" },
      async createHarness(connection) {
        fifo = join(connection.runnerDirectory, "server.log");
        await promisify(execFile)("mkfifo", [fifo]);
        return { failure: new Promise<never>(() => {}), exited: new Promise<void>(() => {}), start: async () => {}, stop: async () => {} };
      },
    });
    const [attempt] = await runTask({ task: { id: "log-isolation", revision: "1", platform,
      async run({ world }) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const paused = await Promise.race([world.time.isPaused(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Authority blocked behind server output")), 1000);
            timer.unref();
          })]);
          expect(paused).toBe(true);
        } finally {
          clearTimeout(timer);
          // Release the real blocked file open before cleanup, including on assertion failure.
          reader = await open(fifo!, constants.O_RDONLY | constants.O_NONBLOCK);
        }
        return { status: "success" };
      } }, outputDirectory: join(root, "output"), repetitions: 1, concurrency: 1, watchdogMs: 10000 });
    expect(attempt, attempt?.error).toMatchObject({ runnerStatus: "completed", cleanup: { status: "completed" } });
    const audit = await readFile(join(attempt!.identity.runnerDirectory, "authority-events.jsonl"), "utf8");
    expect(audit).toContain('"type":"authority_receipt"');
  } finally {
    await reader?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { stopFailure: false, detached: false, shutdownDelay: 0, cleanupTimeoutMs: 10000, foreignListener: false, hungHarness: false },
  { stopFailure: true, detached: false, shutdownDelay: 0, cleanupTimeoutMs: 10000, foreignListener: false, hungHarness: false },
  { stopFailure: false, detached: true, shutdownDelay: 5500, cleanupTimeoutMs: 9000, foreignListener: false, hungHarness: false },
  { stopFailure: false, detached: true, shutdownDelay: 0, cleanupTimeoutMs: 500, foreignListener: true, hungHarness: false },
  { stopFailure: false, detached: true, shutdownDelay: 0, cleanupTimeoutMs: 500, foreignListener: false, hungHarness: true },
])("retains RPC and cleanup evidence after late readiness (%j)", async ({ stopFailure, detached, shutdownDelay, cleanupTimeoutMs, foreignListener, hungHarness }) => {
  const root = await mkdtemp(join(tmpdir(), "authority-deadline-"));
  const foreign = createServer();
  let runtimePort = 0;
  let cleanupStarted = 0;
  const cleanupFailed = stopFailure || foreignListener || hungHarness;
  try {
    const template = join(root, "template");
    await mkdir(template);
    const serverScript = join(root, "authority.mjs");
    await writeFile(serverScript, `
      import { WebSocketServer } from ${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)};
      process.on('SIGINT', () => setTimeout(() => process.exit(0), ${shutdownDelay}));
      setTimeout(() => {
        const server = new WebSocketServer({ host: '127.0.0.1', port: Number(process.env.EVICRAFT_BENCHMARK_AUTHORITY_PORT) });
        let reads = 0;
        server.on('connection', socket => socket.on('message', wire => {
          const request = JSON.parse(String(wire));
          const result = request.method === 'benchmark.info'
            ? { protocol_version: 1, build_version: 'test', minecraft_version: 'test', neoforge_version: 'test', readiness: 'ready', world_knowledge_profile: 'grounded_evidence', grounded_block_expiry_ticks: -1, grounded_entity_expiry_ticks: 400, capabilities: [] }
            : request.method === 'actor.create'
              ? { present: true, uuid: 'bot', name: 'bot', lifecycle: 'alive', dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20 }
              : { paused: true };
          const delay = request.method === 'world.time.get' && ++reads > 1 ? 600 : 0;
          setTimeout(() => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ...result, fence_sequence: 1, server_tick: 0, game_time: 0 } })), delay);
        }));
      }, 250);
    `);
    const platform = createLocalTaskPlatform({ serverWorkingDirectoryTemplate: template,
      serverCommand: detached ? [process.execPath, "-e", `
        require('node:child_process').spawn(process.execPath, [${JSON.stringify(serverScript)}], {detached: true, stdio: 'ignore'}).unref();
        process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);
      `] : [process.execPath, serverScript], readinessTimeoutMs: 5000,
      world: { source: { kind: "generated", seed: "435" }, worldKnowledgeProfile: "grounded_evidence" },
      createHarness: connection => { runtimePort = Number(new URL(connection.runtimeUrl).port); return { failure: new Promise<never>(() => {}), exited: new Promise<void>(() => {}), start: async () => {}, stop: async () => {
        if (hungHarness) return new Promise<void>(() => {});
        if (stopFailure) throw new AggregateError([new Error("Harness drain failed", { cause: new Error("nested cleanup cause") })], "Harness stop failed");
      } }; },
    });
    const [attempt] = await runTask({ task: { id: "authority-deadline", revision: "1", platform,
      async run({ world }) {
        expect(await world.time.isPaused()).toBe(true);
        if (foreignListener) await new Promise<void>(resolve => foreign.listen(runtimePort, "127.0.0.1", resolve));
        cleanupStarted = performance.now();
        if (foreignListener) throw new Error("primary provider failure");
        return { status: "success" };
      } },
      outputDirectory: join(root, "output"), repetitions: 1, concurrency: 1, watchdogMs: 15000, cleanupTimeoutMs });
    expect(attempt, attempt?.error).toMatchObject({ runnerStatus: foreignListener ? "process_failure" : "completed", cleanup: { status: cleanupFailed ? "failed" : "completed" } });
    if (foreignListener || hungHarness) expect(performance.now() - cleanupStarted).toBeLessThan(2000);
    if (foreignListener) {
      expect(attempt?.error).toContain("primary provider failure");
      expect(foreign.listening).toBe(true);
    }
    const events = (await readFile(join(attempt!.identity.runnerDirectory, "authority-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.method === "world.time.get" && event.type === "authority_request").every(event => event.timeout_ms === 30000)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "authority_receipt", method: "world.time.get", pending: 0 }));
    // Deadline diagnostics may finish just after the runner's hard timeout.
    const auditPath = join(attempt!.identity.runnerDirectory, "cleanup.json");
    await expect.poll(async () => JSON.parse(await readFile(auditPath, "utf8")), { timeout: 3000 }).toMatchObject({ status: cleanupFailed ? "failed" : "completed" });
    const cleanup = JSON.parse(await readFile(auditPath, "utf8"));
    expect(cleanup.server.events).toContainEqual(expect.objectContaining({ event: "launcher_exited" }));
    expect(cleanup.server.events).toContainEqual(expect.objectContaining({ event: "stop_completed" }));
    if (detached) {
      expect(cleanup.server.events).toContainEqual(expect.objectContaining({ event: "descendant_signal", signal: "SIGINT" }));
      expect(cleanup.server.events).not.toContainEqual(expect.objectContaining({ event: "descendant_signal", signal: "SIGKILL" }));
      const start = cleanup.server.events.find((event: { event: string }) => event.event === "stop_requested");
      const end = cleanup.server.events.find((event: { event: string }) => event.event === "stop_completed");
      expect(end.monotonicMs - start.monotonicMs).toBeGreaterThanOrEqual(shutdownDelay);
    }
    if (stopFailure) {
      const tree = JSON.parse(await readFile(join(attempt!.identity.runnerDirectory, "cleanup-error-tree.json"), "utf8"));
      expect(tree).toMatchObject({ name: "AggregateError", errors: [
        { message: "Harness stop failed", errors: [{ message: "Harness drain failed", cause: { message: "nested cleanup cause" } }] },
      ] });
    } else if (foreignListener) {
      expect(cleanup.error.errors).toContainEqual(expect.objectContaining({ name: "PortReleaseError", port: runtimePort }));
    } else if (hungHarness) {
      expect(cleanup.error.errors).toContainEqual(expect.objectContaining({ message: "Task resource cleanup timed out" }));
    } else expect(cleanup).toMatchObject({ status: "completed", error: null });
  } finally {
    if (foreign.listening) await new Promise<void>(resolve => foreign.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["generated", "copied_snapshot"] as const)("rejects implicit saved worlds in server templates (%s)", async kind => {
  const root = await mkdtemp(join(tmpdir(), "task-world-source-"));
  try {
    const template = join(root, "template");
    await mkdir(join(template, "world"), { recursive: true });
    const savedState = Buffer.from("existing level.dat must never override the explicit world source");
    await writeFile(join(template, "world", "level.dat"), savedState);
    const platform = createLocalTaskPlatform({
      serverWorkingDirectoryTemplate: template,
      serverCommand: [process.execPath, "-e", "process.exit(1)"],
      world: { source: kind === "generated" ? { kind, seed: "419" } : { kind, worldDirectory: join(template, "world") }, worldKnowledgeProfile: "grounded_evidence" },
      createHarness() { throw new Error("Invalid template must fail before creating a Harness"); },
    });
    const [attempt] = await runTask({
      task: { id: "world-source", revision: "1", platform, async run() { throw new Error("Invalid template must not run"); } },
      outputDirectory: join(root, "output"), repetitions: 1, concurrency: 1, watchdogMs: 1000,
    });
    expect(attempt?.runnerStatus).toBe("process_failure");
    expect(attempt?.error).toContain("Server template must not contain world");
    expect(await readFile(join(template, "world", "level.dat"))).toEqual(savedState);
  } finally { await rm(root, { recursive: true, force: true }); }
});
