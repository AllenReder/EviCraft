#!/usr/bin/env node
// The Harness of a development world (`evicraft world`). The Runner starts it like any other Harness. It does not
// play: it publishes how to reach the world, then waits until the Runner stops it, so that `evicraft harness` can
// start the real Harness in a terminal as often as needed. It never connects to the Runtime, which takes one
// controller at a time.
import { rmSync, writeFileSync } from "node:fs";

const [stateFile] = process.argv.slice(2);
const { EVICRAFT_TASK_FILE: taskFile, EVICRAFT_RUNTIME_URL: runtimeUrl, EVICRAFT_RUNTIME_BEARER_TOKEN: bearerToken } = process.env;
if (!stateFile || !taskFile || !runtimeUrl || !bearerToken) throw new Error("harness-slot is started by `evicraft world`");

rmSync(stateFile, { force: true });
writeFileSync(stateFile, `${JSON.stringify({ taskFile, runtimeUrl, bearerToken }, null, 2)}\n`, { mode: 0o600 });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { rmSync(stateFile, { force: true }); process.exit(0); });
setInterval(() => {}, 2 ** 30);
