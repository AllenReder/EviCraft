import { createLocalTaskPlatform, createProcessHarness, defineTask, type BenchmarkTask } from "@evicraft/benchmark";
import { loadTaskConfiguration } from "./config.ts";
import { runMinecraftBenchmark } from "./run.ts";

export interface MinecraftTaskDefinition {
  readonly id: string;
  readonly revision: string;
  /** What the agent is asked to do; the Harness receives it as the task file's `assignment`. */
  readonly assignment: string;
  /** Changes whenever the assignment's wording does; recorded with every result. */
  readonly promptRevision: string;
}

/**
 * A Minecraft task is an assignment and, outside this file, a scorer. Everything else is shared: a task config
 * names the frozen world, the knowledge profile, the tick budget, the camera and the Harness; each Attempt
 * gets its own server; and the Runtime's samples are recorded for offline scoring.
 */
export function defineMinecraftTask({ id, revision, assignment, promptRevision }: MinecraftTaskDefinition): BenchmarkTask {
  return defineTask({
    id, revision,
    async configure(configPath) {
      const config = await loadTaskConfiguration(configPath);
      const metadata = { ...config.metadata, promptRevision, assignment };
      return {
        configuration: { ...metadata, tickBudget: config.tickBudget,
          serverTemplatePath: config.serverWorkingDirectoryTemplate, serverCommand: config.serverCommand, snapshotPath: config.world.source.worldDirectory },
        platform: createLocalTaskPlatform({
          serverWorkingDirectoryTemplate: config.serverWorkingDirectoryTemplate,
          serverCommand: config.serverCommand, world: config.world, difficulty: "easy",
          readinessTimeoutMs: 600_000, pauseWhenIdle: config.pauseWhenIdle,
          ...(config.camera === undefined ? {} : { camera: config.camera }),
          createHarness: createProcessHarness({ ...config.harness, assignment }),
        }),
        run: context => runMinecraftBenchmark(context, { ...config, metadata }),
      };
    },
  });
}
