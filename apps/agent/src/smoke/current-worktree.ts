import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { RuntimeClient } from "@evicraft/runtime-sdk";

import { abilityConformanceSpecificationPath, type PreparedScenarioTemplate, type TemplateInputs } from "./conformance-world.js";
import { prepareAbilityConformanceTemplates } from "./conformance-runner.js";
import { reservePorts } from "./neoforge-server-process.js";
import { ABILITY_CONFORMANCE_SCENARIOS, type AbilityConformanceScenarioId } from "./scenarios/index.js";

export interface PreparedAbilityConformanceWorktree {
  readonly versions: TemplateInputs;
  readonly cacheRoot: string;
  readonly runsRoot: string;
  readonly templates: readonly PreparedScenarioTemplate[];
}

export const REPOSITORY_ROOT = resolve(process.cwd());
export const RUNTIME_ROOT = join(REPOSITORY_ROOT, "runtime");
export const DEFAULT_CONFORMANCE_CACHE = join(REPOSITORY_ROOT, "build", "ability-conformance");
export const DEFAULT_CONFORMANCE_RUNS = join(REPOSITORY_ROOT, "build", "ability-conformance-runs");

export async function prepareAbilityConformanceWorktree(
  cacheRoot = DEFAULT_CONFORMANCE_CACHE,
  scenarioId?: AbilityConformanceScenarioId,
): Promise<PreparedAbilityConformanceWorktree> {
  await runCommand("./gradlew", [
    ":core:neoforge:jar",
    "--no-daemon",
    "--console=plain",
  ], RUNTIME_ROOT);
  const versions = await currentTemplateInputs();
  const templates = await prepareAbilityConformanceTemplates({
    cacheRoot,
    versions,
    ...(scenarioId === undefined ? {} : { scenarios: [scenarioId] }),
    generate: async (scenario, gameDirectory) => {
      await mkdir(gameDirectory, { recursive: true });
      const [minecraftPort, runtimePort] = await reservePorts(2);
      if (minecraftPort === undefined || runtimePort === undefined) {
        throw new Error("Could not reserve Ability Conformance preparation ports");
      }
      await writePreparationServerFiles(gameDirectory, minecraftPort, scenario.difficulty);
      const registration = ABILITY_CONFORMANCE_SCENARIOS.find(({ id }) => id === scenario.id);
      if (registration === undefined) throw new Error(`Unknown Ability Conformance Scenario: ${scenario.id}`);
      const logPath = join(gameDirectory, "template-server.log");
      await runCommand("./gradlew", [
        ":core:neoforge:runAbilityConformanceTemplateServer",
        "--no-daemon",
        "--console=plain",
        `-PabilityConformanceGameDir=${gameDirectory}`,
        `-PabilityConformanceSpecification=${abilityConformanceSpecificationPath(registration.id)}`,
        `-PabilityConformanceMinecraftPort=${minecraftPort}`,
      ], RUNTIME_ROOT, logPath, {
        EVICRAFT_RUNTIME_PORT: String(runtimePort),
        EVICRAFT_RUNTIME_BEARER_TOKEN: `template-${randomUUID()}`,
      });
      const output = await readFile(logPath, "utf8");
      if (!output.includes(`ABILITY_CONFORMANCE_TEMPLATE_READY scenario=${scenario.id}`)) {
        throw new Error(`Template generator did not report a clean save for ${scenario.id}`);
      }
    },
  });
  return { versions, cacheRoot, runsRoot: DEFAULT_CONFORMANCE_RUNS, templates };
}

export async function currentTemplateInputs(): Promise<TemplateInputs> {
  const properties = parseProperties(await readFile(join(RUNTIME_ROOT, "gradle.properties"), "utf8"));
  const minecraftVersion = properties.get("minecraft_version");
  const neoForgeVersion = properties.get("neoforge_version");
  if (minecraftVersion === undefined || neoForgeVersion === undefined) {
    throw new Error("Runtime gradle.properties omits Minecraft or NeoForge version");
  }
  const artifactDirectory = join(RUNTIME_ROOT, "core", "neoforge", "build", "libs");
  const artifacts = productionModArtifactNames(await readdir(artifactDirectory));
  if (artifacts.length === 0) throw new Error("Expected a production Runtime Mod artifact");
  return {
    minecraftVersion,
    neoForgeVersion,
    modArtifactSha256: await digestFiles(artifactDirectory, artifacts),
    fixtureSourceSha256: await digestSourceTrees([
      {
        label: "generator",
        root: join(RUNTIME_ROOT, "core", "neoforge", "src", "smokeFixture"),
      },
      {
        label: "world-fixtures",
        root: join(REPOSITORY_ROOT, "apps", "agent", "fixtures", "ability-conformance"),
      },
    ]),
  };
}

export async function startCurrentWorktreeServer(input: Readonly<{
  serverDirectory: string;
  minecraftPort: number;
  runtimePort: number;
  bearerToken: string;
  logPath: string;
  rcon?: Readonly<{ port: number; password: string }>;
}>): Promise<ChildProcess> {
  if (input.rcon !== undefined) await appendFile(join(input.serverDirectory, "server.properties"),
    `\nenable-rcon=true\nrcon.port=${input.rcon.port}\nrcon.password=${input.rcon.password}\n`);
  const log = await open(input.logPath, "a");
  const child = spawn("./gradlew", [
    ":core:neoforge:runAbilityConformanceServer",
    "--no-daemon",
    "--console=plain",
    `-PabilityConformanceGameDir=${input.serverDirectory}`,
    `-PabilityConformanceMinecraftPort=${input.minecraftPort}`,
  ], {
    cwd: RUNTIME_ROOT,
    env: {
      ...process.env,
      EVICRAFT_RUNTIME_PORT: String(input.runtimePort),
      EVICRAFT_RUNTIME_BEARER_TOKEN: input.bearerToken,
      EVICRAFT_RUNTIME_PAUSE_WHEN_IDLE: "true",
    },
    shell: false,
    stdio: ["pipe", log.fd, log.fd],
  });
  child.once("exit", () => { void log.close(); });
  return child;
}

export async function waitForRuntimeReady(
  runtimeUrl: string,
  bearerToken: string,
  child: ChildProcess,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`NeoForge server exited before Runtime readiness (${child.exitCode})`);
    }
    try {
      const client = await RuntimeClient.connect({ url: runtimeUrl, bearerToken });
      try {
        await client.runtimeInfo();
        return;
      } finally {
        client.close();
      }
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for Runtime readiness: ${errorMessage(lastError)}`);
}

export function uniqueRunId(scenario: string): string {
  return `${scenario}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
}

export function productionModArtifactNames(names: readonly string[]): readonly string[] {
  return names
    .filter((name) => name.endsWith(".jar")
      && !name.endsWith("-sources.jar")
      && !name.endsWith("-javadoc.jar"))
    .sort();
}

async function writePreparationServerFiles(
  gameDirectory: string,
  port: number,
  difficulty: "peaceful" | "easy" | "normal" | "hard",
): Promise<void> {
  await writeFile(join(gameDirectory, "eula.txt"), "eula=true\n", { flag: "wx" });
  await writeFile(join(gameDirectory, "server.properties"), [
    "allow-flight=true",
    `difficulty=${difficulty}`,
    "enable-command-block=false",
    "gamemode=survival",
    "generate-structures=false",
    "level-name=world",
    "level-seed=302",
    "max-players=4",
    "online-mode=false",
    `server-port=${port}`,
    "server-ip=127.0.0.1",
    "spawn-monsters=false",
    "spawn-protection=0",
    "spawn-radius=0",
  ].join("\n") + "\n", { flag: "wx" });
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  logPath?: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const log = logPath === undefined ? undefined : await open(logPath, "w");
  try {
    const child = spawn(command, arguments_, {
      cwd,
      env: { ...process.env, ...environment },
      shell: false,
      stdio: log === undefined ? "inherit" : ["ignore", log.fd, log.fd],
    });
    const result = await new Promise<Readonly<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    if (result.code !== 0) {
      throw new Error(`${command} ${arguments_[0] ?? ""} failed (${result.code ?? result.signal})`);
    }
  } finally {
    await log?.close();
  }
}

async function digestFiles(root: string, names: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    for await (const chunk of createReadStream(join(root, name))) hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function digestSourceTrees(
  roots: readonly Readonly<{ label: string; root: string }>[],
): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (root: string, directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(root, path);
      else if (entry.isFile()) {
        hash.update(path.slice(root.length));
        hash.update(await readFile(path));
      }
    }
  };
  for (const source of [...roots].sort((left, right) => left.label.localeCompare(right.label))) {
    hash.update(source.label);
    await visit(source.root, source.root);
  }
  return hash.digest("hex");
}

function parseProperties(text: string): Map<string, string> {
  return new Map(text.split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator < 1 || line.trimStart().startsWith("#")
      ? []
      : [[line.slice(0, separator), line.slice(separator + 1)]];
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
