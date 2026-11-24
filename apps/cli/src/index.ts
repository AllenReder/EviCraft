#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectBatch, loadBatch, resumeBatch, runBatch, type BatchPlan } from "@evicraft/benchmark/task-runner";
import { createRunDirectory, freezeConfig, freezePlan, parseOverride, requireTemplates, reshapePlan, type HarnessReplacement } from "./run-directory.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Where the world that `world` holds open publishes how to reach it; `harness` reads it. */
const WORLD_STATE = resolve(process.env.EVICRAFT_WORLD_STATE || join(ROOT, "build", "world-state.json"));
const HARNESS_SLOT = fileURLToPath(new URL("./harness-slot.js", import.meta.url));
/** A development world has no deadline: the largest budget the Runtime takes, years of game time. */
const WORLD_TICK_BUDGET = 2_000_000_000;
const WORLD_WATCHDOG_MS = 2_000_000_000;

const USAGE = `usage: evicraft <command> [options]

  setup [--accept-eula] [--no-camera] [--offline]
                                        build the server and camera client templates under build/
  check                                 real-server integration check; no model or GPU
  run <batch.yaml> [options] [-- <harness command...>]
  run <task-dir> --config <file> [--id name] [options] [-- <harness command...>]
      run a batch, or one config, into a new run directory
      --out <dir>            a new directory (default runs/<name>-<time>)
      --set key.path=value   override a field of every config; repeatable
      --instance <id>        run only this instance; repeatable
      --repetitions N        Attempts per instance, replacing the batch's count
      --concurrency N        Attempts at once, replacing the batch's value
      -- <command...>        run this Harness instead of the one in each config; relative paths resolve
                             against the current directory
      --harness-config <f>   JSON passed to that Harness as the task file's config (default null)
      --dry-run  --watchdog-ms N  --cleanup-timeout-ms N
  resume <run-dir>                      finish the unfinished Attempts of a run
  score <run-dir> [--out <dir>] [--workers N]
  world <task-dir> --config <file> [--set key.path=value] [--out <dir>]
      hold one config's world open for development: the server, snapshot, knowledge profile, camera and Bot
      that "run" would give it, with no tick budget and no Harness; stop it with Ctrl-C
  harness [args...]                     start that config's Harness on the held world, in this terminal
  harness [--harness-config <f>] -- <command...>
                                        start your own Harness on it instead
      EVICRAFT_WORLD_STATE=<file> names the file that links the two (default build/world-state.json); give two
      worlds different files to hold both at once`;

const SCORERS: Readonly<Record<string, string>> = {
  "minecraft-survival": "tasks/minecraft-survival/eval/evaluate-survival.py",
  "minecraft-item-discovery": "tasks/minecraft-item-discovery/eval/evaluate-discovery.py",
};

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "setup": return setup(rest);
    case "check": return child(process.execPath, [join(ROOT, "apps/cli/test/integration/index.mjs")]);
    case "run": return run(rest);
    case "resume": return resume(rest);
    case "score": return score(rest);
    case "world": return world(rest);
    case "harness": return harness(rest);
    case undefined: case "help": case "--help": case "-h":
      process.stdout.write(`${USAGE}\n`); return command === undefined ? 1 : 0;
    default: throw new Error(`Unknown command ${JSON.stringify(command)}\n${USAGE}`);
  }
}

async function setup(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: {
    "accept-eula": { type: "boolean", default: false }, "no-camera": { type: "boolean", default: false }, offline: { type: "boolean", default: false },
  } });
  const offline = values.offline ? ["--offline"] : [];
  if (!values["accept-eula"]) {
    throw new Error("The server template writes eula=true. Pass --accept-eula to accept the Minecraft EULA (https://www.minecraft.net/eula).");
  }
  const server = await child(process.execPath, [join(ROOT, "scripts/maintenance/prepare-neoforge-server-template.mjs"), join(ROOT, "build/survival-server"), "--accept-eula", ...offline]);
  if (server !== 0 || values["no-camera"]) return server;
  return child(process.execPath, [join(ROOT, "scripts/maintenance/prepare-camera-client-template.mjs"), join(ROOT, "build/camera-client"), ...offline]);
}

async function run(argv: readonly string[]): Promise<number> {
  const [own, command] = splitCommand(argv);
  const { positionals, values } = parseArgs({ args: [...own], allowPositionals: true, options: {
    out: { type: "string" }, set: { type: "string", multiple: true, default: [] },
    config: { type: "string" }, id: { type: "string", default: "instance" },
    instance: { type: "string", multiple: true, default: [] },
    repetitions: { type: "string" }, concurrency: { type: "string" },
    "harness-config": { type: "string" },
    "watchdog-ms": { type: "string", default: "86400000" }, "cleanup-timeout-ms": { type: "string", default: "30000" },
    "dry-run": { type: "boolean", default: false },
  } });
  const [source] = positionals;
  if (positionals.length !== 1 || !source) throw new Error(USAGE);
  if (values["harness-config"] && !command) throw new Error("--harness-config needs a Harness command after --");
  const overrides = values.set.map(parseOverride);
  const harness: HarnessReplacement | undefined = command && {
    command, workingDirectory: process.cwd(),
    config: values["harness-config"] ? JSON.parse(await readFile(resolve(values["harness-config"]), "utf8")) : null,
  };
  const loaded: BatchPlan = values.config
    ? { concurrency: 1, executions: [{ instance: { id: values.id, taskPath: resolve(source), configPath: resolve(values.config) }, repetition: 0 }] }
    : await loadBatch(source);
  const plan = reshapePlan(loaded, {
    instances: values.instance,
    ...(values.repetitions === undefined ? {} : { repetitions: positiveInteger(values.repetitions, "--repetitions") }),
    ...(values.concurrency === undefined ? {} : { concurrency: positiveInteger(values.concurrency, "--concurrency") }),
  });
  if (values["dry-run"]) {
    const scratch = await mkdtemp(join(tmpdir(), "evicraft-dry-run-"));
    try { print(await inspectBatch(await freezePlan(scratch, plan, overrides, harness))); }
    finally { await rm(scratch, { recursive: true, force: true }); }
    return 0;
  }
  const name = values.config ? values.id : basename(dirname(resolve(source)));
  const runDirectory = resolve(values.out ?? join("runs", `${name}-${timestamp()}`));
  const frozen = await createRunDirectory(runDirectory, plan, overrides, inspectBatch, harness);
  process.stderr.write(`evicraft: run directory ${runDirectory}\n`);
  return withInterrupt(async signal => {
    const result = await runBatch({ plan: frozen, outputDirectory: join(runDirectory, "raw"), signal,
      watchdogMs: positiveInteger(values["watchdog-ms"], "--watchdog-ms"),
      cleanupTimeoutMs: positiveInteger(values["cleanup-timeout-ms"], "--cleanup-timeout-ms") });
    print(result);
    return result.status === "completed" ? 0 : 1;
  });
}

async function resume(argv: readonly string[]): Promise<number> {
  const [runDirectory] = argv;
  if (argv.length !== 1 || !runDirectory) throw new Error("usage: evicraft resume <run-dir>");
  const raw = join(resolve(runDirectory), "raw");
  const batches = (await readdir(raw, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory());
  if (batches.length !== 1) throw new Error(`${raw} must hold exactly one batch directory, found ${batches.length}`);
  return withInterrupt(async signal => {
    const result = await resumeBatch(join(raw, batches[0]!.name), signal);
    print(result);
    return result.status === "completed" ? 0 : 1;
  });
}

async function score(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: [...argv], allowPositionals: true, options: { out: { type: "string" }, workers: { type: "string" } } });
  const [runDirectory] = positionals;
  if (positionals.length !== 1 || !runDirectory) throw new Error("usage: evicraft score <run-dir> [--out <dir>] [--workers N]");
  const run = resolve(runDirectory);
  const plan = JSON.parse(await readFile(join(run, "dry-run.json"), "utf8")) as { instances?: { taskId: string }[] };
  const tasks = [...new Set((plan.instances ?? []).map(instance => instance.taskId))];
  if (tasks.length !== 1) throw new Error(`A run directory must hold one task to score, found ${JSON.stringify(tasks)}`);
  const scorer = SCORERS[tasks[0]!];
  if (!scorer) throw new Error(`No scorer for task ${tasks[0]}`);
  const out = resolve(values.out ?? join(run, "eval", timestamp()));
  return child(process.env.EVICRAFT_PYTHON || "python3", [join(ROOT, scorer), "--run", run, "--out", out, ...(values.workers ? ["--workers", values.workers] : [])]);
}

/**
 * A development world is one Attempt of a task config whose Harness slot is held by `harness-slot.js`: the
 * Runner prepares and runs it exactly as `run` does, and the real Harness is started by hand with `harness`.
 */
async function world(argv: readonly string[]): Promise<number> {
  const usage = "usage: evicraft world <task-dir> --config <file> [--set key.path=value] [--out <dir>]";
  const { positionals, values } = parseArgs({ args: [...argv], allowPositionals: true, options: {
    config: { type: "string" }, set: { type: "string", multiple: true, default: [] }, out: { type: "string" },
  } });
  const [taskDirectory] = positionals;
  if (positionals.length !== 1 || !taskDirectory || !values.config) throw new Error(usage);
  if (await exists(WORLD_STATE)) throw new Error(`A world is already running, or one was killed and left ${WORLD_STATE} behind; stop it or delete that file`);
  const runDirectory = resolve(values.out ?? join("runs", `world-${timestamp()}`));
  if (await exists(runDirectory)) throw new Error(`Directory already exists: ${runDirectory}; choose a new --out`);
  const config = await freezeConfig(resolve(values.config), [{ path: ["tickBudget"], value: WORLD_TICK_BUDGET }, ...values.set.map(parseOverride)]);
  await requireTemplates(config);
  // The slot receives the Harness the config names as its own `config`, so `harness` finds it in the task file.
  config.harness = { command: [process.execPath, HARNESS_SLOT, WORLD_STATE], workingDirectory: ROOT, config: config.harness };
  const configPath = join(runDirectory, "inputs", "world.json");
  await mkdir(dirname(WORLD_STATE), { recursive: true });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const plan: BatchPlan = { concurrency: 1, executions: [{ instance: { id: "world", taskPath: resolve(taskDirectory), configPath }, repetition: 0 }] };
  process.stderr.write(`evicraft: world directory ${runDirectory}; starting the server\n`);
  return withInterrupt(async signal => {
    const announce = setInterval(() => void exists(WORLD_STATE).then(ready => {
      if (!ready) return;
      clearInterval(announce);
      process.stderr.write("evicraft: world ready; start a Harness with `evicraft harness` in another shell, stop the world with Ctrl-C\n");
    }), 250);
    try {
      const result = await runBatch({ plan, outputDirectory: join(runDirectory, "raw"), signal, watchdogMs: WORLD_WATCHDOG_MS, cleanupTimeoutMs: 30_000 });
      const attempt = result.attempts.at(-1);
      const cleanup = attempt && "cleanup" in attempt ? attempt.cleanup : undefined;
      if (signal.aborted && cleanup?.status === "completed") return 0;
      process.stderr.write(`evicraft: world ended: ${(attempt && "error" in attempt ? attempt.error : undefined) ?? cleanup?.error ?? attempt?.runnerStatus}; see ${join(runDirectory, "raw")}\n`);
      return 1;
    } finally {
      clearInterval(announce);
      await rm(WORLD_STATE, { force: true });
    }
  });
}

/** The Harness a task config names, as `freezeConfig` leaves it. */
interface NamedHarness { readonly command: readonly string[]; readonly workingDirectory: string; readonly config?: unknown }

async function harness(argv: readonly string[]): Promise<number> {
  const [own, command] = splitCommand(argv);
  const { positionals, values } = parseArgs({ args: [...own], allowPositionals: true, options: { "harness-config": { type: "string" } } });
  if (values["harness-config"] && !command) throw new Error("--harness-config needs a Harness command after --");
  if (command && positionals.length) throw new Error(`Unexpected ${JSON.stringify(positionals[0])} before --`);
  const state = await readFile(WORLD_STATE, "utf8").then(text => JSON.parse(text) as { taskFile: string; runtimeUrl: string; bearerToken: string }, () => undefined);
  if (!state) throw new Error("No world is ready: start one with `evicraft world <task-dir> --config <file>` and wait for \"world ready\"");
  // The slot's task file is the one the Runner wrote for this world; its `config` is the Harness the config names.
  const task = JSON.parse(await readFile(state.taskFile, "utf8")) as { outputDirectory: string; config: NamedHarness };
  const launch = command
    ? { command, workingDirectory: process.cwd(), config: values["harness-config"] ? JSON.parse(await readFile(resolve(values["harness-config"]), "utf8")) as unknown : null }
    : { command: [...task.config.command, ...positionals], workingDirectory: task.config.workingDirectory, config: task.config.config ?? null };
  // Each start gets its own output directory and the world's task file with its own `config`.
  const outputDirectory = await mkdtemp(join(task.outputDirectory, `harness-${timestamp()}-`));
  const taskFile = join(outputDirectory, "harness-task.json");
  await writeFile(taskFile, `${JSON.stringify({ ...task, outputDirectory, config: launch.config }, null, 2)}\n`);
  process.stderr.write(`evicraft: task file ${taskFile}\n`);
  return child(launch.command[0]!, launch.command.slice(1), { ...process.env,
    EVICRAFT_TASK_FILE: taskFile, EVICRAFT_RUNTIME_URL: state.runtimeUrl, EVICRAFT_RUNTIME_BEARER_TOKEN: state.bearerToken }, launch.workingDirectory);
}

/** Split `options -- command...`; the command is undefined without `--`. */
function splitCommand(argv: readonly string[]): [readonly string[], string[] | undefined] {
  const separator = argv.indexOf("--");
  if (separator < 0) return [argv, undefined];
  const command = argv.slice(separator + 1);
  if (!command.length) throw new Error("Expected a Harness command after --");
  return [argv.slice(0, separator), command];
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "");
}

/** Run a program in this terminal and return its exit code. */
function child(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<number> {
  const started = spawn(command, args, { env, stdio: "inherit", ...(cwd === undefined ? {} : { cwd }) });
  // Ctrl-C reaches the program from the terminal, which signals the whole foreground group: wait for it to
  // finish instead of signalling it a second time. A SIGTERM is addressed to this process alone, so pass it on.
  const wait = () => {};
  const forward = () => started.kill("SIGTERM");
  process.on("SIGINT", wait); process.on("SIGTERM", forward);
  return new Promise<number>((resolveExit, reject) => {
    started.once("error", reject);
    started.once("exit", (code, signal) => {
      process.off("SIGINT", wait); process.off("SIGTERM", forward);
      resolveExit(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function withInterrupt(body: (signal: AbortSignal) => Promise<number>): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try { return await body(controller.signal); }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}

function positiveInteger(text: string, name: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
