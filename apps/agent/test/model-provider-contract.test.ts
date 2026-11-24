import { chatSse, responsesSse, sseResponse } from "./support/model-stream-fixtures.js";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import { ModelContextOverflowError, ModelProviderError } from "../src/harness/model-surface-message.js";
import { createConfiguredLanguageModel } from "../src/harness/model-route.js";
import { createDeepSeekTestTransport } from "./support/deepseek-test-transport.js";
import { createOpenAiCompatibleTestTransport } from "./support/openai-compatible-test-transport.js";
import { createOpenAiTestTransport } from "./support/openai-test-transport.js";

const limits = { contextWindowTokens: 200_000, maxOutputTokens: 512 };
const inspectTool = {
  name: "inspect",
  description: "Inspect one named target.",
  inputSchema: {
    type: "object",
    properties: { target: { type: "string" } },
    required: ["target"],
    additionalProperties: false,
  },
};

describe("Model Provider protocol contract", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  describe("wire request shape", () => {
    it("sends OpenAI Responses to /responses with stateless settings", async () => {
      const transport = createOpenAiTestTransport([{ content: "ok" }]);
      await new AiSdkModelSession(transport.model, limits).complete({
        messages: [{ role: "user", content: "test" }],
        tools: [inspectTool],
      });
      expect(transport.urls).toEqual(["https://openai.test/v1/responses"]);
      expect(transport.requests[0]).toMatchObject({
        store: false,
        include: ["reasoning.encrypted_content"],
        parallel_tool_calls: false,
      });
    });

    it("sends DeepSeek Chat Completions to /chat/completions", async () => {
      const transport = createDeepSeekTestTransport([{ content: "ok" }]);
      await new AiSdkModelSession(transport.model, limits).complete({
        messages: [{ role: "user", content: "test" }],
        tools: [inspectTool],
      });
      expect(transport.requests[0]).toHaveProperty("messages");
      expect(transport.requests[0]).not.toHaveProperty("input");
    });

    it("sends compatible chat-completions to /chat/completions with Authorization", async () => {
      const transport = createOpenAiCompatibleTestTransport(
        [{ content: "ok" }],
        { name: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "test-key" },
      );
      await new AiSdkModelSession(transport.model, limits).complete({
        messages: [{ role: "user", content: "test" }],
        tools: [inspectTool],
      });
      expect(transport.urls).toEqual(["http://127.0.0.1:8000/v1/chat/completions"]);
      expect(transport.authorizationHeaders).toEqual(["Bearer test-key"]);
    });

    it("injects reasoning_effort for compatible chat-completions when configured", async () => {
      const transport = createOpenAiCompatibleTestTransport(
        [{ content: "ok" }],
        { name: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1" },
      );
      const route = {
        provider: "openai-compatible" as const,
        name: "local-vllm",
        model: "local-model",
        baseUrl: "http://127.0.0.1:8000/v1",
        protocol: "chat-completions" as const,
        limits,
        reasoningEffort: "high",
      };
      const model = createConfiguredLanguageModel(route, {});
      // Replace the model's fetch with the transport's by re-creating through the adapter.
      // This test verifies the route adapter wires reasoning_effort into the request body.
      let capturedBody: Record<string, unknown> = {};
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: unknown, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body));
        return sseResponse(chatSse({
          id: "test", created: 0, model: "test",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      };
      try {
        await new AiSdkModelSession(model, limits).complete({
          messages: [{ role: "user", content: "test" }],
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(capturedBody.reasoning_effort).toBe("high");
    });

    describe("tool schema typing for Moonshot routes", () => {
      const untypedTool = {
        name: "plan",
        description: "Update the plan.",
        inputSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "object", properties: {
              status: { enum: ["pending", "done"] },
              level: { enum: [1, 2] },
              ok: { const: true },
              mixed: { enum: ["a", 1] },
              kept: { type: "string", enum: ["x"] },
            } } },
          },
        },
      };

      async function capturedToolParameters(routeModel: string): Promise<Record<string, unknown>> {
        const route = {
          provider: "openai-compatible" as const,
          name: "magpie",
          model: routeModel,
          baseUrl: "http://127.0.0.1:3425/v1",
          protocol: "chat-completions" as const,
          limits,
          reasoningEffort: "high",
        };
        let capturedBody: { tools?: Array<{ function: { parameters: Record<string, unknown> } }>; reasoning_effort?: string } = {};
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (_input: unknown, init: RequestInit) => {
          capturedBody = JSON.parse(String(init.body));
          return sseResponse(chatSse({
            id: "test", created: 0, model: "test",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
        };
        try {
          await new AiSdkModelSession(createConfiguredLanguageModel(route, {}), limits).complete({
            messages: [{ role: "user", content: "test" }],
            tools: [untypedTool],
          });
        } finally {
          globalThis.fetch = originalFetch;
        }
        expect(capturedBody.reasoning_effort).toBe("high");
        return capturedBody.tools![0]!.function.parameters;
      }

      const itemProperties = (parameters: Record<string, unknown>) =>
        ((parameters.properties as any).items.items.properties) as Record<string, Record<string, unknown>>;

      it("adds the JSON Schema type to untyped enum and const nodes for Kimi models", async () => {
        const properties = itemProperties(await capturedToolParameters("auto/kimi-k3.1-pro"));
        expect(properties.status).toEqual({ type: "string", enum: ["pending", "done"] });
        expect(properties.level).toEqual({ type: "integer", enum: [1, 2] });
        expect(properties.ok).toEqual({ type: "boolean", const: true });
        expect(properties.mixed).toEqual({ type: ["string", "integer"], enum: ["a", 1] });
        expect(properties.kept).toEqual({ type: "string", enum: ["x"] });
      });

      it("leaves tool schemas unchanged for other models", async () => {
        const properties = itemProperties(await capturedToolParameters("local-model"));
        expect(properties.status).toEqual({ enum: ["pending", "done"] });
        expect(properties.ok).toEqual({ const: true });
      });
    });

    it("sends compatible Responses to /responses with stateless settings", async () => {
      const transport = createOpenAiCompatibleTestTransport(
        [{ content: "ok" }],
        { name: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1" },
      );
      const route = {
        provider: "openai-compatible" as const,
        name: "local-vllm",
        model: "local-model",
        baseUrl: "http://127.0.0.1:8000/v1",
        protocol: "responses" as const,
        limits,
      };
      const model = createConfiguredLanguageModel(route, { modelApiKey: "test-key" });
      let capturedBody: Record<string, unknown> = {};
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: unknown, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body));
        return sseResponse(responsesSse({
          id: "resp_test", object: "response", created_at: 1700000000, model: "local-model",
          status: "completed",
          output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }));
      };
      try {
        await new AiSdkModelSession(model, limits).complete({
          messages: [{ role: "user", content: "test" }],
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(capturedBody).toMatchObject({
        store: false,
        include: ["reasoning.encrypted_content"],
        parallel_tool_calls: false,
      });
    });

    it("requests encrypted reasoning on the compatible Responses route", async () => {
      const route = {
        provider: "openai-compatible" as const,
        name: "local-vllm",
        model: "local-model",
        baseUrl: "http://127.0.0.1:8000/v1",
        protocol: "responses" as const,
        limits,
      };
      const model = createConfiguredLanguageModel(route, { modelApiKey: "test-key" });
      let capturedBody: Record<string, unknown> = {};
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_input: unknown, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body));
        return sseResponse(responsesSse({
          id: "resp_rs", object: "response", created_at: 1700000000, model: "local-model",
          status: "completed",
          output: [
            { type: "reasoning", id: "rs_1", encrypted_content: "enc-data", summary: [] },
            { type: "message", id: "msg_1", role: "assistant", status: "completed",
              content: [{ type: "output_text", text: "done", annotations: [] }] },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }));
      };
      try {
        await new AiSdkModelSession(model, limits).complete({
          messages: [{ role: "user", content: "test" }],
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(capturedBody.include).toEqual(["reasoning.encrypted_content"]);
    });
  });

  describe("tool definition serialization", () => {
    it("serializes tool schema for OpenAI Responses", async () => {
      const transport = createOpenAiTestTransport([{ content: "ok" }]);
      await new AiSdkModelSession(transport.model, limits).complete({
        messages: [{ role: "user", content: "test" }],
        tools: [inspectTool],
      });
      expect(transport.requests[0]).toMatchObject({
        tools: [{ type: "function", name: "inspect" }],
      });
    });

    it("serializes tool schema for DeepSeek", async () => {
      const transport = createDeepSeekTestTransport([{ content: "ok" }]);
      await new AiSdkModelSession(transport.model, limits).complete({
        messages: [{ role: "user", content: "test" }],
        tools: [inspectTool],
      });
      expect(transport.requests[0]).toMatchObject({
        tools: [{ type: "function", function: { name: "inspect" } }],
      });
    });
  });

  describe("multi-turn message replay", () => {
    it("replays assistant reasoning and tool result for DeepSeek", async () => {
      const transport = createDeepSeekTestTransport([
        {
          reasoning: "I should inspect the furnace.",
          toolCalls: [{ id: "call-1", name: "inspect", arguments: '{"target":"furnace"}' }],
        },
        { content: "done" },
      ]);
      const session = new AiSdkModelSession(transport.model, limits);
      const user = { role: "user" as const, content: "Inspect the furnace." };

      const first = await session.complete({ messages: [user], tools: [inspectTool] });
      await session.complete({
        messages: [
          user,
          first.message,
          { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "call-1", toolName: "inspect", output: { type: "text" as const, value: "furnace ready" } }] },
        ],
        tools: [inspectTool],
      });

      expect(transport.requests[1]).toMatchObject({
        messages: [
          { role: "user", content: "Inspect the furnace." },
          {
            role: "assistant",
            reasoning_content: "I should inspect the furnace.",
            tool_calls: [{ id: "call-1", function: { name: "inspect", arguments: '{"target":"furnace"}' } }],
          },
          { role: "tool", tool_call_id: "call-1", content: "furnace ready" },
        ],
      });
    });
  });

  describe("representative failures", () => {
    it.each([
      [400, "invalid_request_error"],
      [401, "authentication_error"],
      [403, "permission_error"],
      [404, "not_found"],
      [409, "conflict"],
    ])("does not retry fatal HTTP %s", async (status, code) => {
      const transport = createDeepSeekTestTransport([
        { error: { statusCode: status, code, message: `HTTP ${status}` } },
      ]);
      await expect(
        new AiSdkModelSession(transport.model, limits).complete({
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toMatchObject({ category: "fatal_http", statusCode: status });
      expect(transport.requests).toHaveLength(1);
    });

    it("retries 408 request timeout exactly twice before succeeding", async () => {
      const transport = createDeepSeekTestTransport([
        { error: { statusCode: 408, code: "request_timeout", message: "Request timed out" } },
        { error: { statusCode: 408, code: "request_timeout", message: "Request timed out" } },
        { content: "recovered" },
      ]);
      const decision = await new AiSdkModelSession(transport.model, limits).complete({
        messages: [{ role: "user", content: "test" }],
      });
      expect(decision.message).toBeDefined();
      expect(transport.requests).toHaveLength(3);
    });

    it("retries 429 exactly twice before succeeding", async () => {
      const transport = createDeepSeekTestTransport([
        { error: { statusCode: 429, code: "rate_limit", message: "slow down" } },
        { error: { statusCode: 429, code: "rate_limit", message: "slow down" } },
        { content: "recovered" },
      ]);
      const decision = await new AiSdkModelSession(transport.model, limits).complete({
        messages: [{ role: "user", content: "test" }],
      });
      expect(decision.message).toBeDefined();
      expect(transport.requests).toHaveLength(3);
    });

    it("retries 500 as often as configured before failing", async () => {
      const transport = createDeepSeekTestTransport([
        { error: { statusCode: 500, code: "internal", message: "server error" } },
        { error: { statusCode: 500, code: "internal", message: "server error" } },
        { error: { statusCode: 500, code: "internal", message: "server error" } },
      ]);
      await expect(
        new AiSdkModelSession(transport.model, { ...limits, retries: 2, retryMaxDelayMs: 1 }).complete({
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toMatchObject({ category: "transient_http", statusCode: 500, attempts: 3 });
      expect(transport.requests).toHaveLength(3);
    });

    it("recognizes context overflow without consuming ordinary retries", async () => {
      const transport = createDeepSeekTestTransport([
        { error: { statusCode: 400, code: "context_length_exceeded", message: "Context window exceeded" } },
      ]);
      await expect(
        new AiSdkModelSession(transport.model, limits).complete({
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toBeInstanceOf(ModelContextOverflowError);
      expect(transport.requests).toHaveLength(1);
    });

    it("recognizes a LiteLLM context overflow reported with a generic 400 code", async () => {
      const transport = createOpenAiCompatibleTestTransport([
        { error: {
          statusCode: 400,
          code: "invalid_request_error",
          message: "OpenAIException - Requested token count exceeds the model's maximum context length of 262144 tokens. You requested a total of 263511 tokens.",
        } },
      ], { name: "local-proxy", baseUrl: "http://127.0.0.1:4000/v1", apiKey: "test-key" });
      await expect(
        new AiSdkModelSession(transport.model, limits).complete({
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toBeInstanceOf(ModelContextOverflowError);
      expect(transport.requests).toHaveLength(1);
    });
  });
});
