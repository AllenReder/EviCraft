import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";

import { validateHarnessConfig, type ModelProvider } from "../src/harness/config.js";
import { modelProviderAdapter } from "../src/harness/model-provider-adapter.js";
import { createConfiguredLanguageModel } from "../src/harness/model-route.js";

describe("Model Route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, "high"])("sends compatible reasoning effort %s without changing the default", async reasoningEffort => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "test", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    }));
    const config = validateHarnessConfig({ model: {
      provider: "openai-compatible", name: "test", baseUrl: "https://example.test/v1", model: "test",
      protocol: "chat-completions",
      limits: { contextWindowTokens: 8192, maxOutputTokens: 1024 },
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    } });
    await generateText({ model: createConfiguredLanguageModel(config.model, {}), prompt: "test", maxRetries: 0 });
    expect(requestBody.reasoning_effort).toBe(reasoningEffort);
    expect(Object.hasOwn(requestBody, "reasoning_effort")).toBe(reasoningEffort !== undefined);
  });

  describe.each(["openai", "openai-compatible"] as const)("%s Responses reasoning effort", provider => {
    it.each([undefined, "high"])("maps effort %s while preserving stateless settings", async reasoningEffort => {
      let requestBody: Record<string, unknown> = {};
      vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return Response.json({ id: "resp_test", created_at: 0, model: "gpt-6.1-sol", status: "completed",
          output: [{ type: "message", id: "msg_test", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }));
      const config = validateHarnessConfig({ model: {
        provider, model: "gpt-6.1-sol", limits: { contextWindowTokens: 8192, maxOutputTokens: 1024 },
        ...(provider === "openai-compatible" ? {
          name: "relay", baseUrl: "https://example.test/v1", protocol: "responses",
        } : {}),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      } });
      expect(config.model).toMatchObject(reasoningEffort === undefined ? {} : { reasoningEffort });
      await generateText({ model: createConfiguredLanguageModel(config.model, { modelApiKey: "test-key" }),
        prompt: "test", maxRetries: 0 });
      expect(requestBody).toMatchObject({ store: false, include: ["reasoning.encrypted_content"], parallel_tool_calls: false });
      if (reasoningEffort === undefined) expect(requestBody).not.toHaveProperty("reasoning");
      else expect(requestBody.reasoning).toMatchObject({ effort: reasoningEffort });
      expect(requestBody).not.toHaveProperty("reasoning_effort");
    });

    it("keeps one prompt cache key per model and separates models", async () => {
      const keys: unknown[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
        keys.push(JSON.parse(String(init.body)).prompt_cache_key);
        return Response.json({ id: "resp_test", created_at: 0, model: "gpt-6.1-sol", status: "completed",
          output: [{ type: "message", id: "msg_test", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }));
      const { model: route } = validateHarnessConfig({ model: {
        provider, model: "gpt-6.1-sol", limits: { contextWindowTokens: 8192, maxOutputTokens: 1024 },
        ...(provider === "openai-compatible" ? {
          name: "relay", baseUrl: "https://example.test/v1", protocol: "responses",
        } : {}),
      } });
      const first = createConfiguredLanguageModel(route, { modelApiKey: "test-key" });
      const second = createConfiguredLanguageModel(route, { modelApiKey: "test-key" });
      for (const model of [first, first, second]) await generateText({ model, prompt: "test", maxRetries: 0 });
      expect(keys[0]).toEqual(expect.any(String));
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).toEqual(expect.any(String));
      expect(keys[2]).not.toBe(keys[0]);
    });
  });

  it.each<readonly [ModelProvider["provider"], ModelProvider, "auto" | "required"]>([
    ["openai", {
      provider: "openai",
      model: "gpt-test",
      limits: { contextWindowTokens: 8_192, maxOutputTokens: 1_024 },
    }, "required"],
    ["deepseek", {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      limits: { contextWindowTokens: 8_192, maxOutputTokens: 1_024 },
    }, "auto"],
    ["openai-compatible", {
      provider: "openai-compatible",
      name: "local",
      model: "local-test",
      baseUrl: "http://127.0.0.1:8080/v1",
      protocol: "chat-completions",
      limits: { contextWindowTokens: 8_192, maxOutputTokens: 1_024 },
    }, "required"],
  ])("declares the %s Tool policy through its Adapter capabilities", (_provider, route, expected) => {
    expect(modelProviderAdapter(route).capabilities.toolChoice).toBe(expected);
  });
});
