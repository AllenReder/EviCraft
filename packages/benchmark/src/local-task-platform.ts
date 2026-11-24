import { randomBytes } from "node:crypto";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { get as httpGet } from "node:http";
import { appendFile, lstat, mkdir, readFile, writeFile, readdir, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppendOnlyFile, assertNotListening, copyWorldTemplate, PortReleaseError, reservePorts, serverProcessDiagnostics, spawnServerProcess, stopServerProcess } from "@evicraft/server-host";
import { BenchmarkAuthorityClient } from "./internal/authority/client.js";
import type { WorldRunRequest } from "./index.js";
import type { TaskHarness, TaskWorld } from "./task.js";
import { TaskPreparationError, type TaskPlatform } from "./task-runner.js";

export interface TaskHarnessConnection {
  readonly bot: { readonly id: string; readonly username: string };
  readonly runtimeUrl: string;
  readonly runtimeBearerToken: string;
  readonly outputDirectory: string;
  readonly runnerDirectory: string;
  readonly signal: AbortSignal;
}

export interface LocalTaskConfiguration {
  readonly serverWorkingDirectoryTemplate: string;
  readonly serverCommand: readonly [string, ...string[]];
  readonly environment?: Readonly<Record<string, string>>;
  readonly world: WorldRunRequest;
  readonly botUsername?: string;
  readonly difficulty?: "peaceful" | "easy" | "normal" | "hard";
  readonly readinessTimeoutMs?: number;
  /**
   * The World Run advances only while the Bot acts, waits, or is dead or respawning, so thinking costs no
   * game time. Defaults to true; false lets the world run in real time.
   */
  readonly pauseWhenIdle?: boolean;
  /** First-person camera client attached to each World Run; see scripts/maintenance/prepare-camera-client-template.mjs. */
  readonly camera?: Readonly<{
    clientTemplate: string;
    /** Client render distance in chunks. */
    viewDistance: number;
    /** Image size in pixels. */
    width: number;
    height: number;
  }>;
  readonly createHarness: (connection: TaskHarnessConnection) => TaskHarness | Promise<TaskHarness>;
}

// A reserved socket cannot be passed to Minecraft. Serialize the release-to-bind
// handoff across local platforms; execution after readiness remains concurrent.
let startupTail: Promise<void> = Promise.resolve();
async function startupLock<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = startupTail;
  startupTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  await previous;
  try { return await work(); } finally { release(); }
}

// A port stays assigned from reservation until cleanup sees it released. The camera binds its port only after the
// startup lock is released, so the kernel would otherwise be free to hand the same port to another World Run.
const assignedPorts = new Set<number>();

/** Reserve local ports that no unfinished World Run of this process was given. */
export async function assignPorts(count: number): Promise<readonly number[]> {
  for (;;) {
    const ports = await reservePorts(count);
    if (ports.some(port => assignedPorts.has(port))) continue;
    for (const port of ports) assignedPorts.add(port);
    return ports;
  }
}

/** Real local Minecraft process adapter; Task supplies experiment configuration. */
export function createLocalTaskPlatform(configuration: LocalTaskConfiguration): TaskPlatform {
  return {
    async prepare({ identity, signal, cleanupDeadline }) {
      const serverDirectory = join(identity.runnerDirectory, "server");
      await mkdir(identity.runnerDirectory, { recursive: true });
      const template = resolve(configuration.serverWorkingDirectoryTemplate);
      // The explicit world source must be the only source of saved world state.
      const savedWorld = await lstat(join(template, "world")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (savedWorld) throw new Error("Server template must not contain world; use copied_snapshot.worldDirectory to select an existing map");
      await copyWorldTemplate(template, serverDirectory);
      if (configuration.world.source.kind === "copied_snapshot") {
        await copyWorldTemplate(resolve(configuration.world.source.worldDirectory), join(serverDirectory, "world"));
      }
      let child: ChildProcess | undefined;
      let camera: ChildProcess | undefined;
      let cameraLaunch: Readonly<NonNullable<LocalTaskConfiguration["camera"]> & { minecraftPort: number; cameraPort: number }> | undefined;
      const cameraLog = configuration.camera === undefined ? undefined : new AppendOnlyFile(join(identity.runnerDirectory, "camera.log"));
      let ports: readonly number[] = [];
      let authority: BenchmarkAuthorityClient | undefined;
      let harness: TaskHarness | undefined;
      const authorityLog = new AppendOnlyFile(join(identity.runnerDirectory, "authority-events.jsonl"), 0o600);
      const serverLog = new AppendOnlyFile(join(identity.runnerDirectory, "server.log"));
      const mirrorAuthority = (event: Readonly<Record<string, string | number>>): Promise<void> => {
        const written = authorityLog.append(JSON.stringify(event) + "\n");
        void written.catch(fail);
        return written;
      };
      let closing: Promise<void> | undefined;
      let fail!: (error: Error) => void;
      const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
      void failure.catch(() => {});
      const preparing = new AbortController();
      const prepareSignal = AbortSignal.any([signal, preparing.signal]);
      let localDeadline: number | undefined;
      const deadline = () => cleanupDeadline?.() ?? (localDeadline ??= performance.now() + 10_000);
      const remaining = () => Math.max(0, deadline() - performance.now());
      // Reserve the final 30% for escalation and checking that sockets are released.
      const stopOwnedServer = () => child === undefined ? Promise.resolve() : stopServerProcess(child, remaining() * 0.7, deadline());
      const stopOwnedCamera = () => camera === undefined ? Promise.resolve() : stopServerProcess(camera, remaining() * 0.7, deadline());
      const close = (): Promise<void> => closing ??= (async () => {
        deadline();
        preparing.abort(new Error("Task world closed"));
        signal.removeEventListener("abort", abort);
        const errors: unknown[] = [];
        // Start server termination even if a foreign Harness cannot stop.
        const stopServer = stopOwnedServer();
        const stopCamera = stopOwnedCamera();
        authority?.close("cancelled");
        const settled = await Promise.allSettled([stopServer, stopCamera, withinDeadline(Promise.resolve().then(() => harness?.stop("Attempt ended", deadline())), deadline()),
          withinDeadline(authorityLog.drain(), deadline()), withinDeadline(serverLog.drain(), deadline()),
          ...(cameraLog === undefined ? [] : [withinDeadline(cameraLog.drain(), deadline())])]);
        for (const item of settled) if (item.status === "rejected") errors.push(item.reason);
        const closedLogs = await Promise.allSettled([withinDeadline(authorityLog.close(), deadline()), withinDeadline(serverLog.close(), deadline()),
          ...(cameraLog === undefined ? [] : [withinDeadline(cameraLog.close(), deadline())])]);
        for (const item of closedLogs) if (item.status === "rejected") errors.push(item.reason);
        await Promise.all(ports.map(async port => {
          try {
            await assertNotListening(port, remaining());
            assignedPorts.delete(port);
          } catch (error) { errors.push(error); }
        }));
        const cleanupError = errors.length ? new AggregateError(errors, "Task resources cleanup failed") : undefined;
        try {
          await writeFile(join(identity.runnerDirectory, "cleanup.json"), JSON.stringify({
            status: cleanupError ? "failed" : "completed",
            server: child === undefined ? null : serverProcessDiagnostics(child),
            ...(camera === undefined ? {} : { camera: serverProcessDiagnostics(camera) }),
            ports,
            error: cleanupError === undefined ? null : cleanupErrorTree(cleanupError),
          }, null, 2));
          if (cleanupError) await writeFile(join(identity.runnerDirectory, "cleanup-error-tree.json"), JSON.stringify(cleanupErrorTree(cleanupError), null, 2));
        } catch (error) {
          if (cleanupError) throw new AggregateError([cleanupError, error], "Task cleanup and its audit failed");
          throw error;
        }
        if (cleanupError) throw cleanupError;
      })();
      const abort = () => {
        authority?.close("cancelled");
        void stopOwnedServer().catch(() => {});
        void stopOwnedCamera().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const runtime = await startupLock(async () => {
          signal.throwIfAborted();
          ports = await assignPorts(configuration.camera === undefined ? 3 : 4);
          const [minecraftPort, runtimePort, authorityPort, cameraPort] = ports;
          if (minecraftPort === undefined || runtimePort === undefined || authorityPort === undefined) throw new Error("Port allocation failed");
          if (configuration.camera !== undefined) {
            if (cameraPort === undefined) throw new Error("Port allocation failed");
            cameraLaunch = { ...configuration.camera, minecraftPort, cameraPort };
          }
          await configureServer(serverDirectory, configuration, minecraftPort, runtimePort);
          const runtimeBearerToken = randomBytes(32).toString("hex");
          const authorityToken = randomBytes(32).toString("hex");
          signal.throwIfAborted();
          const [command, ...args] = configuration.serverCommand;
          child = spawnServerProcess(command, args, { cwd: serverDirectory, env: {
            ...process.env, ...configuration.environment,
            EVICRAFT_RUNTIME_PORT: String(runtimePort), EVICRAFT_RUNTIME_BEARER_TOKEN: runtimeBearerToken,
            EVICRAFT_BENCHMARK_AUTHORITY_PORT: String(authorityPort), EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN: authorityToken,
            EVICRAFT_TASK_START_PAUSED: "true",
            EVICRAFT_RUNTIME_PAUSE_WHEN_IDLE: String(configuration.pauseWhenIdle ?? true),
            EVICRAFT_WORLD_KNOWLEDGE_PROFILE: configuration.world.worldKnowledgeProfile,
            EVICRAFT_GROUNDED_BLOCK_EXPIRY_TICKS: String(configuration.world.groundedBlockExpiryTicks ?? 400),
            EVICRAFT_GROUNDED_ENTITY_EXPIRY_TICKS: String(configuration.world.groundedEntityExpiryTicks ?? 400),
            EVICRAFT_GROUNDED_FIELD_OF_VIEW_DEGREES: String(configuration.world.groundedFieldOfViewDegrees ?? 360),
            ...(cameraLaunch === undefined ? {} : {
              EVICRAFT_CAMERA_USERNAME: CAMERA_USERNAME, EVICRAFT_CAMERA_PORT: String(cameraLaunch.cameraPort),
            }),
          }, stdio: ["pipe", "pipe", "pipe"] });
          child.once("error", fail);
          child.once("exit", (code, reason) => { if (closing === undefined) fail(new Error(`Minecraft exited: ${reason ?? code}; see ${join(identity.runnerDirectory, "server.log")}`)); });
          const capture = (chunk: Buffer) => { void serverLog.append(chunk).catch(fail); };
          child.stdout?.on("data", capture);
          child.stderr?.on("data", capture);
          authority = await Promise.race([waitForAuthority(authorityPort, authorityToken, configuration.readinessTimeoutMs ?? 600_000, prepareSignal, mirrorAuthority), failure]);
          return { runtimeUrl: `ws://127.0.0.1:${runtimePort}/rpc`, runtimeBearerToken };
        });
        signal.throwIfAborted();
        const ready = authority!;
        if (!await ready.isTimePaused()) throw new Error("Task server did not start paused");
        const actor = await ready.createActor(configuration.botUsername ?? "bot");
        if (!actor.present) throw new Error("Task Bot was not created");
        const bot = { id: actor.uuid, username: actor.name };
        if (cameraLaunch !== undefined) {
          const cameraDirectory = join(identity.runnerDirectory, "camera");
          await copyWorldTemplate(resolve(cameraLaunch.clientTemplate), cameraDirectory);
          camera = spawnServerProcess(process.execPath, ["launch.mjs"], { cwd: cameraDirectory, env: {
            ...process.env,
            EVICRAFT_CAMERA_SERVER: `127.0.0.1:${cameraLaunch.minecraftPort}`,
            EVICRAFT_CAMERA_USERNAME: CAMERA_USERNAME,
            EVICRAFT_CAMERA_PORT: String(cameraLaunch.cameraPort),
            EVICRAFT_CAMERA_VIEW_DISTANCE: String(cameraLaunch.viewDistance),
            EVICRAFT_CAMERA_WIDTH: String(cameraLaunch.width),
            EVICRAFT_CAMERA_HEIGHT: String(cameraLaunch.height),
          }, stdio: ["ignore", "pipe", "pipe"] });
          camera.once("error", fail);
          camera.once("exit", (code, reason) => { if (closing === undefined) fail(new Error(`Camera client exited: ${reason ?? code}; see ${join(identity.runnerDirectory, "camera.log")}`)); });
          const captureCamera = (chunk: Buffer) => { void cameraLog!.append(chunk).catch(fail); };
          camera.stdout?.on("data", captureCamera);
          camera.stderr?.on("data", captureCamera);
          await Promise.race([waitForCamera(cameraLaunch.cameraPort, CAMERA_READINESS_TIMEOUT_MS, prepareSignal), failure]);
        }
        harness = await configuration.createHarness({ ...runtime, bot, signal, outputDirectory: identity.taskDirectory, runnerDirectory: identity.runnerDirectory });
        signal.throwIfAborted();
        await writeFile(join(identity.runnerDirectory, "world.json"), JSON.stringify({ bot, ports, world: configuration.world }) + "\n");
        const world: TaskWorld = {
          snapshot: (selection) => ready.getSnapshot(selection ?? { actor: true, inventory: true, blocks: [] }),
          advancementDefinitions: () => ready.getAdvancementDefinitions(),
          teleportActor: (input) => ready.teleportActor(input),
          setRespawnPoint: (input) => ready.setRespawnPoint(input),
          giveItem: (input) => ready.giveItem(input),
          setInventorySlot: (input) => ready.setInventorySlot(input),
          setEquipment: (input) => ready.setEquipment(input),
          setBlock: (input) => ready.setBlock(input),
          executeMinecraftCommand: (command) => ready.executeMinecraftCommand(command),
          startRun: (input) => ready.startRun(input),
          time: { pause: async () => { await ready.pauseTime(); }, resume: async () => { await ready.resumeTime(); }, isPaused: () => ready.isTimePaused() },
        };
        return { world, bot, harness, close,
          captureDiagnostics: async () => {
            const state = ready.diagnostics().then(value => ({ value }), error => ({ error: String(error) }));
            if (process.platform === "linux") {
              for (const pid of await readdir("/proc")) {
                if (!/^\d+$/.test(pid)) continue;
                const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
                const executable = await readlink(`/proc/${pid}/exe`).catch(() => undefined);
                if (cwd !== serverDirectory || !executable?.endsWith("/java")) continue;
                const command = join(executable.slice(0, -4), "jcmd");
                const dump = await promisify(execFile)(command, [pid, "Thread.print"], { timeout: 5_000, maxBuffer: 5_000_000 });
                await writeFile(join(identity.runnerDirectory, "runtime-threads.txt"), dump.stdout);
                const settings = (await readFile(join(dirname(executable), "../lib/jfr/profile.jfc"), "utf8"))
                  .replace(/(<event name="jdk.Initial(?:EnvironmentVariable|SystemProperty)">\s*<setting name="enabled">)[^<]+(<\/setting>)/g, "$1false$2");
                const settingsPath = join(identity.runnerDirectory, "failure.jfc");
                await writeFile(settingsPath, settings);
                await promisify(execFile)(command, [pid, "JFR.start", "name=attempt-failure", `settings=${settingsPath}`, "duration=1s",
                  `filename=${join(identity.runnerDirectory, "runtime-failure.jfr")}`], { timeout: 2_000 }).catch(() => {});
                await delay(1200);
              }
            }
            await writeFile(join(identity.runnerDirectory, "runtime-diagnostics.json"), JSON.stringify(await state, null, 2));
          }, failure: Promise.race([failure, harness.failure]) };
      } catch (error) {
        try { await close(); } catch (cleanupError) { throw new TaskPreparationError(error, cleanupError); }
        throw error;
      }
    },
  };
}

/** Preserve cleanup causes without serializing arbitrary provider/transport objects. */
function cleanupErrorTree(error: unknown, seen = new Set<unknown>()): unknown {
  if (!(error instanceof Error)) return { name: "NonError", message: String(error) };
  if (seen.has(error)) return { name: error.name, message: error.message, repeated: true };
  seen.add(error);
  return {
    name: error.name,
    message: error.message,
    ...(error instanceof PortReleaseError ? { port: error.port, ownership: error.ownership } : {}),
    ...(error.cause === undefined ? {} : { cause: cleanupErrorTree(error.cause, seen) }),
    ...(error instanceof AggregateError ? { errors: error.errors.map(item => cleanupErrorTree(item, seen)) } : {}),
  };
}

async function configureServer(directory: string, config: LocalTaskConfiguration, minecraftPort: number, runtimePort: number): Promise<void> {
  const propertiesPath = join(directory, "server.properties");
  let source = "";
  try { source = await readFile(propertiesPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const values = new Map<string, string>([["level-name", "world"], ["difficulty", config.difficulty ?? "peaceful"], ["server-port", String(minecraftPort)], ["server-ip", "127.0.0.1"], ["online-mode", "false"], ["allow-flight", "true"], ["spawn-protection", "0"], ["max-tick-time", "-1"]]);
  if (config.world.source.kind === "generated") values.set("level-seed", config.world.source.seed);
  await writeFile(propertiesPath, [...source.split(/\r?\n/u).filter(line => line !== "" && !values.has(line.split("=", 1)[0] ?? "")), ...[...values].map(([key, value]) => `${key}=${value}`), ""].join("\n"));
  await appendFile(join(directory, "user_jvm_args.txt"), `\n-Dmcagent.port=${runtimePort}\n`);
}

async function waitForAuthority(port: number, bearerToken: string, timeout: number, signal: AbortSignal, mirror: (event: Readonly<Record<string, string | number>>) => Promise<void>): Promise<BenchmarkAuthorityClient> {
  const deadline = performance.now() + timeout;
  let last: unknown;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    let client: BenchmarkAuthorityClient | undefined;
    try {
      client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${port}/rpc`, bearerToken, handshakeTimeoutMs: Math.min(5_000, Math.max(1, deadline - performance.now())), signal, mirror });
      const cancel = () => client?.close("cancelled");
      signal.addEventListener("abort", cancel, { once: true });
      try { await client.info(Math.min(5_000, Math.max(1, deadline - performance.now()))); }
      finally { signal.removeEventListener("abort", cancel); }
      if (signal.aborted) { client.close(); signal.throwIfAborted(); }
      return client;
    } catch (error) { client?.close(); last = error; await delay(100, undefined, { signal }); }
  }
  throw new Error(`Task server readiness timed out: ${String(last)}`);
}

/** Camera player name; the server excludes it from the World and keeps it a spectator at the Bot's eye. */
const CAMERA_USERNAME = "camera";
const CAMERA_READINESS_TIMEOUT_MS = 300_000;

/** The camera mod reports in_world once its player joined; the server ticks its connection even while paused. */
async function waitForCamera(port: number, timeout: number, signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + timeout;
  let last: unknown;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    try {
      // node:http, not fetch: a process-wide proxy dispatcher must never route loopback control traffic.
      const status = JSON.parse(await new Promise<string>((resolvePromise, reject) => {
        const request = httpGet({ host: "127.0.0.1", port, path: "/status", timeout: 5_000, signal }, response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => resolvePromise(body));
          response.on("error", reject);
        });
        request.on("timeout", () => request.destroy(new Error("camera status timed out")));
        request.on("error", reject);
      })) as { in_world?: boolean };
      if (status.in_world === true) return;
      last = new Error("camera not in world yet");
    } catch (error) { last = error; }
    await delay(1_000, undefined, { signal });
  }
  throw new Error(`Camera client readiness timed out: ${String(last)}`);
}

async function withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Task resource cleanup timed out")), Math.max(0, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}
