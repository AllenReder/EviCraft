import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createRunDirectory, freezeConfig, parseOverride, reshapePlan } from "../src/run-directory.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function configFile(config: Readonly<Record<string, unknown>>): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "run-directory-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  return { directory, path };
}

const config = {
  serverTemplatePath: "../server", snapshotPath: "snapshots/seed", camera: { clientTemplatePath: "/absolute/camera" }, tickBudget: 100,
  harness: { command: ["node", "agent.mjs"], config: { model: { baseUrl: "http://a" } } },
};

it("makes task paths absolute and keeps the Harness in the directory of the original config", async () => {
  const { directory, path } = await configFile(config);
  expect(await freezeConfig(path, [])).toEqual({
    serverTemplatePath: join(directory, "../server"), snapshotPath: join(directory, "snapshots/seed"),
    camera: { clientTemplatePath: "/absolute/camera" }, tickBudget: 100,
    harness: { command: ["node", "agent.mjs"], workingDirectory: directory, config: { model: { baseUrl: "http://a" } } },
  });
});

it("applies --set overrides, parsing JSON values and keeping other text", async () => {
  const { path } = await configFile(config);
  const frozen = await freezeConfig(path, ["tickBudget=2400", "camera=null", "harness.config.model.baseUrl=http://b", "harness.config.vision.retainedImages=3"].map(parseOverride));
  expect(frozen).toMatchObject({ tickBudget: 2400, camera: null,
    harness: { config: { model: { baseUrl: "http://b" }, vision: { retainedImages: 3 } } } });
  expect(() => parseOverride("tickBudget")).toThrow("key.path=value");
  await expect(freezeConfig(path, [parseOverride("tickBudget.unit=ticks")])).rejects.toThrow("tickBudget is not an object");
});

it("replaces the config's Harness with the command given after --", async () => {
  const { path } = await configFile(config);
  const frozen = await freezeConfig(path, [], { command: ["python3", "my_agent.py"], workingDirectory: "/work", config: null });
  expect(frozen.harness).toEqual({ command: ["python3", "my_agent.py"], workingDirectory: "/work", config: null });
});

it("lays out a run directory whose batch points at the frozen configs", async () => {
  const { directory, path } = await configFile({ ...config, serverTemplatePath: "server", camera: null });
  await mkdir(join(directory, "server"));
  const plan = reshapePlan({ concurrency: 4, executions: [
    { instance: { id: "g", taskPath: "/task", configPath: path }, repetition: 0 },
    { instance: { id: "l", taskPath: "/task", configPath: path }, repetition: 0 },
  ] }, { instances: ["g"], repetitions: 2, concurrency: 1 });
  const run = join(directory, "run");
  const frozen = await createRunDirectory(run, plan, [parseOverride("tickBudget=7")], async inspected => ({ inspected: inspected.executions.length }));
  expect(frozen).toEqual({ concurrency: 1, executions: [0, 1].map(repetition => ({
    instance: { id: "g", taskPath: "/task", configPath: join(run, "inputs/configs/g.json") }, repetition })) });
  expect(JSON.parse(await readFile(join(run, "inputs/configs/g.json"), "utf8"))).toMatchObject({ tickBudget: 7 });
  expect(JSON.parse(await readFile(join(run, "inputs/batch.yaml"), "utf8"))).toEqual({ concurrency: 1,
    instances: [{ id: "g", taskPath: "/task", configPath: join(run, "inputs/configs/g.json"), repetitions: 2 }] });
  expect(JSON.parse(await readFile(join(run, "inputs/overrides.json"), "utf8"))).toEqual({ set: [{ key: "tickBudget", value: 7 }], harness: null });
  expect(JSON.parse(await readFile(join(run, "dry-run.json"), "utf8"))).toEqual({ inspected: 2 });
  await expect(createRunDirectory(run, plan, [], async () => null)).rejects.toThrow("already exists");
  expect(() => reshapePlan(plan, { instances: ["missing"] })).toThrow("Unknown instance");
});

it("refuses a config whose templates are not built, before creating the run directory", async () => {
  const { directory, path } = await configFile({ ...config, serverTemplatePath: "server" });
  const plan = { concurrency: 1, executions: [{ instance: { id: "g", taskPath: "/task", configPath: path }, repetition: 0 }] };
  const run = join(directory, "run");
  await expect(createRunDirectory(run, plan, [], async () => null)).rejects.toThrow("serverTemplatePath");
  await mkdir(join(directory, "server"));
  await expect(createRunDirectory(run, plan, [], async () => null)).rejects.toThrow("camera.clientTemplatePath /absolute/camera does not exist; build the templates");
  await expect(stat(run)).rejects.toThrow("ENOENT");
});
