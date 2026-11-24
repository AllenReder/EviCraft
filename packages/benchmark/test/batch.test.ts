import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadBatch, runBatch, resumeBatch, inspectBatch } from "../src/task-runner.js";

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "batch-test-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("resolves paths against the Batch file and expands repetitions in declaration order", async () => {
  const root = await directory();
  await mkdir(join(root, "plans"));
  await writeFile(join(root, "plans/batch.yaml"), `concurrency: 2
instances:
  - id: g
    taskPath: ../task
    configPath: ../g.json
    repetitions: 2
  - id: p
    taskPath: ${root}/task
    configPath: ${root}/p.json
    repetitions: 1
`);
  const batch = await loadBatch(join(root, "plans/batch.yaml"));
  expect(batch.concurrency).toBe(2);
  expect(batch.executions).toEqual([
    { instance: { id: "g", taskPath: join(root, "task"), configPath: join(root, "g.json") }, repetition: 0 },
    { instance: { id: "g", taskPath: join(root, "task"), configPath: join(root, "g.json") }, repetition: 1 },
    { instance: { id: "p", taskPath: join(root, "task"), configPath: join(root, "p.json") }, repetition: 0 },
  ]);
});

async function fixture(configs: Record<string, unknown>[]) {
  const root = await directory();
  await writeFile(join(root, "task.ts"), `
    import { readFile, writeFile, appendFile } from 'node:fs/promises';
    import { join, dirname } from 'node:path';
    import { createServer } from 'node:net';
    import { setTimeout as delay } from 'node:timers/promises';
    export default { id: 'fixture', revision: '1', async configure(path) {
      const config = JSON.parse(await readFile(path, 'utf8'));
      let prepared = false;
      return { configuration: config,
        platform: { async prepare({identity}) {
          if (prepared) throw new Error('Mutable configured state was reused');
          prepared = true;
          const server = createServer();
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          await appendFile(join(dirname(path), 'lifecycle.jsonl'), JSON.stringify({kind:'open', instance:identity.instanceId})+'\\n');
          return { world: {}, bot: {id: String(server.address().port)}, harness: {}, async close() {
            await delay(config.closeDelay ?? 1);
            await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
            await appendFile(join(dirname(path), 'lifecycle.jsonl'), JSON.stringify({kind:'close', instance:identity.instanceId})+'\\n');
            if (config.cleanupFailure) throw new Error('cleanup failed');
          }};
        }},
        async run(context) {
          await writeFile(join(context.taskDirectory, 'result.json'), JSON.stringify({port:context.bot.id, label:config.label}));
          await delay(config.runDelay ?? 1);
          if (config.failUntil && !(await readFile(config.failUntil,'utf8').catch(() => ''))) throw new Error('infrastructure failure');
          return {status: config.outcome ?? 'success'};
        }
      };
    }};
  `);
  const entries = [];
  for (const [index, config] of configs.entries()) {
    await writeFile(join(root, `${index}.json`), JSON.stringify(config));
    entries.push({ id: String(index), taskPath: root, configPath: join(root, `${index}.json`), repetitions: 2 });
  }
  await writeFile(join(root, "batch.yaml"), JSON.stringify({ concurrency: 2, instances: entries }));
  return { root, plan: await loadBatch(join(root, "batch.yaml")) };
}

it("resumes infrastructure failures but preserves normal Task failures and old Attempts", async () => {
  const marker = join(await directory(), "server-ready");
  const { root, plan } = await fixture([{ outcome: "failure" }, { failUntil: marker }]);
  const first = await runBatch({ plan, outputDirectory: root, watchdogMs: 1000 });
  expect(first.status).toBe("incomplete");
  expect(first.attempts.map(a => a.runnerStatus)).toEqual(["completed", "completed", "process_failure", "process_failure"]);
  const old = await readFile(join(first.attempts[2]!.identity.runnerDirectory, "attempt.json"), "utf8");
  await writeFile(marker, "ready");
  const resumed = await resumeBatch(first.batchDirectory);
  expect(resumed.status).toBe("completed");
  expect(resumed.attempts).toHaveLength(6);
  expect(resumed.attempts.filter(a => a.identity.instanceId === "0")).toHaveLength(2);
  expect(await readFile(join(first.attempts[2]!.identity.runnerDirectory, "attempt.json"), "utf8")).toBe(old);
  expect(new Set(resumed.attempts.map(a => a.identity.attemptId)).size).toBe(6);
  expect((await resumeBatch(first.batchDirectory)).attempts).toHaveLength(6);
});

it("halts dispatch on cleanup failure while other active Attempts finish", async () => {
  const { root, plan } = await fixture([{ cleanupFailure: true }, { label: "must-not-start" }]);
  const result = await runBatch({ plan, outputDirectory: root, watchdogMs: 1000 });
  expect(result.status).toBe("incomplete");
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts.every(a => a.runnerStatus !== "running" && a.cleanup.status === "failed")).toBe(true);
  expect((await readFile(join(root, "lifecycle.jsonl"), "utf8")).match(/"kind":"close"/g)).toHaveLength(2);
});

it("dry-runs Task configuration without preparing servers", async () => {
  const { root, plan } = await fixture([{ label: "inspect" }]);
  const report = await inspectBatch(plan);
  expect(report.instances).toHaveLength(1);
  expect(report.instances[0]?.configuration).toEqual({ label: "inspect" });
  await expect(readFile(join(root, "lifecycle.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("recovers an interrupted Attempt and a directory created before its first checkpoint", async () => {
  const { root, plan } = await fixture([{}]);
  const first = await runBatch({ plan, outputDirectory: root, watchdogMs: 1000 });
  const record = first.attempts[0]!;
  const path = join(record.identity.runnerDirectory, "attempt.json");
  await writeFile(path, JSON.stringify({ identity: record.identity, startedAt: record.startedAt, runnerStatus: "running", taskOutcome: null }));
  await mkdir(join(first.batchDirectory, "execution-0", "interrupted-before-checkpoint", "runner"), { recursive: true });
  const resumed = await resumeBatch(first.batchDirectory);
  expect(resumed.status).toBe("completed");
  expect(resumed.attempts).toHaveLength(3);
  expect(resumed.attempts.filter(a => a.identity.attemptIndex === 1)).toHaveLength(1);
  expect(JSON.parse(await readFile(path, "utf8")).runnerStatus).toBe("running");
});

it("shares capacity through cleanup across Instances and concurrently repeats one Instance", async () => {
  const { root, plan } = await fixture([{ label: "g", closeDelay: 20 }, { label: "p" }]);
  const result = await runBatch({ plan, outputDirectory: root, watchdogMs: 1000 });
  expect(result.attempts.map(a => [a.identity.instanceId, a.identity.attemptIndex])).toEqual([["0", 0], ["0", 1], ["1", 0], ["1", 1]]);
  expect(result.attempts.every(a => a.runnerStatus === "completed" && a.cleanup.status === "completed")).toBe(true);
  expect(new Set(result.attempts.map(a => a.identity.directory)).size).toBe(4);
  const events = (await readFile(join(root, "lifecycle.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  let active = 0; let maximum = 0;
  for (const event of events) { active += event.kind === "open" ? 1 : -1; maximum = Math.max(maximum, active); }
  expect(maximum).toBe(2);
  expect(active).toBe(0);
  expect(events.filter(event => event.kind === "open").map(event => event.instance)).toEqual(["0", "0", "1", "1"]);
});
