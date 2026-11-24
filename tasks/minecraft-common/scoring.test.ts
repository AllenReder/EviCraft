import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { createObservationLog } from "./observation-log.ts";
import { readObservations } from "./observation-test-support.ts";

const exec = promisify(execFile);
const survivalRoot = resolve("tasks/minecraft-survival/eval");
const discoveryRoot = resolve("tasks/minecraft-item-discovery/eval");
async function writeObservations(directory: string, rows: readonly Record<string, unknown>[]) {
  const path = join(directory, "task/observations.jsonl.gz");
  const writer = createObservationLog(path);
  for (const row of rows) await writer.append(row);
  await writer.close();
  return path;
}
const inventory = (ids: string[]) => ({ selectedHotbarSlot: 0,
  slots: Array.from({ length: 36 }, (_, slot) => ({ slot, item: ids[slot] ? { itemId: ids[slot], count: 1 } : null })),
  mainhand: null, offhand: null, armor: { head: null, chest: null, legs: null, feet: null } });
const identity = { taskId: "test", taskRevision: "1", attemptIndex: 0, repetitions: 1 };
const row = (kind: string, tick: number, ids: string[] = [], extra: Record<string, unknown> = {}) => ({
  schemaVersion: "2", attempt: identity, kind, capturedAt: "2026-01-01T00:00:00Z",
  elapsedTick: tick, receipt: { serverTick: 100 + tick, gameTime: 100 + tick, fenceSequence: tick + 1 },
  actor: { present: true, dimension: "minecraft:overworld" }, inventory: inventory(ids),
  evaluation: { location: { status: "unavailable", reason: "test" }, advancements: { status: "ok", value: [] },
    nearbyPortals: { status: "unavailable", reason: "test" } }, ...extra,
});

it.each(["survival", "discovery"])("scores %s partition observations with unchanged facts, repeated ticks and raw byte hashes", async metric => {
  const directory = await mkdtemp(join(tmpdir(), "offline-gzip-score-"));
  try {
    await mkdir(join(directory, "task"));
    await mkdir(join(directory, "runner"));
    await writeFile(join(directory, "runner", "attempt.json"), JSON.stringify({ runnerStatus: "completed", cleanup: { status: "completed" }, taskOutcome: { status: "timeout" } }));
    const rows = [row("initial", 0, [], { note: "矿石😀".repeat(20000) }),
      row("scheduled", 20, ["minecraft:iron_ingot"]),
      row("scheduled", 20, ["minecraft:diamond"], { receipt: { serverTick: 120, gameTime: 120, fenceSequence: 22 } }),
      row("scheduled", 20, ["minecraft:diamond"], { receipt: { serverTick: 120, gameTime: 120, fenceSequence: 23 } }),
      { schemaVersion: "2", attempt: identity, kind: "scheduled", capturedAt: "x", error: "poll failed" },
      row("scheduled", 36001, ["minecraft:diamond_pickaxe"]),
    ];
    const path = await writeObservations(directory, rows);
    const raw = gunzipSync(await readFile(path));
    expect(await readObservations(path)).toEqual(rows);
    const run = async (label: string) => {
      const out = join(directory, label);
      const root = metric === "survival" ? survivalRoot : discoveryRoot;
      const scorer = metric === "survival" ? "score-survival.py" : "score-item-discovery.py";
      await exec("python3", [join(root, scorer), "--attempt", directory,
        "--rubric", join(root, `${metric}-rubric.v1.json`), "--out", out]);
      return { score: JSON.parse(await readFile(join(out, "score.json"), "utf8")),
        curve: JSON.parse(await readFile(join(out, "curve.json"), "utf8")) };
    };
    const budget = metric === "survival" ? 72000 : 144000;
    const scored = await run("scored");
    expect(scored.score).toMatchObject({ skippedCollectionErrors: 1, primaryEligible: true,
      scorerVersion: "2", observationSchemaVersion: "2", rubricRevision: `${metric}-1.21.1-v1`, tickBudget: budget,
      observationEncoding: "observation-partition-replace", observationEncodingVersion: 1,
      rawLogSha256: createHash("sha256").update(raw).digest("hex") });
    if (metric === "survival") {
      expect(scored.score).toMatchObject({ score: 170, firstConfirmationTicks: { iron_ingot: 20, diamond: 20, diamond_pickaxe: 36001 } });
      expect(scored.curve.points).toEqual([{ tick: 0, value: 0 }, { tick: 20, value: 150 }, { tick: 36001, value: 170 },
        { tick: budget, value: 170 }]);
    } else {
      expect(scored.score).toMatchObject({ total: 3, firstConfirmationTicks: { "minecraft:iron_ingot": 20, "minecraft:diamond": 20,
        "minecraft:diamond_pickaxe": 36001 } });
      expect(scored.curve.points).toEqual([{ tick: 0, value: 0 }, { tick: 20, value: 2 }, { tick: 36001, value: 3 },
        { tick: budget, value: 3 }]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(["corrupt", "truncated"])("rejects %s gzip logs without publishing a score", async damage => {
  const directory = await mkdtemp(join(tmpdir(), "offline-damaged-gzip-"));
  try {
    await mkdir(join(directory, "task"));
    const path = await writeObservations(directory, [row("initial", 0)]);
    let compressed = await readFile(path);
    if (damage === "truncated") compressed = compressed.subarray(0, compressed.length - 8);
    else compressed[compressed.length - 8] = compressed[compressed.length - 8]! ^ 0xff;
    await writeFile(path, compressed);
    const out = join(directory, "score");
    await expect(exec("python3", [join(survivalRoot, "score-survival.py"), "--attempt", directory,
      "--rubric", join(survivalRoot, "survival-rubric.v1.json"), "--out", out], { timeout: 5000 }))
      .rejects.toThrow(/BadGzipFile|EOFError|CRC check failed|end-of-stream/);
    await expect(readFile(join(out, "score.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(["jsonl", "jsonl.gz"])("requires conversion of full %s observations before scoring", async extension => {
  const directory = await mkdtemp(join(tmpdir(), "offline-old-format-"));
  try {
    await mkdir(join(directory, "task"));
    const raw = JSON.stringify(row("initial", 0)) + "\n";
    await writeFile(join(directory, "task", `observations.${extension}`), extension.endsWith("gz") ? gzipSync(raw) : raw);
    const out = join(directory, "score");
    await expect(exec("python3", [join(survivalRoot, "score-survival.py"), "--attempt", directory,
      "--rubric", join(survivalRoot, "survival-rubric.v1.json"), "--out", out]))
      .rejects.toThrow(extension.endsWith("gz") ? /convert old logs first/ : /FileNotFoundError/);
    await expect(readFile(join(out, "score.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("carries historical items and keeps partial fact gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offline-score-"));
  try {
    await mkdir(join(directory, "task"));
    await mkdir(join(directory, "runner"));
    const rows = [
      row("initial", 0),
      row("scheduled", 20, ["minecraft:oak_log", "minecraft:iron_ingot"]),
      { schemaVersion: "2", attempt: identity, kind: "scheduled", capturedAt: "x", error: "poll failed" },
      row("scheduled", 40, ["minecraft:oak_log", "minecraft:diamond"], { inventory: {
        ...inventory(["minecraft:oak_log", "minecraft:diamond"]),
        offhand: { itemId: "example:relic", count: 1 },
        armor: { head: { itemId: "minecraft:iron_helmet", count: 1 }, chest: null, legs: null, feet: null },
      }, evaluation: {
        location: { status: "unavailable", reason: "gap" }, advancements: { status: "ok", value: [] },
        nearbyPortals: { status: "unavailable", reason: "gap" } } }),
    ];
    await writeObservations(directory, rows);
    await writeFile(join(directory, "runner", "attempt.json"), JSON.stringify({ runnerStatus: "completed", cleanup: { status: "completed" }, taskOutcome: { status: "timeout" } }));
    const survivalOut = join(directory, "survival");
    await exec("python3", [join(survivalRoot, "score-survival.py"), "--attempt", directory, "--rubric", join(survivalRoot, "survival-rubric.v1.json"), "--out", survivalOut]);
    const survival = JSON.parse(await readFile(join(survivalOut, "score.json"), "utf8"));
    expect(survival).toMatchObject({ score: 150, firstConfirmationTicks: { log_or_stem: 20, iron_ingot: 20, diamond: 40 }, skippedCollectionErrors: 1, primaryEligible: true });
    expect(survival.auc).toBe(100 * 20 + 150 * (72000 - 40));
    const revisedRubric = JSON.parse(await readFile(join(survivalRoot, "survival-rubric.v1.json"), "utf8"));
    revisedRubric.revision = "test-reweighted";
    revisedRubric.nodes.find((node: { id: string }) => node.id === "iron_ingot").points = 120;
    const revisedPath = join(directory, "reweighted.json");
    await writeFile(revisedPath, JSON.stringify(revisedRubric));
    const revisedOut = join(directory, "reweighted");
    await exec("python3", [join(survivalRoot, "score-survival.py"), "--attempt", directory, "--rubric", revisedPath, "--out", revisedOut]);
    const revised = JSON.parse(await readFile(join(revisedOut, "score.json"), "utf8"));
    expect(revised.auc).toBe(120 * 20 + 150 * (72000 - 40));
    expect(revised.rawLogSha256).toBe(survival.rawLogSha256);
    expect(revised.rubricSha256).not.toBe(survival.rubricSha256);
    const discoveryOut = join(directory, "discovery");
    await exec("python3", [join(discoveryRoot, "score-item-discovery.py"), "--attempt", directory, "--rubric", join(discoveryRoot, "discovery-rubric.v1.json"), "--out", discoveryOut]);
    const discovery = JSON.parse(await readFile(join(discoveryOut, "score.json"), "utf8"));
    expect(discovery).toMatchObject({ total: 5, firstConfirmationTicks: { "minecraft:oak_log": 20, "minecraft:iron_ingot": 20,
      "minecraft:diamond": 40, "example:relic": 40, "minecraft:iron_helmet": 40 } });
    expect(discovery.firstConfirmationTicks).not.toHaveProperty("minecraft:diamond_pickaxe");
    await writeFile(join(directory, "runner", "attempt.json"), JSON.stringify({ runnerStatus: "completed", cleanup: { status: "completed" }, taskOutcome: { status: "success" } }));
    const earlyOut = join(directory, "early");
    await exec("python3", [join(discoveryRoot, "score-item-discovery.py"), "--attempt", directory,
      "--rubric", join(discoveryRoot, "discovery-rubric.v1.json"), "--out", earlyOut]);
    expect(JSON.parse(await readFile(join(earlyOut, "score.json"), "utf8"))).toMatchObject({ total: 5, primaryEligible: false });
    await writeFile(join(directory, "runner", "attempt.json"), JSON.stringify({ runnerStatus: "cancelled", cleanup: { status: "completed" }, taskOutcome: null }));
    const cancelledOut = join(directory, "cancelled");
    await exec("python3", [join(discoveryRoot, "score-item-discovery.py"), "--attempt", directory,
      "--rubric", join(discoveryRoot, "discovery-rubric.v1.json"), "--out", cancelledOut]);
    const cancelled = JSON.parse(await readFile(join(cancelledOut, "score.json"), "utf8"));
    expect(cancelled).toMatchObject({ total: 5, primaryEligible: false, terminalClassification: { runnerStatus: "cancelled" } });
    expect(cancelled.rawLogSha256).toBe(discovery.rawLogSha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("scores portal geometry, active blocks, and whole fortress bounds independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offline-portal-score-"));
  try {
    await mkdir(join(directory, "task"));
    const netherFrame = { kind: "nether", frameComplete: true, active: false, evidence: [{ blockState: "minecraft:obsidian" }] };
    const activeNether = { kind: "nether", frameComplete: true, active: true, evidence: [{ blockState: "minecraft:nether_portal[axis=x]" }] };
    const endFrame = { kind: "end", frameComplete: false, active: false, evidence: [{ blockState: "minecraft:end_portal_frame[facing=north,eye=true]" }] };
    const activeEnd = { kind: "end", frameComplete: false, active: true, evidence: [{ blockState: "minecraft:end_portal" }] };
    const evaluation = (candidates: unknown[], fortress = false) => ({
      location: { status: "ok", value: { biomeId: "minecraft:nether_wastes", structuresContainingActor: fortress ? [{ id: "minecraft:fortress", bounds: {} }] : [] } },
      advancements: { status: "unavailable", reason: "test" },
      nearbyPortals: { status: "ok", value: { candidates } },
    });
    const rows = [row("initial", 0),
      row("scheduled", 10, [], { evaluation: evaluation([netherFrame]) }),
      row("scheduled", 20, [], { evaluation: evaluation([activeNether], true), actor: { present: true, dimension: "minecraft:the_nether" } }),
      row("scheduled", 30, [], { evaluation: evaluation([endFrame]) }),
      row("scheduled", 40, [], { evaluation: evaluation([activeEnd]) }),
    ];
    await writeObservations(directory, rows);
    const out = join(directory, "score");
    await exec("python3", [join(survivalRoot, "score-survival.py"), "--attempt", directory, "--rubric", join(survivalRoot, "survival-rubric.v1.json"), "--out", out]);
    const result = JSON.parse(await readFile(join(out, "score.json"), "utf8"));
    expect(result).toMatchObject({ score: 300, firstConfirmationTicks: { nether_frame: 10, nether_portal_active: 20,
      enter_nether: 20, enter_fortress: 20, end_frame_vicinity: 30, end_portal_active: 40 } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
