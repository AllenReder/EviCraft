import { describe, expect, it, vi } from "vitest";

import {
  runAbilityConformanceMatrix,
  type AbilityConformanceMatrixDependencies,
} from "../src/smoke/ability-conformance-matrix.js";
import type { PreparedAbilityConformanceWorktree } from "../src/smoke/current-worktree.js";
import { ABILITY_CONFORMANCE_SCENARIOS } from "../src/smoke/scenarios/index.js";

const prepared = {
  versions: {
    minecraftVersion: "1.21.1",
    neoForgeVersion: "21.1.233",
    modArtifactSha256: "a".repeat(64),
    fixtureSourceSha256: "b".repeat(64),
  },
  cacheRoot: "/tmp/ability-conformance-cache",
  runsRoot: "/tmp/ability-conformance-runs",
  templates: [],
} satisfies PreparedAbilityConformanceWorktree;

describe("Ability Conformance matrix", () => {
  it("runs fixture lifecycle and every registered Scenario once in order", async () => {
    const calls: string[] = [];

    await runAbilityConformanceMatrix(prepared, undefined, dependencies(calls));

    expect(calls).toEqual([
      "fixture-lifecycle",
      ...ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) => `scenario:${id}`),
    ]);
  });

  it("runs only the selected Scenario in targeted mode", async () => {
    const calls: string[] = [];

    await runAbilityConformanceMatrix(
      prepared,
      "multi-room-furnace-workflow",
      dependencies(calls),
    );

    expect(calls).toEqual(["scenario:multi-room-furnace-workflow"]);
  });

  it("rejects an unknown Scenario without running lifecycle work", async () => {
    const calls: string[] = [];

    await expect(runAbilityConformanceMatrix(
      prepared,
      "does-not-exist" as never,
      dependencies(calls),
    )).rejects.toThrow("Unknown Ability Conformance scenario does-not-exist");
    expect(calls).toEqual([]);
  });
});

function dependencies(calls: string[]): AbilityConformanceMatrixDependencies {
  return {
    runFixtureLifecycle: vi.fn(async () => { calls.push("fixture-lifecycle"); }),
    runScenario: vi.fn(async (_prepared, scenario) => { calls.push(`scenario:${scenario.id}`); }),
  };
}
