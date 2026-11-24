import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { AppendOnlyFile, spawnServerProcess, stopServerProcess } from "@evicraft/server-host";
import type { TaskHarnessConnection } from "./local-task-platform.js";
import type { Json, TaskHarness } from "./index.js";

export interface ProcessHarnessConfiguration {
  readonly command: readonly [string, ...string[]];
  /** Working directory of the process; relative paths in the command and in `config` resolve against it. */
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  /** What the agent is asked to do. */
  readonly assignment: string;
  /** Settings the Harness owns; the benchmark passes them through without reading them. */
  readonly config?: Json;
}

/** The task file a Harness process reads; its path is in `EVICRAFT_TASK_FILE`. */
export interface HarnessTaskFile {
  readonly assignment: string;
  readonly bot: Readonly<{ id: string; username: string }>;
  readonly runtime: Readonly<{ url: string }>;
  /** A directory the Harness may write its own logs and artifacts into. */
  readonly outputDirectory: string;
  readonly config: Json;
}

/**
 * Runs any program as the Harness. It receives `EVICRAFT_TASK_FILE`, `EVICRAFT_RUNTIME_URL` and
 * `EVICRAFT_RUNTIME_BEARER_TOKEN`, connects to the Runtime endpoint and controls the Bot that already exists.
 * It should keep playing until it receives SIGINT; its output goes to `harness.log`.
 */
export function createProcessHarness(configuration: ProcessHarnessConfiguration): (connection: TaskHarnessConnection) => TaskHarness {
  return connection => {
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
    void failure.catch(() => {});
    let exit!: () => void;
    const exited = new Promise<void>(resolve => { exit = resolve; });
    const output = new AppendOnlyFile(join(connection.outputDirectory, "harness.log"));
    let writes = Promise.resolve();
    let child: ChildProcess | undefined;
    let stopping = false;
    return {
      failure,
      exited,
      async start() {
        if (child !== undefined) throw new Error("Harness already started");
        connection.signal.throwIfAborted();
        const taskFile = join(connection.outputDirectory, "harness-task.json");
        const task: HarnessTaskFile = {
          assignment: configuration.assignment,
          bot: connection.bot,
          runtime: { url: connection.runtimeUrl },
          outputDirectory: connection.outputDirectory,
          config: configuration.config ?? null,
        };
        await writeFile(taskFile, JSON.stringify(task, null, 2) + "\n");
        const [command, ...args] = configuration.command;
        const started = child = spawnServerProcess(command, args, { cwd: configuration.cwd, env: {
          ...process.env, ...configuration.environment,
          EVICRAFT_TASK_FILE: taskFile,
          EVICRAFT_RUNTIME_URL: connection.runtimeUrl,
          EVICRAFT_RUNTIME_BEARER_TOKEN: connection.runtimeBearerToken,
        }, stdio: ["ignore", "pipe", "pipe"] });
        const capture = (chunk: Buffer) => { writes = writes.then(() => output.append(chunk)); void writes.catch(fail); };
        started.stdout?.on("data", capture);
        started.stderr?.on("data", capture);
        started.once("exit", (code, signal) => {
          if (code !== 0 && !stopping) fail(new Error(`Harness exited: ${signal ?? code}`));
        });
        started.once("close", exit);
        await new Promise<void>((resolve, reject) => {
          started.once("spawn", resolve);
          started.once("error", error => { fail(error); exit(); reject(error); });
        });
      },
      async stop(_reason, deadline) {
        stopping = true;
        const errors: unknown[] = [];
        if (child !== undefined) {
          try {
            await stopServerProcess(child, deadline === undefined ? 1_000 : Math.max(0, deadline - performance.now()) * 0.7, deadline);
            await exited;
          } catch (error) { errors.push(error); }
        }
        try { await writes; await output.close(); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Process Harness cleanup failed");
      },
    };
  };
}
