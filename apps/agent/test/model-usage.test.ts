import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import { validateHarnessConfig } from "../src/harness/config.js";
import { modelProviderAdapter } from "../src/harness/model-provider-adapter.js";
import { textMessage } from "../src/harness/model-surface-message.js";
import { chatSse, sseResponse } from "./support/model-stream-fixtures.js";

const route = {
  provider: "openai-compatible" as const, protocol: "chat-completions" as const,
  name: "local", model: "test", baseUrl: "http://provider.test/v1", reasoningEffort: "xhigh",
  limits: { contextWindowTokens: 262144, maxOutputTokens: 65536 },
};
const tools = [{ name: "wait", description: "Wait", inputSchema: { type: "object", properties: {} } }];

describe("Model usage without remote counting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])("generates directly and preserves cache-inclusive input usage (decision=%s)", async decision => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return sseResponse(chatSse({ id: "test", model: "test", created: 0,
        choices: [{ index: 0, message: { role: "assistant", content: "summary" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170,
          prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 5 } },
      }));
    }));
    const adapter = modelProviderAdapter(route);
    const session = new AiSdkModelSession(adapter.createModel(route, {}), route.limits, adapter.capabilities.toolChoice);
    const result = await session.complete({ messages: [textMessage("user", "Gather wood")],
      ...(decision ? { tools } : { maxOutputTokens: 16384 }) });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://provider.test/v1/chat/completions");
    expect(requests[0]?.body.max_tokens).toBe(decision ? 65536 : 16384);
    expect(requests[0]?.body.reasoning_effort).toBe("xhigh");
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 20, totalTokens: 170 });
    expect(result.reasoningTokens).toBe(5);
    expect(result.cacheReadTokens).toBe(100);
    expect(requests[0]?.body).not.toHaveProperty("prompt_cache_key");
  });

  it("rejects the removed tokenizer configuration instead of silently accepting it", () => {
    expect(validateHarnessConfig({ mode: "native", model: route }).model).toMatchObject({ model: "test" });
    expect(() => validateHarnessConfig({ mode: "native", model: { ...route, tokenCountUrl: "http://unused.test/tokenize" } }))
      .toThrow("tokenCountUrl");
  });
});
