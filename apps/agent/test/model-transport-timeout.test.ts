import { chatSse } from "./support/model-stream-fixtures.js";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import { createConfiguredLanguageModel } from "../src/harness/model-route.js";

const originalDispatcher = getGlobalDispatcher();
let dispatcher: Agent | undefined;
let server: Server | undefined;
const timers = new Set<ReturnType<typeof setTimeout>>();
afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  await dispatcher?.destroy();
});

async function fixture(headersFirst = false, requestTimeoutMs = 5000) {
  // Scale the hidden five-minute timeout down; use real sockets and the production Adapter.
  dispatcher = new Agent({ headersTimeout: 100, bodyTimeout: 100 });
  setGlobalDispatcher(dispatcher);
  let requests = 0;
  server = createServer((request, response) => {
    requests++;
    request.resume();
    if (headersFirst) { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (response.destroyed) return;
      if (!headersFirst) response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chatSse({ id: "response", model: "local", choices: [{ index: 0,
        message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }, 1500);
    timers.add(timer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const limits = { contextWindowTokens: 128000, maxOutputTokens: 4096, requestTimeoutMs };
  const model = createConfiguredLanguageModel({ provider: "openai-compatible", name: "local", model: "local",
    protocol: "chat-completions", baseUrl, limits }, {});
  return { session: new AiSdkModelSession(model, limits), baseUrl, requests: () => requests };
}
const input = { messages: [{ role: "user" as const, content: "test" }] };

describe("model transport deadline ownership", () => {
  it.each([false, true])("waits past the transport default with headersFirst=%s", async headersFirst => {
    const test = await fixture(headersFirst);
    await expect(test.session.complete(input)).resolves.toMatchObject({ message: { role: "assistant" } });
    expect(test.requests()).toBe(1);
    expect(getGlobalDispatcher()).toBe(dispatcher);
    // Ordinary fetch still has its original lower timeout; only model requests override it.
    await expect(fetch(test.baseUrl).then(response => response.text())).rejects.toMatchObject({
      cause: { code: headersFirst ? "UND_ERR_BODY_TIMEOUT" : "UND_ERR_HEADERS_TIMEOUT" },
    });
  });

  it("still enforces the Model Session deadline without retrying", async () => {
    const test = await fixture(false, 100);
    await expect(test.session.complete(input)).rejects.toMatchObject({ category: "timeout", attempts: 1 });
    expect(test.requests()).toBe(1);
  });

  it("still honours caller cancellation while reading a response body", async () => {
    const test = await fixture(true);
    const controller = new AbortController();
    const pending = test.session.complete(input, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    timers.add(timer);
    await expect(pending).rejects.toMatchObject({ category: "cancelled", attempts: 1 });
    expect(test.requests()).toBe(1);
  });
});
