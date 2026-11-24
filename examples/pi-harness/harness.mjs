#!/usr/bin/env node
// A Harness built on the pi agent loop (https://github.com/badlogic/pi-mono). It hands every Runtime Tool to the
// model as it is, and pi owns the model calls and the tool loop. No plan, no skills: it shows how little glue an
// existing agent framework needs, not how to score well.
import { readFileSync } from "node:fs";
import { Agent } from "@mariozechner/pi-agent-core";
import { RuntimeClient } from "@evicraft/runtime-sdk";

const task = JSON.parse(readFileSync(process.env.EVICRAFT_TASK_FILE, "utf8"));
const settings = { baseUrl: "http://127.0.0.1:30000/v1", model: "default", contextWindow: 128000, maxTokens: 8192, ...task.config };
const log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

const client = await RuntimeClient.connect({ url: task.runtime.url, bearerToken: process.env.EVICRAFT_RUNTIME_BEARER_TOKEN });
const text = (result) => ({ content: [{ type: "text", text: JSON.stringify(result) }], details: result });

// A Runtime Tool already has a name, a description and a JSON Schema: that is all a pi tool needs.
async function runtimeTools() {
  return (await client.toolList()).tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_toolCallId, params, signal) {
      const call = client.startToolCall(tool.name, params);
      const cancel = () => void client.taskCancel(call.taskId).catch(() => {});
      signal?.addEventListener("abort", cancel, { once: true });
      try { return text(await call.result); } finally { signal?.removeEventListener("abort", cancel); }
    },
  }));
}

const tools = await runtimeTools();

const agent = new Agent({
  initialState: {
    systemPrompt: "You control a Minecraft player through tools. Game time passes only while a tool runs; "
      + "call wait to let time pass. Act with tools until told to stop.",
    model: { id: settings.model, name: settings.model, api: "openai-completions", provider: "local", baseUrl: settings.baseUrl,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: settings.contextWindow, maxTokens: settings.maxTokens },
    tools,
  },
  getApiKey: () => process.env.OPENAI_API_KEY ?? "none",
  // One body, one action at a time.
  toolExecution: "sequential",
});
agent.subscribe((event) => {
  if (event.type === "tool_execution_start") log({ event: "tool", name: event.toolName, args: event.args });
  if (event.type === "tool_execution_end") log({ event: "tool_result", name: event.toolName, error: event.isError });
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; agent.abort(); client.close(); });
client.onDisconnect(() => { stopping = true; agent.abort(); });

log({ event: "started", tools: tools.length, model: settings.model });
for (let turn = 0; !stopping; turn++) {
  await agent.prompt(turn === 0 ? task.assignment : "Continue with the task.");
  if (stopping) break;
  if (agent.state.errorMessage) log({ event: "model_error", message: agent.state.errorMessage });
  // The model answered without acting (or failed). Let a second of game time pass before asking again,
  // so a run always moves forward.
  await client.toolCall("wait", { ticks: 20 }).catch(() => {});
}
log({ event: "stopped" });
process.exit(0);
