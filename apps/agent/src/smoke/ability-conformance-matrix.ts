import { randomUUID } from "node:crypto";
import { runtimeCommand } from "./rcon.js";
import { abilities } from "../harness/abilities/index.js";
import { assertRuntimeAbilityToolWitnesses } from "./runtime-backed-ability-conformance.js";
import type { ChildProcess } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeClient } from "@evicraft/runtime-sdk";

import type { PreparedAbilityConformanceWorktree } from "./current-worktree.js";
import { runWithFreshScenarioWorld, ScenarioRunError } from "./conformance-runner.js";
import {
  startCurrentWorktreeServer, uniqueRunId, waitForRuntimeReady,
} from "./current-worktree.js";
import {
  assertNotListening, forwardSignalsToServer, reservePorts, stopServer,
} from "./neoforge-server-process.js";
import {
  ABILITY_CONFORMANCE_SCENARIOS,
  type AbilityConformanceScenarioId,
  type AbilityConformanceScenarioRegistration,
} from "./scenarios/index.js";
import { assertPausedScenarioOracle, type ScenarioOracle } from "./scenarios/shared.js";

export interface AbilityConformanceMatrixDependencies {
  readonly runFixtureLifecycle: (
    prepared: PreparedAbilityConformanceWorktree,
  ) => Promise<void>;
  readonly runScenario: (
    prepared: PreparedAbilityConformanceWorktree,
    scenario: AbilityConformanceScenarioRegistration,
  ) => Promise<void>;
}

export async function runAbilityConformanceMatrix(
  prepared: PreparedAbilityConformanceWorktree,
  scenarioId?: AbilityConformanceScenarioId,
  dependencies: AbilityConformanceMatrixDependencies = defaultDependencies(),
): Promise<void> {
  if (scenarioId === undefined) {
    await dependencies.runFixtureLifecycle(prepared);
    for (const scenario of ABILITY_CONFORMANCE_SCENARIOS) {
      await dependencies.runScenario(prepared, scenario);
    }
    return;
  }
  const scenario = ABILITY_CONFORMANCE_SCENARIOS.find(({ id }) => id === scenarioId);
  if (scenario === undefined) throw new Error(`Unknown Ability Conformance scenario ${scenarioId}`);
  await dependencies.runScenario(prepared, scenario);
}

function defaultDependencies(): AbilityConformanceMatrixDependencies {
  return {
    runFixtureLifecycle: runAbilityConformanceFixtureLifecycleSmoke,
    runScenario,
  };
}

export async function runAbilityConformanceFixtureLifecycleSmoke(
  prepared: PreparedAbilityConformanceWorktree,
): Promise<void> {
  const scenario = "food-consumption-and-recovery";
  const template = prepared.templates.find(({ scenario: id }) => id === scenario);
  if (template === undefined) throw new Error(`Prepared template missing for ${scenario}`);
  let retained: ScenarioRunError | undefined;
  let pausedOracleReceipt: Awaited<ReturnType<typeof assertPausedScenarioOracle>> | undefined;
  try {
    await runWithFreshScenarioWorld({
      scenario,
      cacheRoot: prepared.cacheRoot,
      runsRoot: prepared.runsRoot,
      versions: prepared.versions,
      runId: uniqueRunId("fixture-lifecycle"),
      preparedTemplate: template,
      execute: async ({ serverDirectory, artifactsDirectory, manifest }) => {
        await mkdir(artifactsDirectory, { recursive: true });
        const logPath = join(artifactsDirectory, "server.log");
        await withFreshScenarioServer({
          scenario,
          serverDirectory,
          logPath,
          bearerToken: `fixture-lifecycle-${uniqueRunId(scenario)}`,
        }, async ({ oracle, client }) => {
          const marker = manifest.hiddenMarkers.sealed_probe;
          if (marker === undefined) throw new Error("fixture lifecycle marker is unavailable to the Oracle");
          pausedOracleReceipt = await assertPausedScenarioOracle({ oracle, client, artifactsDirectory }, "sealed fixture lifecycle marker",
            `execute if block ${marker.x} ${marker.y} ${marker.z} minecraft:emerald_block`);
        });
        throw new FixtureRetentionProbe();
      },
    });
  } catch (error) {
    if (!(error instanceof ScenarioRunError) || !(error.cause instanceof FixtureRetentionProbe)) {
      throw error;
    }
    retained = error;
  }
  if (retained === undefined) throw new Error("fixture lifecycle retention probe was not retained");
  await stat(join(retained.retainedRunDirectory, "server", "world", "level.dat"));
  await stat(join(retained.retainedArtifactsDirectory, "server.log"));
  await rm(retained.retainedRunDirectory, { recursive: true });
  process.stdout.write(`${JSON.stringify({
    event: "ability_conformance_fixture_lifecycle_passed",
    scenario,
    runtime_bot_free: true,
    paused_oracle_receipt: pausedOracleReceipt,
    hidden_marker_verified: "sealed_probe",
    failed_run_retained: true,
    retained_probe_cleaned: true,
    server_stopped: true,
  })}\n`);
}

async function runScenario(
  prepared: PreparedAbilityConformanceWorktree,
  scenario: AbilityConformanceScenarioRegistration,
): Promise<void> {
  const template = prepared.templates.find(({ scenario: id }) => id === scenario.id);
  if (template === undefined) throw new Error(`Prepared template missing for ${scenario.id}`);
  await runWithFreshScenarioWorld({
    scenario: scenario.id as AbilityConformanceScenarioId,
    cacheRoot: prepared.cacheRoot,
    runsRoot: prepared.runsRoot,
    versions: prepared.versions,
    runId: uniqueRunId(scenario.id),
    preparedTemplate: template,
    execute: async ({ serverDirectory, artifactsDirectory, manifest }) => {
      await mkdir(artifactsDirectory, { recursive: true });
      const bearerToken = `ability-conformance-${uniqueRunId(scenario.id)}`;
      const ports = await withFreshScenarioServer({
        scenario: scenario.id as AbilityConformanceScenarioId,
        serverDirectory,
        bearerToken,
        logPath: join(artifactsDirectory, "server.log"),
      }, async ({ client, runtimeUrl, server, oracle }) => await scenario.run({
        client, runtimeUrl, bearerToken, artifactsDirectory, manifest, server, oracle,
      }));
      process.stdout.write(`${JSON.stringify({
        event: "ability_conformance_scenario_passed",
        scenario: scenario.id,
        minecraft_port: ports.minecraftPort,
        runtime_port: ports.runtimePort,
        server_stopped: true,
      })}\n`);
    },
  });
}

async function withFreshScenarioServer(
  input: Readonly<{
    scenario: AbilityConformanceScenarioId;
    serverDirectory: string;
    bearerToken: string;
    logPath: string;
  }>,
  execute: (context: Readonly<{
    client: RuntimeClient;
    runtimeUrl: string;
    server: ChildProcess;
    oracle: ScenarioOracle;
  }>) => Promise<void>,
): Promise<Readonly<{ minecraftPort: number; runtimePort: number }>> {
  const [minecraftPort, runtimePort, rconPort] = await reservePorts(3);
  if (minecraftPort === undefined || runtimePort === undefined || rconPort === undefined) {
    throw new Error("Could not reserve Ability Conformance smoke ports");
  }
  const rconPassword = randomUUID();
  const runtimeUrl = `ws://127.0.0.1:${runtimePort}/rpc`;
  const server = await startCurrentWorktreeServer({
    serverDirectory: input.serverDirectory,
    minecraftPort,
    runtimePort,
    bearerToken: input.bearerToken,
    logPath: input.logPath,
    rcon: { port: rconPort, password: rconPassword },
  });
  const stopForwarding = forwardSignalsToServer(server);
  let failure: unknown;
  try {
    await waitForRuntimeReady(runtimeUrl, input.bearerToken, server);
    const client = await RuntimeClient.connect({ url: runtimeUrl, bearerToken: input.bearerToken });
    try {
      assertRuntimeAbilityToolWitnesses(abilities, (await client.toolList()).tools);
      if (await client.actorGet() !== null) {
        throw new Error(`fresh ${input.scenario} template contained a Runtime Bot`);
      }
      const oracle: ScenarioOracle = {
        executeMinecraftCommand: command => runtimeCommand({ rconPort, rconPassword }, command),
      };
      await execute({ client, runtimeUrl, server, oracle });
    } finally {
      client.close();
    }
  } catch (error) {
    failure = error;
  } finally {
    stopForwarding();
    try {
      await stopServer(server);
      await assertNotListening(minecraftPort);
      await assertNotListening(runtimePort);
      await assertNotListening(rconPort);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  return { minecraftPort, runtimePort };
}

class FixtureRetentionProbe extends Error {
  public constructor() {
    super("expected fixture lifecycle artifact-retention probe");
    this.name = "FixtureRetentionProbe";
  }
}
