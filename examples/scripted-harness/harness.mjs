#!/usr/bin/env node
// A complete Harness in one file, with no model: it shows everything the benchmark asks of a Harness process.
//
//   EVICRAFT_TASK_FILE             JSON: { assignment, bot, runtime: { url }, outputDirectory, config }
//   EVICRAFT_RUNTIME_URL           the Runtime endpoint (the same value as runtime.url in the task file)
//   EVICRAFT_RUNTIME_BEARER_TOKEN  the credential for that endpoint
//
// The Bot already exists. Play until SIGINT or SIGTERM arrives; the benchmark sends it when the tick budget ends.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { RuntimeClient } from "@evicraft/runtime-sdk";

const task = JSON.parse(readFileSync(process.env.EVICRAFT_TASK_FILE, "utf8"));
const settings = { thinkMs: 1000, waitTicks: 40, ...task.config };
const log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

const client = await RuntimeClient.connect({ url: task.runtime.url, bearerToken: process.env.EVICRAFT_RUNTIME_BEARER_TOKEN });
const info = await client.runtimeInfo();
const tools = (await client.toolList()).tools.map((tool) => tool.name);
log({ event: "connected", assignment: task.assignment, bot: task.bot, pauseWhenIdle: info.pause_when_idle, tools: tools.length });

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; client.close(); });
client.onOccurrence((occurrence) => log({ event: "occurrence", type: occurrence.type, tick: occurrence.server_tick }));

try {
  for (let step = 1; !stopping; step++) {
    // "Thinking". With pause-when-idle the world stands still here, however long this takes.
    const before = await client.observe();
    await sleep(settings.thinkMs);
    const afterThinking = await client.observe();
    // Acting. Game time passes only while a tool call like this one is in progress.
    const self = await client.toolCall("get_self_status", {});
    const waited = await client.toolCall("wait", { ticks: settings.waitTicks });
    const afterActing = await client.observe();
    log({ event: "step", step, ticksWhileThinking: afterThinking.server_tick - before.server_tick,
      ticksWhileActing: afterActing.server_tick - afterThinking.server_tick, waited: waited.success,
      health: self.data?.health, position: self.data?.position });
  }
} catch (error) {
  if (!stopping) throw error;
}
log({ event: "stopped" });
