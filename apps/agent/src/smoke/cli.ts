#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  runAbilityConformanceMatrix as executeAbilityConformanceMatrix,
} from "./ability-conformance-matrix.js";
import {
  prepareAbilityConformanceWorktree as executeAbilityConformancePreparation,
  type PreparedAbilityConformanceWorktree,
} from "./current-worktree.js";
import { retainedSmokeArtifacts } from "./error-report.js";
import { runStandardNeoForgeSmoke as executeStandardNeoForgeSmoke } from "./matrix.js";
import {
  ABILITY_CONFORMANCE_SCENARIOS,
  type AbilityConformanceScenarioId,
} from "./scenarios/index.js";

const USAGE = "Usage: neoforge-test-gate smoke | conformance [scenario-id] | prepare-conformance";

export interface NeoForgeTestGateIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface NeoForgeTestGateDependencies {
  readonly runStandardNeoForgeSmoke: () => Promise<void>;
  readonly prepareAbilityConformanceWorktree: (
    scenarioId?: AbilityConformanceScenarioId,
  ) => Promise<PreparedAbilityConformanceWorktree>;
  readonly runAbilityConformanceMatrix: (
    prepared: PreparedAbilityConformanceWorktree,
    scenarioId?: AbilityConformanceScenarioId,
  ) => Promise<void>;
}

export async function runCli(
  arguments_: readonly string[] = process.argv.slice(2),
  io: NeoForgeTestGateIo = processIo,
  dependencies: NeoForgeTestGateDependencies = defaultDependencies,
): Promise<number> {
  try {
    const command = arguments_[0];
    if (command === "smoke") {
      if (arguments_.length !== 1) throw new Error(USAGE);
      await dependencies.runStandardNeoForgeSmoke();
      emit(io, { event: "standard_neoforge_smoke_passed" });
      return 0;
    }
    if (command === "prepare-conformance") {
      if (arguments_.length !== 1) throw new Error(USAGE);
      const prepared = await dependencies.prepareAbilityConformanceWorktree();
      assertPreparedScenarios(prepared, scenarioIds());
      emit(io, {
        event: "ability_conformance_templates_ready",
        scenario_count: ABILITY_CONFORMANCE_SCENARIOS.length,
      });
      return 0;
    }
    if (command !== "conformance" || arguments_.length > 2) throw new Error(USAGE);

    const scenario = resolveScenario(arguments_[1]);
    if (scenario === undefined) {
      await dependencies.runStandardNeoForgeSmoke();
      emit(io, { event: "standard_neoforge_smoke_passed" });
      const prepared = await dependencies.prepareAbilityConformanceWorktree();
      assertPreparedScenarios(prepared, scenarioIds());
      emit(io, {
        event: "ability_conformance_templates_ready",
        scenario_count: ABILITY_CONFORMANCE_SCENARIOS.length,
      });
      await dependencies.runAbilityConformanceMatrix(prepared);
      emit(io, {
        event: "ability_conformance_passed",
        scenario_count: ABILITY_CONFORMANCE_SCENARIOS.length,
      });
      return 0;
    }

    const prepared = await dependencies.prepareAbilityConformanceWorktree(scenario);
    assertPreparedScenarios(prepared, [scenario]);
    emit(io, {
      event: "ability_conformance_templates_ready",
      scenario,
      scenario_count: 1,
    });
    await dependencies.runAbilityConformanceMatrix(prepared, scenario);
    emit(io, { event: "ability_conformance_targeted_passed", scenario });
    return 0;
  } catch (error) {
    reportFailure(io, error);
    return 1;
  }
}

function resolveScenario(argument: string | undefined): AbilityConformanceScenarioId | undefined {
  if (argument === undefined) return undefined;
  const scenario = ABILITY_CONFORMANCE_SCENARIOS.find(({ id }) => id === argument)?.id;
  if (scenario === undefined) throw new Error(`Unknown Ability Conformance scenario ${argument}`);
  return scenario;
}

function scenarioIds(): readonly AbilityConformanceScenarioId[] {
  return ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) => id);
}

function assertPreparedScenarios(
  prepared: PreparedAbilityConformanceWorktree,
  expected: readonly AbilityConformanceScenarioId[],
): void {
  const actual = prepared.templates.map(({ scenario }) => scenario);
  if (actual.length !== expected.length || actual.some((scenario, index) => scenario !== expected[index])) {
    throw new Error(`Ability Conformance preparation was incomplete: expected ${expected.join(",")}; received ${actual.join(",")}`);
  }
}

function emit(io: NeoForgeTestGateIo, value: Readonly<Record<string, unknown>>): void {
  io.stdout(JSON.stringify(value));
}

function reportFailure(io: NeoForgeTestGateIo, error: unknown): void {
  const value = error instanceof Error ? error : new Error("NeoForge test gate failed");
  io.stderr(`${value.name}: ${value.message}`);
  for (const retained of retainedSmokeArtifacts(value)) {
    io.stderr(JSON.stringify({
      retained_run: retained.runDirectory,
      ...(retained.artifactsDirectory === undefined ? {} : {
        retained_artifacts: retained.artifactsDirectory,
      }),
    }));
  }
}

const processIo: NeoForgeTestGateIo = {
  stdout: (line) => { process.stdout.write(`${line}\n`); },
  stderr: (line) => { process.stderr.write(`${line}\n`); },
};

const defaultDependencies: NeoForgeTestGateDependencies = {
  runStandardNeoForgeSmoke: executeStandardNeoForgeSmoke,
  prepareAbilityConformanceWorktree: async (scenarioId) =>
    await executeAbilityConformancePreparation(undefined, scenarioId),
  runAbilityConformanceMatrix: executeAbilityConformanceMatrix,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runCli();
}
