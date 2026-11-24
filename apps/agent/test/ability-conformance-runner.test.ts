import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, type Deferred, waitFor } from "./support/async.js";
import {
  loadAbilityConformanceWorldSpecification,
  type AbilityConformanceWorldSpecification,
} from "../src/smoke/conformance-world.js";
import {
  prepareAbilityConformanceTemplates,
  runWithFreshScenarioWorld,
} from "../src/smoke/conformance-runner.js";
import { ABILITY_CONFORMANCE_SCENARIOS } from "../src/smoke/scenarios/index.js";
import { intervene } from "../src/smoke/scenarios/shared.js";
import {
  productionModArtifactNames,
} from "../src/smoke/current-worktree.js";
import {
  assertNotListening,
  reservePorts,
  sendServerCommand,
  stopServer,
} from "../src/smoke/neoforge-server-process.js";

const versions = {
  minecraftVersion: "1.21.1",
  neoForgeVersion: "21.1.233",
  modArtifactSha256: "c".repeat(64),
  fixtureSourceSha256: "d".repeat(64),
} as const;

describe("Ability Conformance runner", () => {
  afterEach(() => vi.useRealTimers());

  it("reserves distinct local ports in one allocation", async () => {
    const ports = await reservePorts(2);
    expect(ports).toHaveLength(2);
    expect(new Set(ports).size).toBe(2);
  });

  it("keys templates only from the production Runtime Mod artifact", () => {
    expect(productionModArtifactNames([
      "mc_agent-neoforge.jar",
      "mc_agent-neoforge-javadoc.jar",
      "mc_agent-neoforge-sources.jar",
      "notes.txt",
    ])).toEqual(["mc_agent-neoforge.jar"]);
  });

  it("sends one newline-terminated command to a development server console", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", [
      "process.stdin.once('data', (chunk) => {",
      "  process.stdout.write(chunk);",
      "  process.exit(0);",
      "});",
    ].join("\n")], { stdio: ["pipe", "pipe", "pipe"] });
    const output = new Promise<string>((resolvePromise, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => resolvePromise(String(chunk)));
    });

    await sendServerCommand(child, "say conformance");

    await expect(output).resolves.toBe("say conformance\n");
  });

  it("records each Smoke Intervention before sending its server command", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "ability-conformance-intervention-"));
    const child = spawn(process.execPath, ["--input-type=module", "-e", [
      "process.stdin.once('data', (chunk) => {",
      "  process.stdout.write(chunk);",
      "  process.exit(0);",
      "});",
    ].join("\n")], { stdio: ["pipe", "pipe", "pipe"] });
    const output = new Promise<string>((resolvePromise, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => resolvePromise(String(chunk)));
    });

    await intervene(child, artifactsDirectory, "move to Nether", "say conformance");

    await expect(output).resolves.toBe("say conformance\n");
    expect(await readFile(join(artifactsDirectory, "smoke-interventions.jsonl"), "utf8"))
      .toBe(`${JSON.stringify({ label: "move to Nether", command: "say conformance" })}\n`);
  });

  it("stops a development server through its graceful interrupt path", async () => {
    const [port] = await reservePorts(1);
    expect(port).toBeDefined();
    const child = spawn(process.execPath, ["--input-type=module", "-e", [
      "import { createServer } from 'node:net';",
      `const server = createServer().listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n'));`,
      "process.on('SIGTERM', () => {});",
      "process.on('SIGINT', () => server.close(() => process.exit(0)));",
    ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolvePromise());
    });

    await stopServer(child, 500);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    await assertNotListening(port!);
  });

  it("reports a development server that remains alive after forced termination", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(() => true),
    });

    const stopped = stopServer(child as never, 10);
    const rejection = expect(stopped).rejects.toThrow(/did not exit after SIGKILL/u);
    await vi.runAllTimersAsync();
    await rejection;

    expect(child.kill).toHaveBeenCalledTimes(3);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGINT");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(3, "SIGKILL");
  });

  it("recognizes a development server that already exited by signal", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: "SIGTERM",
      kill: vi.fn(() => false),
    });

    const stopped = stopServer(child as never, 10);
    const resolved = expect(stopped).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await resolved;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("waits for a stopped development server to release its listening port", async () => {
    const listener = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = listener.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("test listener did not reserve a local port");
    }

    const released = assertNotListening(address.port, 1_000);
    setTimeout(() => listener.close(), 50);

    await expect(released).resolves.toBeUndefined();
  });

  it("prepares every scenario once and reuses only a valid sealed cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-runner-"));
    const generated: string[] = [];
    const generate = async (
      scenario: AbilityConformanceWorldSpecification,
      gameDirectory: string,
    ) => {
      generated.push(scenario.id);
      await writeGeneratedWorld(scenario, gameDirectory);
    };

    const first = await prepareAbilityConformanceTemplates({
      cacheRoot: root,
      versions,
      generate,
    });
    expect(generated).toEqual(ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) => id));
    const second = await prepareAbilityConformanceTemplates({
      cacheRoot: root,
      versions,
      generate,
    });
    expect(generated).toHaveLength(ABILITY_CONFORMANCE_SCENARIOS.length);
    expect(second).toEqual(first);
  });

  it("never overlaps cold template generators and preserves registry order", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-runner-"));
    const gates = new Map<string, Deferred>();
    let active = 0;
    let peakActive = 0;
    const generated: string[] = [];
    const preparation = prepareAbilityConformanceTemplates({
      cacheRoot: root,
      versions,
      generate: async (scenario, gameDirectory) => {
        const gate = deferred();
        gates.set(scenario.id, gate);
        generated.push(scenario.id);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await gate.promise;
        active -= 1;
        await writeGeneratedWorld(scenario, gameDirectory);
      },
    });

    for (const { id } of ABILITY_CONFORMANCE_SCENARIOS) {
      await waitFor(() => gates.has(id));
      expect(peakActive).toBe(1);
      gates.get(id)!.resolve();
    }

    const prepared = await preparation;
    expect(peakActive).toBe(1);
    expect(prepared.map(({ scenario }) => scenario))
      .toEqual(ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) => id));
    expect(generated).toEqual(ABILITY_CONFORMANCE_SCENARIOS.map(({ id }) => id));

    await prepareAbilityConformanceTemplates({
      cacheRoot: root,
      versions,
      generate: async () => { throw new Error("valid cache should not regenerate"); },
    });
  });

  it("prepares only the requested scenario when filtered", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-runner-"));
    const generated: string[] = [];
    const prepared = await prepareAbilityConformanceTemplates({
      cacheRoot: root,
      versions,
      scenarios: ["food-consumption-and-recovery"],
      generate: async (scenario, gameDirectory) => {
        generated.push(scenario.id);
        await writeGeneratedWorld(scenario, gameDirectory);
      },
    });
    expect(generated).toEqual(["food-consumption-and-recovery"]);
    expect(prepared.map(({ scenario }) => scenario)).toEqual(["food-consumption-and-recovery"]);
  });

  it("removes successful copies and retains failed copies with artifact paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-runner-"));
    const cacheRoot = join(root, "cache");
    await prepareAbilityConformanceTemplates({
      cacheRoot,
      versions,
      generate: writeGeneratedWorld,
    });

    const success = await runWithFreshScenarioWorld({
      scenario: "interaction-and-collection",
      cacheRoot,
      runsRoot: join(root, "runs"),
      versions,
      runId: "success",
      execute: async ({ artifactsDirectory, serverDirectory }) => {
        await mkdir(artifactsDirectory, { recursive: true });
        await writeFile(join(artifactsDirectory, "events.jsonl"), "ok");
        expect(await readFile(join(serverDirectory, "world", "level.dat"), "utf8"))
          .toBe("interaction-and-collection");
      },
    });
    await expect(stat(success.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(runWithFreshScenarioWorld({
      scenario: "furnace-processing",
      cacheRoot,
      runsRoot: join(root, "runs"),
      versions,
      runId: "failure",
      execute: async ({ artifactsDirectory }) => {
        await mkdir(artifactsDirectory, { recursive: true });
        await writeFile(join(artifactsDirectory, "server.log"), "failed");
        throw new Error("scenario failed");
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("scenario failed"),
      retainedRunDirectory: join(root, "runs", "failure"),
      retainedArtifactsDirectory: join(root, "runs", "failure", "artifacts"),
    });
    await expect(stat(join(root, "runs", "failure", "artifacts", "server.log")))
      .resolves.toBeDefined();
  });

  it("uses a prepared manifest without revalidating the template tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-runner-"));
    const cacheRoot = join(root, "cache");
    const [preparedTemplate] = await prepareAbilityConformanceTemplates({
      cacheRoot,
      versions,
      scenarios: ["food-consumption-and-recovery"],
      generate: writeGeneratedWorld,
    });
    await writeFile(join(cacheRoot, "templates", preparedTemplate.scenario, "world", "changed"), "changed");
    await expect(runWithFreshScenarioWorld({
      scenario: preparedTemplate.scenario,
      cacheRoot,
      runsRoot: join(root, "runs"),
      versions,
      runId: "prepared",
      preparedTemplate,
      execute: async ({ manifest }) => expect(manifest).toBe(preparedTemplate.manifest),
    })).resolves.toMatchObject({ retained: false });
  });

  it("makes hidden fixture markers available only in the Scenario Oracle context", async () => {
    const root = await mkdtemp(join(tmpdir(), "ability-conformance-runner-"));
    const cacheRoot = join(root, "cache");
    await prepareAbilityConformanceTemplates({
      cacheRoot,
      versions,
      generate: writeGeneratedWorld,
    });

    await runWithFreshScenarioWorld({
      scenario: "food-consumption-and-recovery",
      cacheRoot,
      runsRoot: join(root, "runs"),
      versions,
      runId: "hidden-marker",
      execute: async ({ manifest }) => {
        expect(manifest.hiddenMarkers).toEqual({
          sealed_probe: { x: 33, y: 101, z: 33 },
        });
      },
    });
  });
});

async function writeGeneratedWorld(
  scenario: AbilityConformanceWorldSpecification,
  gameDirectory: string,
): Promise<void> {
  await mkdir(join(gameDirectory, "world"), { recursive: true });
  await writeFile(join(gameDirectory, "world", "level.dat"), scenario.id);
  await writeFile(join(gameDirectory, "world", ".ability-conformance-generated.json"), `${JSON.stringify({
    schemaVersion: 1,
    scenario: scenario.id,
    difficulty: scenario.difficulty,
    sharedSpawn: scenario.sharedSpawn,
    fixtures: scenario.fixtures,
    ...(scenario.structureFixture === undefined ? {} : { structureFixture: scenario.structureFixture }),
    hiddenMarkers: scenario.hiddenMarkers,
    ...(scenario.combat === undefined ? {} : { combat: scenario.combat }),
  })}\n`);
}
