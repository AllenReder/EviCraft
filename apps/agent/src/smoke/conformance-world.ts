import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AbilityConformanceScenarioId } from "./scenarios/index.js";

export interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface FixtureDefinition {
  readonly blockId: string;
  readonly dimension?: "minecraft:overworld" | "minecraft:the_nether";
  readonly position: BlockPosition;
  readonly state?: Readonly<{ part: "foot" | "head"; facing: "north" | "south" | "east" | "west" }>;
  readonly contents?: readonly Readonly<{
    slot: number;
    itemId: string;
    count: number;
  }>[];
  readonly initiallyVisible?: boolean;
}

export interface CombatScenarioSetup {
  readonly zombiePosition: BlockPosition;
  readonly distractorZombiePosition?: BlockPosition;
}

export interface StructureFixtureReference {
  readonly id: string;
  readonly version: number;
  readonly origin: BlockPosition;
}

export interface AbilityConformanceWorldSpecification {
  readonly schemaVersion: 1;
  readonly id: AbilityConformanceScenarioId;
  readonly difficulty: "peaceful" | "easy" | "normal" | "hard";
  readonly sharedSpawn: BlockPosition;
  readonly fixtures: Readonly<Record<string, FixtureDefinition>>;
  readonly structureFixture?: StructureFixtureReference;
  readonly hiddenMarkers: Readonly<Record<string, BlockPosition>>;
  readonly combat?: CombatScenarioSetup;
}

export function abilityConformanceSpecificationPath(id: string): string {
  return fileURLToPath(new URL(
    `../../fixtures/ability-conformance/${id}.json`,
    import.meta.url,
  ));
}

export interface TemplateInputs {
  readonly minecraftVersion: string;
  readonly neoForgeVersion: string;
  readonly modArtifactSha256: string;
  readonly fixtureSourceSha256: string;
}

export interface AbilityConformanceManifest {
  readonly schemaVersion: 1;
  readonly scenario: AbilityConformanceScenarioId;
  readonly difficulty: AbilityConformanceWorldSpecification["difficulty"];
  readonly sharedSpawn: BlockPosition;
  readonly fixtures: AbilityConformanceWorldSpecification["fixtures"];
  readonly structureFixture?: StructureFixtureReference;
  readonly hiddenMarkers: AbilityConformanceWorldSpecification["hiddenMarkers"];
  readonly combat?: CombatScenarioSetup;
  readonly cacheKey: string;
  readonly contentSha256: string;
}

/** A template already validated and sealed by preparation. */
export interface PreparedScenarioTemplate {
  readonly scenario: AbilityConformanceScenarioId;
  readonly directory: string;
  readonly manifest: AbilityConformanceManifest;
}
const GENERATED_FILE = ".ability-conformance-generated.json";
const SEAL_FILE = ".ability-conformance-seal.json";
export const ABILITY_CONFORMANCE_FORBIDDEN_PATHS = Object.freeze([
  "session.lock",
  "playerdata",
  "stats",
  "advancements",
  "artifacts",
] as const);

export async function sealScenarioTemplate(
  templateDirectory: string,
  scenarioId: AbilityConformanceScenarioId,
  inputs: TemplateInputs,
  specification: AbilityConformanceWorldSpecification,
): Promise<AbilityConformanceManifest> {
  validateTemplateInputs(inputs);
  const generated = await readGeneratedManifest(templateDirectory);
  validateGeneratedManifest(generated, specification);
  await rejectDirtyWorld(templateDirectory);
  const cacheKey = computeCacheKey(inputs, specification);
  const contentSha256 = await digestTree(join(templateDirectory, "world"));
  const manifest: AbilityConformanceManifest = Object.freeze({
    schemaVersion: 1,
    scenario: generated.scenario,
    difficulty: generated.difficulty,
    sharedSpawn: generated.sharedSpawn,
    fixtures: generated.fixtures,
    ...(generated.structureFixture === undefined ? {} : {
      structureFixture: generated.structureFixture,
    }),
    hiddenMarkers: generated.hiddenMarkers,
    ...(generated.combat === undefined ? {} : { combat: generated.combat }),
    cacheKey,
    contentSha256,
  });
  await writeFile(join(templateDirectory, SEAL_FILE), `${JSON.stringify(manifest)}\n`, { flag: "wx" });
  return manifest;
}

export async function validateScenarioTemplate(
  templateDirectory: string,
  expectedCacheKey: string,
  specification: AbilityConformanceWorldSpecification,
): Promise<AbilityConformanceManifest> {
  const manifest = parseManifest(await readFile(join(templateDirectory, SEAL_FILE), "utf8"));
  validateGeneratedManifest(manifest, specification);
  if (manifest.cacheKey !== expectedCacheKey) {
    throw new Error("Ability Conformance template cache key is stale");
  }
  await rejectDirtyWorld(templateDirectory);
  const digest = await digestTree(join(templateDirectory, "world"));
  if (digest !== manifest.contentSha256) {
    throw new Error("Ability Conformance template content digest does not match its seal");
  }
  return manifest;
}

function validatePreparedTemplate(
  prepared: PreparedScenarioTemplate,
  scenario: AbilityConformanceScenarioId,
  templateDirectory: string,
  expectedCacheKey: string,
): AbilityConformanceManifest {
  if (prepared.scenario !== scenario || prepared.directory !== templateDirectory) {
    throw new Error("Prepared Ability Conformance template does not match the requested scenario");
  }
  if (prepared.manifest.scenario !== scenario || prepared.manifest.cacheKey !== expectedCacheKey) {
    throw new Error("Prepared Ability Conformance template is stale");
  }
  return prepared.manifest;
}

export async function createFreshScenarioRun(input: Readonly<{
  scenario: AbilityConformanceScenarioId;
  templateDirectory: string;
  runsRoot: string;
  runId: string;
  expectedCacheKey: string;
  specification: AbilityConformanceWorldSpecification;
  preparedTemplate?: PreparedScenarioTemplate;
}>): Promise<Readonly<{
  runDirectory: string;
  serverDirectory: string;
  manifest: AbilityConformanceManifest;
}>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(input.runId)) {
    throw new Error("Smoke run id is invalid");
  }
  const manifest = input.preparedTemplate === undefined
    ? await validateScenarioTemplate(input.templateDirectory, input.expectedCacheKey, input.specification)
    : validatePreparedTemplate(input.preparedTemplate, input.scenario, input.templateDirectory, input.expectedCacheKey);
  if (manifest.scenario !== input.scenario) {
    throw new Error("Ability Conformance Scenario does not match its template");
  }
  const runsRoot = resolve(input.runsRoot);
  const runDirectory = resolve(runsRoot, input.runId);
  if (runDirectory === runsRoot || !runDirectory.startsWith(`${runsRoot}${sep}`)) {
    throw new Error("Smoke run escapes runs root");
  }
  await mkdir(runsRoot, { recursive: true });
  await mkdir(runDirectory).catch((error: unknown) => {
    if (isCode(error, "EEXIST")) throw new Error(`Smoke run already exists: ${runDirectory}`);
    throw error;
  });
  const serverDirectory = join(runDirectory, "server");
  await mkdir(serverDirectory);
  await cp(join(input.templateDirectory, "world"), join(serverDirectory, "world"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(join(serverDirectory, "eula.txt"), "eula=true\n", { flag: "wx" });
  await writeFile(join(serverDirectory, "server.properties"), [
    "allow-flight=true",
    `difficulty=${manifest.difficulty}`,
    "enable-command-block=false",
    "gamemode=survival",
    "generate-structures=false",
    "level-name=world",
    "max-players=4",
    "motd=EviCraft Ability Conformance",
    "online-mode=false",
    "server-ip=127.0.0.1",
    "spawn-monsters=false",
    "spawn-radius=0",
  ].join("\n") + "\n", { flag: "wx" });
  return { runDirectory, serverDirectory, manifest };
}

export function computeCacheKey(
  inputs: TemplateInputs,
  specification: AbilityConformanceWorldSpecification,
): string {
  validateTemplateInputs(inputs);
  return createHash("sha256").update(JSON.stringify({
    minecraft: inputs.minecraftVersion,
    neoforge: inputs.neoForgeVersion,
    mod: inputs.modArtifactSha256,
    fixture: inputs.fixtureSourceSha256,
    specification,
  })).digest("hex");
}

export function loadAbilityConformanceWorldSpecification(
  path: string,
  expectedId: string,
): AbilityConformanceWorldSpecification {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const root = exactRecord(value,
    ["schemaVersion", "id", "difficulty", "sharedSpawn", "fixtures", "structureFixture", "combat"],
    "World Specification");
  if (root.schemaVersion !== 1) throw new Error("World Specification schemaVersion must be 1");
  if (root.id !== expectedId) throw new Error(`World Specification id must be ${expectedId}`);
  if (root.difficulty !== "peaceful" && root.difficulty !== "easy"
      && root.difficulty !== "normal" && root.difficulty !== "hard") {
    throw new Error("World Specification difficulty is invalid");
  }
  const fixtures = exactRecord(root.fixtures, Object.keys(record(root.fixtures)), "fixtures");
  const structureFixture = root.structureFixture === undefined
    ? undefined
    : loadStructureFixture(root.structureFixture, dirname(path));
  const combat = root.combat === undefined ? undefined : combatSetup(root.combat);
  const combatScenario = expectedId === "combat-and-target-elimination"
    || expectedId === "exact-target-combat-interference";
  if (combatScenario && combat === undefined) {
    throw new Error(`${expectedId} requires combat setup`);
  }
  if (!combatScenario && combat !== undefined) {
    throw new Error(`World Specification ${expectedId} cannot contain combat setup`);
  }
  return Object.freeze({
    schemaVersion: 1,
    id: expectedId as AbilityConformanceScenarioId,
    difficulty: root.difficulty,
    sharedSpawn: position(root.sharedSpawn, "sharedSpawn"),
    fixtures: Object.freeze(Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [
      name, fixtureDefinition(fixture, name),
    ]))),
    ...(structureFixture === undefined ? {} : { structureFixture: structureFixture.reference }),
    hiddenMarkers: structureFixture?.hiddenMarkers ?? Object.freeze({}),
    ...(combat === undefined ? {} : { combat }),
  });
}

function loadStructureFixture(
  value: unknown,
  specificationDirectory: string,
): Readonly<{
  reference: StructureFixtureReference;
  hiddenMarkers: Readonly<Record<string, BlockPosition>>;
}> {
  const selected = exactRecord(value, ["id", "version", "origin"], "structureFixture");
  if (typeof selected.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(selected.id)) {
    throw new Error("structureFixture.id is invalid");
  }
  if (!Number.isSafeInteger(selected.version) || Number(selected.version) < 1) {
    throw new Error("structureFixture.version must be a positive integer");
  }
  const reference = Object.freeze({
    id: selected.id,
    version: Number(selected.version),
    origin: position(selected.origin, "structureFixture.origin"),
  });
  const fixtureDirectory = join(
    specificationDirectory, "world-fixtures", reference.id, `v${reference.version}`,
  );
  const bundleValue: unknown = JSON.parse(readFileSync(join(fixtureDirectory, "fixture.json"), "utf8"));
  const bundle = exactRecord(
    bundleValue, ["schemaVersion", "structure", "size", "hiddenMarkers"], "structure fixture bundle",
  );
  if (bundle.schemaVersion !== 1) throw new Error("structure fixture bundle schemaVersion must be 1");
  if (bundle.structure !== "structure.snbt") {
    throw new Error("structure fixture bundle structure must be structure.snbt");
  }
  if (readFileSync(join(fixtureDirectory, bundle.structure), "utf8").trim() === "") {
    throw new Error("structure fixture source must not be empty");
  }
  const size = positiveSize(bundle.size);
  const markers = exactRecord(
    bundle.hiddenMarkers, Object.keys(record(bundle.hiddenMarkers)), "hiddenMarkers",
  );
  const hiddenMarkers = Object.freeze(Object.fromEntries(Object.entries(markers).map(([name, marker]) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(name)) {
      throw new Error(`hidden marker name is invalid: ${name}`);
    }
    const relativePosition = position(marker, `hidden marker ${name}`);
    if (relativePosition.x < 0 || relativePosition.x >= size.x
        || relativePosition.y < 0 || relativePosition.y >= size.y
        || relativePosition.z < 0 || relativePosition.z >= size.z) {
      throw new Error(`hidden marker ${name} is outside structure fixture bounds`);
    }
    return [name, Object.freeze({
      x: reference.origin.x + relativePosition.x,
      y: reference.origin.y + relativePosition.y,
      z: reference.origin.z + relativePosition.z,
    })];
  })));
  return Object.freeze({ reference, hiddenMarkers });
}

function positiveSize(value: unknown): BlockPosition {
  const selected = position(value, "structure fixture size");
  if (selected.x < 1 || selected.y < 1 || selected.z < 1) {
    throw new Error("structure fixture size must contain positive dimensions");
  }
  return selected;
}

function combatSetup(value: unknown): CombatScenarioSetup {
  const setup = exactRecord(value,
    ["zombiePosition", "distractorZombiePosition"], "combat setup");
  return Object.freeze({
    zombiePosition: position(setup.zombiePosition, "combat setup zombiePosition"),
    ...(setup.distractorZombiePosition === undefined ? {} : {
      distractorZombiePosition: position(
        setup.distractorZombiePosition, "combat setup distractorZombiePosition",
      ),
    }),
  });
}

function fixtureDefinition(value: unknown, name: string): FixtureDefinition {
  const fixture = exactRecord(value,
    ["blockId", "dimension", "position", "state", "contents", "initiallyVisible"], `fixture ${name}`);
  if (typeof fixture.blockId !== "string" || fixture.blockId.trim() === "") {
    throw new Error(`fixture ${name}.blockId must be a non-blank string`);
  }
  if (fixture.dimension !== undefined && fixture.dimension !== "minecraft:overworld"
      && fixture.dimension !== "minecraft:the_nether") {
    throw new Error(`fixture ${name}.dimension is invalid`);
  }
  let state: FixtureDefinition["state"];
  if (fixture.state !== undefined) {
    if (fixture.blockId !== "minecraft:red_bed") {
      throw new Error(`fixture ${name}.state is supported only for bed fixtures`);
    }
    const values = exactRecord(fixture.state, ["part", "facing"], `fixture ${name}.state`);
    if ((values.part !== "foot" && values.part !== "head")
        || (values.facing !== "north" && values.facing !== "south"
          && values.facing !== "east" && values.facing !== "west")) {
      throw new Error(`fixture ${name}.state is invalid`);
    }
    state = { part: values.part, facing: values.facing };
  }
  let contents: FixtureDefinition["contents"];
  if (fixture.contents !== undefined) {
    if (!Array.isArray(fixture.contents)) throw new Error(`fixture ${name}.contents must be an array`);
    contents = fixture.contents.map((entry, index) => {
      const item = exactRecord(entry, ["slot", "itemId", "count"], `fixture ${name}.contents[${index}]`);
      if (!Number.isSafeInteger(item.slot) || Number(item.slot) < 0
          || typeof item.itemId !== "string" || item.itemId.trim() === ""
          || !Number.isSafeInteger(item.count) || Number(item.count) < 1) {
        throw new Error(`fixture ${name}.contents[${index}] is invalid`);
      }
      return { slot: Number(item.slot), itemId: item.itemId, count: Number(item.count) };
    });
  }
  if (fixture.initiallyVisible !== undefined && typeof fixture.initiallyVisible !== "boolean") {
    throw new Error(`fixture ${name}.initiallyVisible must be boolean`);
  }
  return Object.freeze({
    blockId: fixture.blockId,
    position: position(fixture.position, `fixture ${name}.position`),
    ...(fixture.dimension === undefined ? {} : { dimension: fixture.dimension }),
    ...(state === undefined ? {} : { state: Object.freeze(state) }),
    ...(contents === undefined ? {} : { contents: Object.freeze(contents) }),
    ...(fixture.initiallyVisible === undefined ? {} : { initiallyVisible: fixture.initiallyVisible }),
  });
}

function position(value: unknown, label: string): BlockPosition {
  const selected = exactRecord(value, ["x", "y", "z"], label);
  if (![selected.x, selected.y, selected.z].every(Number.isSafeInteger)) {
    throw new Error(`${label} coordinates must be integers`);
  }
  return Object.freeze({ x: Number(selected.x), y: Number(selected.y), z: Number(selected.z) });
}

function exactRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const selected = record(value);
  for (const key of Object.keys(selected)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown field: ${key}`);
  }
  return selected;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("World Specification must contain JSON objects");
  }
  return value as Record<string, unknown>;
}

function validateTemplateInputs(inputs: TemplateInputs): void {
  if (inputs.minecraftVersion.trim() === "" || inputs.neoForgeVersion.trim() === ""
      || !/^[a-f0-9]{64}$/u.test(inputs.modArtifactSha256)
      || !/^[a-f0-9]{64}$/u.test(inputs.fixtureSourceSha256)) {
    throw new Error("Ability Conformance template inputs are invalid");
  }
}

async function readGeneratedManifest(templateDirectory: string): Promise<AbilityConformanceManifest> {
  return parseManifest(await readFile(join(templateDirectory, "world", GENERATED_FILE), "utf8"));
}

function parseManifest(text: string): AbilityConformanceManifest {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ability Conformance manifest is invalid");
  }
  return value as AbilityConformanceManifest;
}

function validateGeneratedManifest(
  manifest: AbilityConformanceManifest,
  specification: AbilityConformanceWorldSpecification,
): void {
  if (manifest.schemaVersion !== 1 || manifest.scenario !== specification.id
      || manifest.difficulty !== specification.difficulty
      || stableJson(manifest.sharedSpawn) !== stableJson(specification.sharedSpawn)
      || stableJson(manifest.fixtures) !== stableJson(specification.fixtures)
      || stableJson(manifest.structureFixture) !== stableJson(specification.structureFixture)
      || stableJson(manifest.hiddenMarkers) !== stableJson(specification.hiddenMarkers)
      || stableJson(manifest.combat) !== stableJson(specification.combat)) {
    throw new Error("Ability Conformance generated manifest does not match its World Specification");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}


async function rejectDirtyWorld(templateDirectory: string): Promise<void> {
  const world = join(templateDirectory, "world");
  await stat(world);
  for (const path of ABILITY_CONFORMANCE_FORBIDDEN_PATHS) {
    try {
      await stat(join(world, path));
      throw new Error(`Ability Conformance template contains forbidden Runtime state: ${path}`);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(root)) {
    const path = join(root, file);
    const details = await stat(path);
    hash.update(file.replaceAll(sep, "/"));
    hash.update("\0");
    hash.update(String(details.size));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(root, path));
    else if (entry.isFile()) found.push(relative(root, path));
    else throw new Error(`Ability Conformance template contains unsupported entry: ${basename(path)}`);
  }
  return found;
}

function isCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
