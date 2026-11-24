import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProcessHarness, whileHarnessRuns, type TaskHarness } from "../src/index.js";

const directories: string[] = [];
const started: TaskHarness[] = [];
afterEach(async () => {
  await Promise.allSettled(started.splice(0).map(harness => harness.stop()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function launch(program: string, config: unknown = { model: "anything" }) {
  const directory = await mkdtemp(join(tmpdir(), "process-harness-"));
  directories.push(directory);
  await writeFile(join(directory, "agent.mjs"), program);
  const harness = createProcessHarness({ command: [process.execPath, "agent.mjs"], cwd: directory, assignment: "Obtain a diamond.", config: config as never })({
    bot: { id: "bot-id", username: "bot" }, runtimeUrl: "ws://127.0.0.1:1/rpc", runtimeBearerToken: "runtime-secret",
    outputDirectory: directory, runnerDirectory: directory, signal: new AbortController().signal,
  });
  started.push(harness);
  return { harness, directory };
}

it("gives the process its task file and Runtime credentials, and stops it with a signal", async () => {
  const { harness, directory } = await launch(`
    import { readFileSync, writeFileSync } from "node:fs";
    const task = JSON.parse(readFileSync(process.env.EVICRAFT_TASK_FILE, "utf8"));
    writeFileSync("seen.json", JSON.stringify({ task, url: process.env.EVICRAFT_RUNTIME_URL, token: process.env.EVICRAFT_RUNTIME_BEARER_TOKEN, cwd: process.cwd() }));
    console.log("agent ready");
    process.on("SIGINT", () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  await harness.start();
  await expect.poll(async () => await readFile(join(directory, "seen.json"), "utf8").catch(() => "")).not.toBe("");
  const seen = JSON.parse(await readFile(join(directory, "seen.json"), "utf8"));
  expect(seen).toMatchObject({ url: "ws://127.0.0.1:1/rpc", token: "runtime-secret",
    task: { assignment: "Obtain a diamond.", bot: { id: "bot-id", username: "bot" }, runtime: { url: "ws://127.0.0.1:1/rpc" },
      outputDirectory: directory, config: { model: "anything" } } });
  expect(JSON.stringify(seen.task)).not.toContain("runtime-secret");
  await harness.stop();
  await harness.exited;
  expect(await readFile(join(directory, "harness.log"), "utf8")).toContain("agent ready");
});

it("reports a process that fails by itself, and a clean early exit only as an exit", async () => {
  const failing = await launch(`process.exit(3);`);
  await failing.harness.start();
  await expect(failing.harness.failure).rejects.toThrow("Harness exited: 3");

  const leaving = await launch(`process.exit(0);`);
  await leaving.harness.start();
  await leaving.harness.exited;
  const running = whileHarnessRuns(leaving.harness, new AbortController().signal);
  await expect(running(new Promise(() => {}))).rejects.toThrow("Harness ended before game tick budget");
});

it("fails when the command cannot be started", async () => {
  const directory = await mkdtemp(join(tmpdir(), "process-harness-"));
  directories.push(directory);
  const harness = createProcessHarness({ command: [join(directory, "missing-program")], cwd: directory, assignment: "x" })({
    bot: { id: "bot-id", username: "bot" }, runtimeUrl: "ws://127.0.0.1:1/rpc", runtimeBearerToken: "t",
    outputDirectory: directory, runnerDirectory: directory, signal: new AbortController().signal,
  });
  await expect(harness.start()).rejects.toThrow();
  await expect(harness.failure).rejects.toThrow();
});
