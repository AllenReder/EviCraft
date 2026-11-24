#!/usr/bin/env node
// An OpenAI-compatible chat-completions endpoint that answers from a fixed script, for checking a Harness
// against a live Runtime without a model. Usage: mock-model-server.mjs <port> [script.json]
// The script is a list of turns; each turn is { tool, arguments } or { raw } (a raw arguments string, to send
// malformed JSON) or { text } (an answer without a tool call). The last turn repeats.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 30111);
const turns = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], "utf8")) : [
  { tool: "run_code", arguments: { description: "Wait two seconds of game time", code: "await abilities.wait({ seconds: 2 }); return 'waited';" } },
];
let served = 0;

createServer(async (request, response) => {
  if (request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "mock" }] })); return; }
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const turn = turns[Math.min(served, turns.length - 1)];
  const index = ++served;
  console.log(JSON.stringify({ request: index, messages: input.messages?.length, bytes: body.length, tools: input.tools?.length,
    last: String(input.messages?.at(-1)?.content ?? "").slice(0, 160), answer: turn.tool ?? (turn.raw === undefined ? "text" : "raw") }));
  const chunk = (delta, finish = null, usage) => `data: ${JSON.stringify({ id: `mock-${index}`, object: "chat.completion.chunk", created: 0, model: input.model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (turn.text !== undefined) response.write(chunk({ role: "assistant", content: turn.text }));
  else response.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${index}`, type: "function",
    function: { name: turn.tool ?? "run_code", arguments: turn.raw ?? JSON.stringify(turn.arguments ?? {}) } }] }));
  const promptTokens = Math.ceil(body.length / 4);
  response.write(chunk({}, turn.text !== undefined ? "stop" : "tool_calls", { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 }));
  response.end("data: [DONE]\n\n");
}).listen(port, "127.0.0.1", () => console.log(JSON.stringify({ listening: port, turns: turns.length })));
