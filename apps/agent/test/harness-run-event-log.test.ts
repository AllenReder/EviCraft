import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessRunEventLog } from "../src/harness/harness-run-event-log.js";

describe("HarnessRunEventLog", () => {
  const logs: HarnessRunEventLog[] = [];
  afterEach(async () => { await Promise.allSettled(logs.splice(0).map(log => log.close())); });
  async function create(...args: Parameters<typeof HarnessRunEventLog.create>) {
    const log = await HarnessRunEventLog.create(...args);
    logs.push(log);
    return log;
  }
  it("keeps the original bytes and a detached JSON subscriber snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      let published: Readonly<Record<string, unknown>> | undefined;
      const log = await create(root, "bytes", ({ event }) => { published = event; });
      const event = { type: "observation", nested: { text: "中文\n\"quoted\"", omitted: undefined }, values: [undefined, NaN] };
      await log.commit(event);
      event.nested.text = "changed after commit";
      expect(await readFile(log.path, "utf8")).toBe('{"version":5,"sequence":1,"type":"observation","nested":{"text":"中文\\n\\\"quoted\\\""},"values":[null,null]}\n');
      expect(published).toEqual({ type: "observation", nested: { text: "中文\n\"quoted\"" }, values: [null, null] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    [{ type: "custom", "0": "zero", version: 7, sequence: 9 }, '{"0":"zero","version":7,"sequence":9,"type":"custom"}\n'],
    [{ type: "custom", toJSON: () => ({}) }, '{"version":5,"sequence":1}\n'],
    [{ type: "custom", toJSON: () => ["a"] }, '{"0":"a","version":5,"sequence":1}\n'],
  ])("preserves object-spread bytes for unusual event values (%j)", async (event, expected) => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      const log = await create(root, "legacy-keys");
      await log.commit(event as Record<string, unknown> & { type: string });
      expect(await readFile(log.path, "utf8")).toBe(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("closes after queued commits and rejects commits after closing", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      const log = await create(root, "close");
      const commit = log.commit({ type: "accepted" });
      const close = log.close();
      await expect(log.commit({ type: "late" })).rejects.toThrow("closing");
      await commit;
      await close;
      expect(await readFile(log.path, "utf8")).toBe('{"version":5,"sequence":1,"type":"accepted"}\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps raw JSON normalization identical in the journal and subscriber snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      let published: Readonly<Record<string, unknown>> | undefined;
      const log = await create(root, "raw-json", ({ event }) => { published = event; });
      const rawJSON = Reflect.get(JSON, "rawJSON");
      await log.commit({ type: "custom", nested: { value: rawJSON("9007199254740993"), text: rawJSON('"\\u0061"') } });
      expect(await readFile(log.path, "utf8")).toBe('{"version":5,"sequence":1,"type":"custom","nested":{"value":9007199254740992,"text":"a"}}\n');
      expect(published).toEqual({ type: "custom", nested: { value: 9007199254740992, text: "a" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("serializes concurrent commits in invocation order", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      const log = await create(root, "ordered");
      await Promise.all(Array.from({ length: 50 }, async (_, index) => await log.commit({ type: "test_event", index })));
      await log.drain();
      const events = (await readFile(log.path, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as { sequence: number; index: number; version: number });
      expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      expect(events.map((event) => event.index)).toEqual(Array.from({ length: 50 }, (_, index) => index));
      expect(events.every((event) => event.version === 5)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("publishes subscribers after durable append", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      let durable = "";
      const log = await create(root, "subscriber", async () => { durable = await readFile(log.path, "utf8"); });
      await log.commit({ type: "durable" });
      expect(durable).toContain('"sequence":1');
      expect(durable).toContain('"type":"durable"');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("publishes the exact JSON value written durably", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      let published: Readonly<Record<string, unknown>> | undefined;
      const log = await create(root, "canonical-subscriber", ({ event }) => { published = event; });
      await log.commit({ type: "model_response", omitted: undefined, nested: { value: 1, omitted: undefined } });
      expect(published).toEqual({ type: "model_response", nested: { value: 1 } });
      expect(JSON.parse(await readFile(log.path, "utf8"))).toEqual({
        version: 5,
        sequence: 1,
        type: "model_response",
        nested: { value: 1 },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps later commits durable after subscriber failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      const failure = new Error("subscriber failed");
      const log = await create(root, "subscriber-failure", async () => { throw failure; });
      await expect(log.commit({ type: "first" })).rejects.toThrow(failure);
      await expect(log.commit({ type: "second" })).resolves.toBeUndefined();
      expect(await readFile(log.path, "utf8")).toContain('"type":"second"');
      await expect(log.drain()).rejects.toThrow(failure);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records serialization failures in the drain chain while continuing later commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      const log = await create(root, "serialization-failure");
      const cyclicEvent: Record<string, unknown> & { type: string } = { type: "cyclic" };
      cyclicEvent.self = cyclicEvent;

      const serializationFailure = await log.commit(cyclicEvent).then(
        () => { throw new Error("Expected serialization to fail"); },
        (error: unknown) => error,
      );
      await expect(log.commit({ type: "recovered" })).resolves.toBeUndefined();

      expect(JSON.parse(await readFile(log.path, "utf8"))).toEqual({
        version: 5,
        sequence: 1,
        type: "recovered",
      });
      await expect(log.drain()).rejects.toBe(serializationFailure);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("continues queued commits after persistence failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-event-log-"));
    try {
      const log = await create(root, "recoverable");
      const runDirectory = join(root, "recoverable");
      await rm(runDirectory, { recursive: true, force: true });
      await expect(log.commit({ type: "missing_directory" })).rejects.toMatchObject({ code: "ENOENT" });
      await mkdir(runDirectory);
      await expect(log.commit({ type: "recovered" })).resolves.toBeUndefined();
      expect(await readFile(log.path, "utf8")).toContain('"type":"recovered"');
      await expect(log.drain()).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
