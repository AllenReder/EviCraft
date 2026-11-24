import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFreshScenarioRun,
  abilityConformanceSpecificationPath,
  loadAbilityConformanceWorldSpecification,
  sealScenarioTemplate,
  validateScenarioTemplate,
} from "../src/smoke/conformance-world.js";
import { ABILITY_CONFORMANCE_SCENARIOS } from "../src/smoke/scenarios/index.js";

const versions = {
  minecraftVersion: "1.21.1",
  neoForgeVersion: "21.1.233",
  modArtifactSha256: "a".repeat(64),
  fixtureSourceSha256: "f".repeat(64),
} as const;

describe("Ability Conformance worlds", () => {
  it("keeps the surface regression byte-identical to the captured real forest", async () => {
    const [captured, fixture] = await Promise.all([
      readFile(new URL(
        "../../../runtime/core/neoforge/gameteststructures/real_spruce_forest.snbt",
        import.meta.url,
      )),
      readFile(new URL(
        "../fixtures/ability-conformance/world-fixtures/captured-spruce-forest/v1/structure.snbt",
        import.meta.url,
      )),
    ]);
    expect(fixture).toEqual(captured);
  });

  it("loads one strict World Specification per registered Scenario", () => {
    expect(ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) => id)).toEqual([
      "interaction-and-collection",
      "furnace-processing",
      "sleeping-and-scaffold-policy",
      "combat-and-target-elimination",
      "food-consumption-and-recovery",
      "explore-and-return-surface",
      "explore-and-return-branching-cave",
      "suffocation-escape",
      "placement-approach-and-retry",
      "stale-target-recovery",
      "limited-scaffold-bridge",
      "tunnel-frontier-early-stop",
      "tunnel-bounded-not-found",
      "visible-ring-and-return",
      "drop-observe-and-recollect",
      "staircase-descent-and-return",
      "underwater-surface-column",
      "exact-target-combat-interference",
      "multi-room-furnace-workflow",
      "cross-dimension-task-switch",
      "chunk-tracking-reacquisition",
    ]);
    const specifications = ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) =>
      loadAbilityConformanceWorldSpecification(abilityConformanceSpecificationPath(id), id));
    expect(specifications.map(({ id }) => id)).toEqual(
      ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) => id));
    expect(specifications.filter(({ difficulty }) => difficulty === "normal")).toHaveLength(3);
    expect(specifications.filter(({ difficulty }) => difficulty === "peaceful")).toHaveLength(18);
    expect(specifications.filter(({ sharedSpawn }) =>
      sharedSpawn.x === 0 && sharedSpawn.y === 101 && sharedSpawn.z === 0)).toHaveLength(20);
    expect(specifications.find(({ id }) => id === "limited-scaffold-bridge")?.sharedSpawn)
      .toEqual({ x: 0, y: 100, z: 0 });
    expect(specifications[0]?.fixtures).toMatchObject({
      storage: {
        blockId: "minecraft:chest",
        position: { x: 4, y: 104, z: 4 },
        initiallyVisible: false,
      },
      collection_target_one: {
        blockId: "minecraft:diamond_ore", position: { x: -2, y: 101, z: -2 },
      },
      collection_target_two: {
        blockId: "minecraft:diamond_ore", position: { x: -3, y: 101, z: -2 },
      },
    });
    expect(specifications[1]?.fixtures).toMatchObject({
      storage: {
        blockId: "minecraft:chest", position: { x: 3, y: 102, z: 2 },
        initiallyVisible: false,
      },
      furnace: {
        blockId: "minecraft:furnace", position: { x: 3, y: 101, z: -2 },
        initiallyVisible: false,
      },
    });
    expect(specifications[1]?.fixtures.storage?.contents)
      .toContainEqual({ slot: 1, itemId: "minecraft:coal", count: 2 });
    expect(specifications[2]?.fixtures).toMatchObject({
      bed_foot: { blockId: "minecraft:red_bed", position: { x: 2, y: 101, z: 0 } },
      bed_head: { blockId: "minecraft:red_bed", position: { x: 3, y: 101, z: 0 } },
      nether_bed_foot: {
        blockId: "minecraft:red_bed",
        dimension: "minecraft:the_nether",
        position: { x: 0, y: 101, z: 0 },
        initiallyVisible: false,
      },
      nether_bed_head: {
        blockId: "minecraft:red_bed",
        dimension: "minecraft:the_nether",
        position: { x: 1, y: 101, z: 0 },
        initiallyVisible: false,
      },
    });
    expect(specifications[3]?.combat).toEqual({
      zombiePosition: { x: 2, y: 101, z: 0 },
    });
    expect(specifications.find(({ id }) => id === "exact-target-combat-interference")?.combat)
      .toEqual({
        zombiePosition: { x: 2, y: 101, z: 0 },
        distractorZombiePosition: { x: 2, y: 101, z: 2 },
      });
    expect(specifications[4]).toMatchObject({
      structureFixture: {
        id: "hidden-marker-probe",
        version: 1,
        origin: { x: 32, y: 100, z: 32 },
      },
      hiddenMarkers: {
        sealed_probe: { x: 33, y: 101, z: 33 },
      },
    });
    expect(specifications[5]).toMatchObject({
      structureFixture: {
        id: "captured-spruce-forest",
        version: 1,
        origin: { x: -6, y: 94, z: -12 },
      },
      hiddenMarkers: {
        surface_marker: { x: -6, y: 101, z: 4 },
      },
      fixtures: {
        hidden_marker: { blockId: "minecraft:emerald_block", initiallyVisible: false },
        forest_trunk_one_lower: { blockId: "minecraft:spruce_log", position: { x: 1, y: 101, z: 2 } },
        forest_trunk_two_upper: { blockId: "minecraft:spruce_log", position: { x: -3, y: 103, z: -3 } },
        marker_support: { blockId: "minecraft:podzol", position: { x: -6, y: 100, z: 4 } },
      },
    });
    expect(specifications[6]).toMatchObject({
      structureFixture: { id: "explore-branching-cave", version: 1 },
      hiddenMarkers: { cave_marker: { x: 5, y: 102, z: 4 } },
      fixtures: {
        dead_end_wall: { blockId: "minecraft:stone", position: { x: 0, y: 101, z: -4 } },
        branch_rise: { blockId: "minecraft:stone", position: { x: 3, y: 102, z: -2 } },
      },
    });
    expect(specifications[7]?.fixtures).toEqual({});
  });

  it("rejects fields and fixture state that the generator does not implement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-specification-"));
    const path = join(root, "invalid.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      id: "invalid",
      difficulty: "peaceful",
      sharedSpawn: { x: 0, y: 101, z: 0 },
      fixtures: {
        stone: {
          blockId: "minecraft:stone",
          position: { x: 1, y: 101, z: 0 },
          state: { facing: "north" },
        },
      },
    }));
    expect(() => loadAbilityConformanceWorldSpecification(path, "invalid"))
      .toThrow(/state is supported only for bed fixtures/u);
  });

  it("rejects hidden markers outside their versioned structure fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-structure-fixture-"));
    const specificationPath = join(root, "scenario.json");
    await mkdir(join(root, "world-fixtures", "invalid", "v1"), { recursive: true });
    await writeFile(specificationPath, JSON.stringify({
      schemaVersion: 1,
      id: "invalid",
      difficulty: "peaceful",
      sharedSpawn: { x: 0, y: 101, z: 0 },
      structureFixture: {
        id: "invalid",
        version: 1,
        origin: { x: 0, y: 100, z: 0 },
      },
      fixtures: {},
    }));
    await writeFile(join(root, "world-fixtures", "invalid", "v1", "fixture.json"), JSON.stringify({
      schemaVersion: 1,
      structure: "structure.snbt",
      size: { x: 2, y: 2, z: 2 },
      hiddenMarkers: { outside: { x: 2, y: 1, z: 1 } },
    }));
    await writeFile(join(root, "world-fixtures", "invalid", "v1", "structure.snbt"), "fixture");

    expect(() => loadAbilityConformanceWorldSpecification(specificationPath, "invalid"))
      .toThrow(/hidden marker outside is outside structure fixture bounds/u);
  });

  it("seals the generated world tree and rejects content drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-world-"));
    const template = join(root, "template");
    await writeGeneratedWorld(template, "interaction-and-collection");
    const specification = specificationFor("interaction-and-collection");

    const sealed = await sealScenarioTemplate(
      template,
      "interaction-and-collection",
      versions,
      specification,
    );

    await expect(validateScenarioTemplate(template, sealed.cacheKey, specification)).resolves.toMatchObject({
      scenario: "interaction-and-collection",
      sharedSpawn: { x: 0, y: 101, z: 0 },
      hiddenMarkers: {},
    });
    await writeFile(join(template, "world", "region", "r.0.0.mca"), "mutated");
    await expect(validateScenarioTemplate(template, sealed.cacheKey, specification)).rejects.toThrow(
      "template content digest",
    );
  });

  it("creates one unique mutable copy without changing the sealed template", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-world-"));
    const template = join(root, "template");
    const runsRoot = join(root, "runs");
    await writeGeneratedWorld(template, "furnace-processing");
    const specification = specificationFor("furnace-processing");
    const sealed = await sealScenarioTemplate(
      template, "furnace-processing", versions, specification,
    );

    const run = await createFreshScenarioRun({
      scenario: "furnace-processing",
      templateDirectory: template,
      runsRoot,
      runId: "furnace-run-001",
      expectedCacheKey: sealed.cacheKey,
      specification,
    });

    await writeFile(join(run.serverDirectory, "world", "region", "r.0.0.mca"), "run mutation");
    expect(await readFile(join(run.serverDirectory, "server.properties"), "utf8"))
      .toContain("spawn-radius=0\n");
    expect(await readFile(join(template, "world", "region", "r.0.0.mca"), "utf8"))
      .toBe("generated world");
    await expect(createFreshScenarioRun({
      scenario: "furnace-processing",
      templateDirectory: template,
      runsRoot,
      runId: "furnace-run-001",
      expectedCacheKey: sealed.cacheKey,
      specification,
    })).rejects.toThrow("already exists");
  });
});

async function writeGeneratedWorld(
  template: string,
  scenario: "interaction-and-collection" | "furnace-processing",
): Promise<void> {
  const definition = specificationFor(scenario);
  await mkdir(join(template, "world", "region"), { recursive: true });
  await writeFile(join(template, "world", "region", "r.0.0.mca"), "generated world");
  await writeFile(join(template, "world", ".ability-conformance-generated.json"), `${JSON.stringify({
    schemaVersion: 1,
    scenario,
    difficulty: definition.difficulty,
    sharedSpawn: definition.sharedSpawn,
    fixtures: definition.fixtures,
    hiddenMarkers: definition.hiddenMarkers,
  })}\n`);
}

function specificationFor(
  scenario: "interaction-and-collection" | "furnace-processing",
) {
  const registered = ABILITY_CONFORMANCE_SCENARIOS.find(({ id }) => id === scenario)!;
  return loadAbilityConformanceWorldSpecification(
    abilityConformanceSpecificationPath(registered.id), scenario,
  );
}
