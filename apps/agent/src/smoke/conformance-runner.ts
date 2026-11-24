import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  ABILITY_CONFORMANCE_FORBIDDEN_PATHS,
  abilityConformanceSpecificationPath,
  computeCacheKey,
  createFreshScenarioRun,
  loadAbilityConformanceWorldSpecification,
  sealScenarioTemplate,
  validateScenarioTemplate,
  type AbilityConformanceWorldSpecification,
  type AbilityConformanceManifest,
  type PreparedScenarioTemplate,
  type TemplateInputs,
} from "./conformance-world.js";
import {
  ABILITY_CONFORMANCE_SCENARIOS,
  type AbilityConformanceScenarioId,
} from "./scenarios/index.js";

export async function prepareAbilityConformanceTemplates(input: Readonly<{
  cacheRoot: string;
  versions: TemplateInputs;
  scenarios?: readonly AbilityConformanceScenarioId[];
  generate: (
    scenario: AbilityConformanceWorldSpecification,
    gameDirectory: string,
  ) => Promise<void>;
}>): Promise<readonly PreparedScenarioTemplate[]> {
  const selected = input.scenarios === undefined
    ? ABILITY_CONFORMANCE_SCENARIOS
    : ABILITY_CONFORMANCE_SCENARIOS.filter(({ id }) => input.scenarios!.includes(id));
  const expectedCacheKeys = new Map(selected.map((registration) => {
    const specification = loadAbilityConformanceWorldSpecification(
      abilityConformanceSpecificationPath(registration.id), registration.id,
    );
    return [registration.id, computeCacheKey(input.versions, specification)] as const;
  }));
  const templatesRoot = join(input.cacheRoot, "templates");
  const stagingRoot = join(input.cacheRoot, "staging");
  await mkdir(templatesRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const prepared = new Array<PreparedScenarioTemplate | undefined>(selected.length);

  for (const [index, registration] of selected.entries()) {
    const scenario = loadAbilityConformanceWorldSpecification(
      abilityConformanceSpecificationPath(registration.id), registration.id,
    );
    const directory = join(templatesRoot, scenario.id);
    try {
      const manifest = await validateScenarioTemplate(
        directory, expectedCacheKeys.get(scenario.id)!, scenario,
      );
      prepared[index] = { scenario: scenario.id, directory, manifest };
      continue;
    } catch {
      // A missing, dirty, or stale template is rebuilt from the versioned fixture source.
    }
    await rm(directory, { recursive: true, force: true });
    const staging = join(stagingRoot, `${scenario.id}-${randomUUID()}`);
    try {
      await input.generate(scenario, staging);
      await sanitizeGeneratedWorld(join(staging, "world"));
      await mkdir(directory);
      await cp(join(staging, "world"), join(directory, "world"), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      const manifest = await sealScenarioTemplate(directory, scenario.id, input.versions, scenario);
      prepared[index] = { scenario: scenario.id, directory, manifest };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  if (prepared.includes(undefined)) {
    throw new Error("Ability Conformance template preparation did not complete");
  }
  return prepared as readonly PreparedScenarioTemplate[];
}

export async function runWithFreshScenarioWorld(input: Readonly<{
  scenario: AbilityConformanceScenarioId;
  cacheRoot: string;
  runsRoot: string;
  versions: TemplateInputs;
  runId: string;
  preparedTemplate?: PreparedScenarioTemplate;
  execute: (context: Readonly<{
    runDirectory: string;
    serverDirectory: string;
    artifactsDirectory: string;
    manifest: AbilityConformanceManifest;
  }>) => Promise<void>;
}>): Promise<Readonly<{ retained: false; runDirectory: string }>> {
  const templateDirectory = join(input.cacheRoot, "templates", input.scenario);
  const registration = ABILITY_CONFORMANCE_SCENARIOS.find(({ id }) => id === input.scenario);
  if (registration === undefined) throw new Error(`Unknown Ability Conformance Scenario: ${input.scenario}`);
  const specification = loadAbilityConformanceWorldSpecification(
    abilityConformanceSpecificationPath(input.scenario), input.scenario,
  );
  const expectedCacheKey = computeCacheKey(input.versions, specification);
  const run = await createFreshScenarioRun({
    scenario: input.scenario,
    templateDirectory,
    runsRoot: input.runsRoot,
    runId: input.runId,
    expectedCacheKey,
    specification,
    ...(input.preparedTemplate === undefined ? {} : { preparedTemplate: input.preparedTemplate }),
  });
  const artifactsDirectory = join(run.runDirectory, "artifacts");
  try {
    await input.execute({ ...run, artifactsDirectory });
    await rm(run.runDirectory, { recursive: true });
    return { retained: false, runDirectory: run.runDirectory };
  } catch (error) {
    throw new ScenarioRunError(
      errorMessage(error),
      run.runDirectory,
      artifactsDirectory,
      { cause: error },
    );
  }
}

export class ScenarioRunError extends Error {
  public constructor(
    message: string,
    public readonly retainedRunDirectory: string,
    public readonly retainedArtifactsDirectory: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScenarioRunError";
  }
}

async function sanitizeGeneratedWorld(world: string): Promise<void> {
  for (const path of ABILITY_CONFORMANCE_FORBIDDEN_PATHS) {
    await rm(join(world, path), { recursive: true, force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ability Conformance Scenario failed";
}
