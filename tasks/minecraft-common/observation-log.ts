import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { constants, createGzip } from "node:zlib";
import format from "./observation-format.json" with { type: "json" };

const partitions = format.partitions.map(name => ({ name, keys: name.split(".") }));
type JsonRecord = Record<string, unknown>;

/** One bounded stream per Attempt; unchanged partitions are referenced implicitly. */
export function createObservationLog(path: string) {
  const gzip = createGzip({ level: 1, flush: constants.Z_SYNC_FLUSH });
  const completion = pipeline(gzip, createWriteStream(path, { flags: "wx" }));
  const previous = new Map<string, string>();
  let identity: string | undefined;
  let failure: unknown;
  // Observe asynchronous file errors even while the Task is between samples.
  void completion.catch(error => { failure = error; });
  const write = async (record: unknown): Promise<void> => {
    if (failure !== undefined) throw failure;
    await new Promise<void>((resolve, reject) => {
      gzip.write(JSON.stringify(record) + "\n", error => error ? reject(error) : resolve());
    });
    if (failure !== undefined) throw failure;
  };
  return {
    async append(record: JsonRecord): Promise<void> {
      const { schemaVersion, attempt, ...meta } = record;
      const currentIdentity = JSON.stringify({ schemaVersion, attempt });
      if (identity === undefined) {
        await write({ ...format, static: { schemaVersion, attempt } });
        identity = currentIdentity;
      } else if (identity !== currentIdentity) {
        throw new Error("Observation schema or Attempt identity changed within one log");
      }
      if (meta.evaluation && typeof meta.evaluation === "object") meta.evaluation = { ...meta.evaluation };
      let present = 0;
      let evaluationExtracted = false;
      const replace: JsonRecord = {};
      const changed = new Map<string, string>();
      for (const [index, { name, keys }] of partitions.entries()) {
        const container = keys.length === 1 ? meta : meta.evaluation as JsonRecord | undefined;
        const key = keys[keys.length - 1]!;
        if (!container || !Object.hasOwn(container, key)) continue;
        present |= 1 << index;
        const value = container[key];
        const serialized = JSON.stringify(value);
        if (serialized !== previous.get(name)) {
          replace[name] = value;
          changed.set(name, serialized);
        }
        delete container[key];
        evaluationExtracted ||= keys.length === 2;
      }
      if (evaluationExtracted && Object.keys(meta.evaluation as JsonRecord).length === 0) delete meta.evaluation;
      await write({ meta, present, ...(changed.size ? { replace } : {}) });
      for (const [name, serialized] of changed) previous.set(name, serialized);
    },
    async close(): Promise<void> {
      gzip.end();
      await completion;
    },
  };
}
