import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import {
  messageReasoning,
  messageToolCalls,
  textMessage,
  toolResultMessage,
  type AgentToolProjection,
} from "../src/harness/model-surface-message.js";
import { createDeepSeekTestTransport } from "./support/deepseek-test-transport.js";
import { createOpenAiCompatibleTestTransport } from "./support/openai-compatible-test-transport.js";
import { createOpenAiTestTransport } from "./support/openai-test-transport.js";

const limits = { contextWindowTokens: 200_000, maxOutputTokens: 512 };
const inspectTool: AgentToolProjection = {
  name: "inspect",
  description: "Inspect one named target.",
  inputSchema: {
    type: "object",
    properties: { target: { type: "string" } },
    required: ["target"],
    additionalProperties: false,
  },
};

describe("AI SDK Provider conformance through the Model Session", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("normalizes an OpenAI Tool Call through the production Model Session", async () => {
    const transport = createOpenAiTestTransport([{
      toolCalls: [{ id: "openai-call", name: "inspect", input: { target: "furnace" } }],
    }]);

    const decision = await complete(transport.model, "Inspect the furnace.");

    expect(messageToolCalls(decision.message)).toEqual([{
      id: "openai-call",
      name: "inspect",
      arguments: '{"target":"furnace"}',
    }]);
    expect(decision.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  });

  it("normalizes a DeepSeek Tool Call through the production Model Session", async () => {
    const transport = createDeepSeekTestTransport([{
      reasoning: "I should inspect the furnace.",
      toolCalls: [{ id: "deepseek-call", name: "inspect", arguments: '{"target":"furnace"}' }],
    }]);

    const decision = await complete(transport.model, "Inspect the furnace.");

    expect(messageToolCalls(decision.message)).toEqual([{
      id: "deepseek-call",
      name: "inspect",
      arguments: '{"target":"furnace"}',
    }]);
    expect(messageReasoning(decision.message)).toBe("I should inspect the furnace.");
  });

  it("normalizes an OpenAI-compatible Tool Call through the production Model Session", async () => {
    const transport = createOpenAiCompatibleTestTransport([{
      toolCalls: [{ id: "compatible-call", name: "inspect", input: { target: "furnace" } }],
    }], { name: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1" });

    const decision = await complete(transport.model, "Inspect the furnace.");

    expect(messageToolCalls(decision.message)).toEqual([{
      id: "compatible-call",
      name: "inspect",
      arguments: '{"target":"furnace"}',
    }]);
  });

  it.each([
    ["malformed JSON arguments", { id: "bad-json", name: "inspect", arguments: '{"target":' }, "invalid_tool_call_arguments"],
    ["an empty Tool name", { id: "empty-name", name: "", arguments: "{}" }, "invalid_tool_call_name"],
    ["an unregistered Tool name", { id: "unknown-name", name: "inspect_inventory", arguments: "{}" }, "invalid_tool_call_name"],
  ] as const)("reports %s as a Tool Call issue instead of failing the request", async (_label, toolCall, code) => {
    const transport = createDeepSeekTestTransport([{ toolCalls: [toolCall] }]);

    const decision = await complete(transport.model, "Inspect the furnace.");

    expect(decision.toolCallIssue).toMatchObject({ code, toolName: toolCall.name });
  });

  it("preserves valid JSON with a Tool schema failure for later Harness settlement", async () => {
    const transport = createDeepSeekTestTransport([{
      toolCalls: [{ id: "schema-failure", name: "inspect", arguments: '{"target":7}' }],
    }]);

    const decision = await complete(transport.model, "Inspect the furnace.");

    expect(messageToolCalls(decision.message)).toEqual([{
      id: "schema-failure",
      name: "inspect",
      arguments: '{"target":7}',
    }]);
  });

  it("reduces ordered Tool Calls to the first and preserves DeepSeek continuation metadata", async () => {
    const transport = createDeepSeekTestTransport([
      {
        reasoning: "The furnace is the first target to inspect.",
        toolCalls: [
          { id: "first", name: "inspect", arguments: '{"target":"furnace"}' },
          { id: "second", name: "inspect", arguments: '{"target":"chest"}' },
        ],
      },
      { toolCalls: [{ id: "next", name: "inspect", arguments: '{"target":"chest"}' }] },
    ]);
    const session = new AiSdkModelSession(transport.model, limits);
    const user = textMessage("user", "Inspect the furnace, then the chest.");

    const first = await session.complete({ messages: [user], tools: [inspectTool] });

    expect(first.serialToolCallReduction).toEqual({ received: 2, retained: "first" });
    expect(messageToolCalls(first.message)).toEqual([{
      id: "first",
      name: "inspect",
      arguments: '{"target":"furnace"}',
    }]);
    expect(messageReasoning(first.message)).toBe("The furnace is the first target to inspect.");

    await session.complete({
      messages: [
        user,
        first.message,
        toolResultMessage("first", "inspect", '{"ok":true,"target":"furnace"}'),
      ],
      tools: [inspectTool],
    });

    expect(transport.requests[1]).toMatchObject({
      messages: [
        { role: "user", content: "Inspect the furnace, then the chest." },
        {
          role: "assistant",
          reasoning_content: "The furnace is the first target to inspect.",
          tool_calls: [{
            id: "first",
            function: { name: "inspect", arguments: '{"target":"furnace"}' },
          }],
        },
        {
          role: "tool",
          tool_call_id: "first",
          content: '{"ok":true,"target":"furnace"}',
        },
      ],
    });
    expect(JSON.stringify(transport.requests[1])).not.toContain("second");
  });
});

async function complete(model: LanguageModel, prompt: string) {
  return await new AiSdkModelSession(model, limits).complete({
    messages: [textMessage("user", prompt)],
    tools: [inspectTool],
  });
}
