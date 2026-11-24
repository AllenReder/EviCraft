# Observation log encoding

Survival and Discovery use a single encoding, `observation-partition-replace`, version `1`. The file is each
Attempt's `task/observations.jsonl.gz`. Older full JSONL logs must be converted first; scoring does not read
the old format. The decoded logical observation schema is `2`: there are only `initial` and `scheduled`
samples, and every sample carries `elapsedTick`. The encoding name, version, and partition order are defined
once in [observation-format.json](./observation-format.json), which both the TypeScript writer and the
Python decoder read.

## Partitions and writing

The fixed partitions are numbered in this order:

1. `actor`: dimension, position, orientation, health, hunger, and other state.
2. `inventory`: every slot, main hand and off hand, equipment, item counts, durability, and components.
3. `evaluation.location`: biome, containing structures, and their bounds.
4. `evaluation.advancements`: every advancement and criterion state.
5. `evaluation.nearbyPortals`: scan range, candidate portals, their state, position, and block evidence.
6. `actorDeathCount`.

The first line holds the encoding identity and the fixed Attempt information:

```json
{
  "encoding": "observation-partition-replace",
  "encodingVersion": 1,
  "partitions": ["actor", "inventory", "evaluation.location", "evaluation.advancements", "evaluation.nearbyPortals", "actorDeathCount"],
  "static": {"schemaVersion": "2", "attempt": {}}
}
```

In a real file, `attempt` holds the Attempt's full identity. Each raw sample then becomes one encoded record:

```text
{
  meta: { kind, capturedAt, elapsedTick, receipt },
  present: 63,
  replace: { "inventory": { ...the full inventory at this sample... } }
}
```

`meta` keeps the sample metadata and any fields outside the partitions. `present` is a bitmap of the
partitions present in this observation, with the lowest bit for `actor`: 63 when all six are present, 0 when
the capture failed. `replace` holds only the partitions that differ from the last known value, each replaced
whole. A partition's first appearance is always written; with no change, `replace` is omitted. The encoding
does not filter, sort, or normalize facts.

The decoder fills in current state only for the partitions marked present. `null` is an explicit value; an
`unavailable` value replaces the earlier `ok`/`value` as a whole. An error record neither inherits earlier
facts nor clears the cache. Every record updates the decoder state, so no record can be skipped before
decoding.

The Runtime takes the samples. `benchmark.run.start` returns the initial sample at elapsed tick 0; after that
the Runtime pushes a scheduled sample every `sampleIntervalTicks` (default 20) game ticks and once more on the
budget tick. Each time the world comes to rest (no action or wait needs game time, and a tick ran or a Tool
call finished since it last came to rest), it pushes one more, also recorded as `scheduled`, carrying the
tick the world stopped on, which may equal the tick of the sample before it. A sample with no change still
keeps a small metadata record. The writer uses gzip level 1 with `Z_SYNC_FLUSH` after each record and
finishes the gzip stream at the end. Every file is newly created; a new encoding is never appended to an
existing file.

## Converting older logs

```bash
node tasks/minecraft-common/tools/convert-observations.mjs \
  --input /absolute/path/to/old-observations.jsonl.gz \
  --output /absolute/path/to/observations.partition-replace-v1.jsonl.gz
```

The input is JSONL or gzip with at least one full observation in the old format; the output must be a new
file. The converter reuses the Runtime-side writer, keeps every sample and field, and never deletes,
overwrites, or renames the input. Lossless means the restored JSON fields and values are identical, not that
whitespace, number formatting, or gzip bytes are.

To stream-decode an encoded file into full JSONL for inspection or other analysis:

```bash
python3 tasks/minecraft-common/observation_codec.py \
  /absolute/path/to/observations.partition-replace-v1.jsonl.gz
```

## Scoring inputs

Scoring opens only the standard `task/observations.jsonl.gz` and decodes it into full observations before
applying the scoring rules. `rawLogSha256` is computed over the decompressed bytes, including the header and
every encoded record, so it changes when a log is converted. `score.json` and `curve.json` record
`observationEncoding` and `observationEncodingVersion`.
