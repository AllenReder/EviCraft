#!/usr/bin/env node
// A committed entry point, so `npm ci` can link the command before `npm run build` produces dist/.
import { existsSync } from "node:fs";
const entry = new URL("../dist/index.js", import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write("evicraft is not built yet: run `npm run build` in the repository root first\n");
  process.exit(1);
}
await import(entry.href);
