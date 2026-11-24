import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createObservationLog } from "./observation-log.ts";
import { readObservations } from "./observation-test-support.ts";

const exec = promisify(execFile);
const converter = fileURLToPath(new URL("./tools/convert-observations.mjs", import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "observation-log-"));
  directories.push(path);
  return path;
}

function observations() {
  const identity = { schemaVersion: "1", attempt: { taskId: "test", attemptIndex: 0 } };
  const facts = { actor: { present: true }, inventory: { slots: [], note: "矿石😀" }, actorDeathCount: 0,
    evaluation: { location: { status: "ok", value: { biomeId: "minecraft:plains" } },
      advancements: { status: "ok", value: [] }, nearbyPortals: { status: "unavailable", reason: "test" } } };
  return [
    { ...identity, kind: "initial", elapsedTick: 0, ...facts },
    { ...identity, kind: "action_end", elapsedTick: 0, ...facts, inventory: null },
    { ...identity, kind: "scheduled", error: "collection failed" },
    { ...identity, kind: "scheduled", elapsedTick: 0, ...facts, inventory: null },
    { ...identity, kind: "death_recovery", elapsedTick: 1, actor: null, evaluation: null },
    { ...identity, kind: "scheduled", elapsedTick: 2, evaluation: {} },
    { ...identity, kind: "scheduled", elapsedTick: 3, ...facts,
      evaluation: { ...facts.evaluation, location: { status: "unavailable", reason: "gap" }, extra: { untouched: true } } },
    { ...identity, kind: "terminal", elapsedTick: 3, ...facts },
  ];
}

it("round-trips missing, null and unavailable facts without inheriting facts into errors or mutating inputs", async () => {
  const path = join(await directory(), "observations.jsonl.gz");
  const rows = observations();
  const original = structuredClone(rows);
  const writer = createObservationLog(path);
  for (const row of rows) await writer.append(row);
  await writer.close();
  expect(rows).toEqual(original);
  expect(await readObservations(path)).toEqual(original);
  const encoded = gunzipSync(await readFile(path)).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  // Repeated-tick samples still exist, but reuse the facts last seen at action_end.
  expect(encoded).toHaveLength(rows.length + 1);
  expect(encoded[3]).toEqual({ meta: { kind: "scheduled", error: "collection failed" }, present: 0 });
  expect(encoded[4]).not.toHaveProperty("replace");
});

it.each(["jsonl", "jsonl.gz"])("converts full %s logs losslessly and preserves the source", async extension => {
  const root = await directory();
  const input = join(root, `old.${extension}`);
  const output = join(root, "new.jsonl.gz");
  const rows = observations().map(row => ({ ...row, note: "矿石😀".repeat(20000) }));
  const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const source = extension.endsWith("gz") ? gzipSync(raw) : raw;
  await writeFile(input, source);
  const { stdout } = await exec(process.execPath, [converter, "--input", input, "--output", output]);
  expect(JSON.parse(stdout)).toMatchObject({ input, output, records: rows.length, inputBytes: source.length });
  expect(await readObservations(output)).toEqual(rows);
  expect(await readFile(input)).toEqual(source);
});

it.each(["corrupt", "truncated", "invalid-json", "empty"])("reports %s conversion failures without hanging", async damage => {
  const root = await directory();
  const input = join(root, "old.jsonl.gz");
  const output = join(root, "new.jsonl.gz");
  let source = gzipSync(observations().map(row => JSON.stringify(row)).join("\n") + "\n");
  if (damage === "corrupt") source = Buffer.from("not a gzip stream");
  if (damage === "truncated") source = source.subarray(0, source.length - 8);
  if (damage === "invalid-json") source = gzipSync("{invalid json}\n");
  if (damage === "empty") source = gzipSync("");
  await writeFile(input, source);
  await expect(exec(process.execPath, [converter, "--input", input, "--output", output], { timeout: 5000 }))
    .rejects.toMatchObject({ code: 1, killed: false });
  expect(await readFile(input)).toEqual(source);
});

it("refuses to overwrite the source when conversion paths are the same", async () => {
  const input = join(await directory(), "old.jsonl");
  const source = observations().map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(input, source);
  await expect(exec(process.execPath, [converter, "--input", input, "--output", input]))
    .rejects.toThrow(/EEXIST/);
  expect(await readFile(input, "utf8")).toBe(source);
});
