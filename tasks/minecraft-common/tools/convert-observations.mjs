#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { createObservationLog } from '../observation-log.ts';

const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
if (!values.input || !values.output) {
  throw new Error('Usage: node convert-observations.mjs --input <old.jsonl[.gz]> --output <new.jsonl.gz>');
}
const input = resolve(values.input);
const output = resolve(values.output);
const source = createReadStream(input);
const stream = input.endsWith('.gz') ? source.pipe(createGunzip()) : source;
if (stream !== source) source.on('error', error => stream.destroy(error));
const lines = createInterface({ input: stream, crlfDelay: Infinity });
const reading = finished(stream);
void reading.catch(() => lines.close());
const writer = createObservationLog(output);
let records = 0;
try {
  for await (const line of lines) {
    const record = JSON.parse(line);
    if (record.schemaVersion !== '1' || !record.attempt) throw new Error('Expected full schema v1 observations');
    await writer.append(record);
    records++;
  }
  await reading;
  if (!records) throw new Error('Expected at least one full schema v1 observation');
} finally {
  lines.close();
  source.destroy();
  stream.destroy();
  await writer.close();
}
const before = (await stat(input)).size;
const after = (await stat(output)).size;
console.log(JSON.stringify({ input, output, records, inputBytes: before, outputBytes: after,
  reductionPercent: 100 * (1 - after / before) }, null, 2));
