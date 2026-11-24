import { describe, expect, it, vi } from "vitest";

import {
  runCli,
  type NeoForgeTestGateDependencies,
  type NeoForgeTestGateIo,
} from "../src/smoke/cli.js";
import type { PreparedAbilityConformanceWorktree } from "../src/smoke/current-worktree.js";
import {
  ABILITY_CONFORMANCE_SCENARIOS,
  type AbilityConformanceScenarioId,
} from "../src/smoke/scenarios/index.js";

const versions = {
  minecraftVersion: "1.21.1",
  neoForgeVersion: "21.1.233",
  modArtifactSha256: "a".repeat(64),
  fixtureSourceSha256: "b".repeat(64),
} as const;

describe("NeoForge test gate CLI", () => {
  it("runs only the standard smoke gate", async () => {
    const fixture = testGate();

    expect(await runCli(["smoke"], fixture.io, fixture.dependencies)).toBe(0);

    expect(fixture.calls).toEqual(["smoke"]);
    expect(fixture.stdout).toEqual([
      JSON.stringify({ event: "standard_neoforge_smoke_passed" }),
    ]);
    expect(fixture.stderr).toEqual([]);
  });

  it("runs standard smoke once before complete conformance", async () => {
    const fixture = testGate();

    expect(await runCli(["conformance"], fixture.io, fixture.dependencies)).toBe(0);

    expect(fixture.calls).toEqual(["smoke", "prepare:all", "matrix:all"]);
    expect(fixture.stdout.map(parseEvent)).toEqual([
      { event: "standard_neoforge_smoke_passed" },
      { event: "ability_conformance_templates_ready", scenario_count: scenarioIds().length },
      { event: "ability_conformance_passed", scenario_count: scenarioIds().length },
    ]);
  });

  it("prepares and runs only the targeted Scenario without standard smoke", async () => {
    const fixture = testGate();

    expect(await runCli(
      ["conformance", "multi-room-furnace-workflow"],
      fixture.io,
      fixture.dependencies,
    )).toBe(0);

    expect(fixture.calls).toEqual([
      "prepare:multi-room-furnace-workflow",
      "matrix:multi-room-furnace-workflow",
    ]);
    expect(fixture.stdout.map(parseEvent)).toEqual([
      {
        event: "ability_conformance_templates_ready",
        scenario: "multi-room-furnace-workflow",
        scenario_count: 1,
      },
      {
        event: "ability_conformance_targeted_passed",
        scenario: "multi-room-furnace-workflow",
      },
    ]);
  });

  it("prepares all templates without emitting gate pass evidence", async () => {
    const fixture = testGate();

    expect(await runCli(["prepare-conformance"], fixture.io, fixture.dependencies)).toBe(0);

    expect(fixture.calls).toEqual(["prepare:all"]);
    expect(fixture.stdout.map(parseEvent)).toEqual([
      { event: "ability_conformance_templates_ready", scenario_count: scenarioIds().length },
    ]);
  });

  it("rejects incomplete preparation before running a matrix", async () => {
    const fixture = testGate({ preparedIds: [scenarioIds()[0]!] });

    expect(await runCli(["conformance"], fixture.io, fixture.dependencies)).toBe(1);

    expect(fixture.calls).toEqual(["smoke", "prepare:all"]);
    expect(fixture.stderr.join("\n")).toContain("Ability Conformance preparation was incomplete");
    expect(fixture.stdout.map(parseEvent)).toEqual([
      { event: "standard_neoforge_smoke_passed" },
    ]);
  });

  it("rejects unknown IDs and invalid grammar before starting work", async () => {
    for (const arguments_ of [
      ["conformance", "does-not-exist"],
      ["smoke", "multi-room-furnace-workflow"],
      ["prepare-conformance", "multi-room-furnace-workflow"],
      [],
    ]) {
      const fixture = testGate();
      expect(await runCli(arguments_, fixture.io, fixture.dependencies)).toBe(1);
      expect(fixture.calls).toEqual([]);
      expect(fixture.stdout).toEqual([]);
    }
  });

  it("reports every retained absolute artifact path", async () => {
    const failure = Object.assign(new Error("scenario failed"), {
      retainedRunDirectory: "/tmp/retained-run",
      retainedArtifactsDirectory: "/tmp/retained-run/artifacts",
    });
    const fixture = testGate({ smokeFailure: failure });

    expect(await runCli(["smoke"], fixture.io, fixture.dependencies)).toBe(1);

    expect(fixture.stderr).toEqual([
      "Error: scenario failed",
      JSON.stringify({
        retained_run: "/tmp/retained-run",
        retained_artifacts: "/tmp/retained-run/artifacts",
      }),
    ]);
    expect(fixture.stdout).toEqual([]);
  });
});

function testGate(options: Readonly<{
  preparedIds?: readonly AbilityConformanceScenarioId[];
  smokeFailure?: Error;
}> = {}): Readonly<{
  io: NeoForgeTestGateIo;
  dependencies: NeoForgeTestGateDependencies;
  calls: string[];
  stdout: string[];
  stderr: string[];
}> {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    calls,
    stdout,
    stderr,
    io: {
      stdout: (line) => { stdout.push(line); },
      stderr: (line) => { stderr.push(line); },
    },
    dependencies: {
      runStandardNeoForgeSmoke: vi.fn(async () => {
        calls.push("smoke");
        if (options.smokeFailure !== undefined) throw options.smokeFailure;
      }),
      prepareAbilityConformanceWorktree: vi.fn(async (scenarioId) => {
        calls.push(`prepare:${scenarioId ?? "all"}`);
        return prepared(options.preparedIds ?? (scenarioId === undefined ? scenarioIds() : [scenarioId]));
      }),
      runAbilityConformanceMatrix: vi.fn(async (_prepared, scenarioId) => {
        calls.push(`matrix:${scenarioId ?? "all"}`);
      }),
    },
  };
}

function prepared(ids: readonly AbilityConformanceScenarioId[]): PreparedAbilityConformanceWorktree {
  return {
    versions,
    cacheRoot: "/tmp/ability-conformance-cache",
    runsRoot: "/tmp/ability-conformance-runs",
    templates: ids.map((scenario) => ({
      scenario,
      directory: `/tmp/ability-conformance-cache/templates/${scenario}`,
      manifest: {} as never,
    })),
  };
}

function scenarioIds(): readonly AbilityConformanceScenarioId[] {
  return ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) => id);
}

function parseEvent(line: string): unknown {
  return JSON.parse(line) as unknown;
}
