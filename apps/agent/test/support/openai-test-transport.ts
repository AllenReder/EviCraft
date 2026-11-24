import { responsesSse, sseResponse } from "./model-stream-fixtures.js";
import type { LanguageModel } from "ai";
import { vi } from "vitest";

import { createConfiguredLanguageModel } from "../../src/harness/model-route.js";

export interface OpenAiToolCallFixture {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface OpenAiResponseFixture {
  readonly content?: string | null;
  readonly reasoning?: Readonly<{ id: string; encryptedContent: string; summary: readonly string[] }>;
  readonly toolCalls?: readonly OpenAiToolCallFixture[];
  readonly error?: Readonly<{ statusCode: number; code: string; message: string }>;
}

export interface OpenAiTestTransport {
  readonly model: LanguageModel;
  readonly requests: readonly Readonly<Record<string, unknown>>[];
  readonly urls: readonly string[];
}

/** Uses the production OpenAI route with mock HTTP. Call vi.unstubAllGlobals/Envs after each test. */
export function createOpenAiTestTransport(
  fixtures: readonly OpenAiResponseFixture[],
): OpenAiTestTransport {
  const pending = [...fixtures];
  const requests: Readonly<Record<string, unknown>>[] = [];
  const urls: string[] = [];
  vi.stubEnv("OPENAI_BASE_URL", "https://openai.test/v1");
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
    urls.push(String(input));
    requests.push(JSON.parse(String(init.body)));
    const fixture = pending.shift();
    if (fixture === undefined) throw new Error("OpenAI test transport ran out of responses");
    if (fixture.error !== undefined) {
      return Response.json({
        error: { message: fixture.error.message, type: "invalid_request_error", code: fixture.error.code },
      }, { status: fixture.error.statusCode, headers: { "retry-after-ms": "1" } });
    }
    return sseResponse(responsesSse({
      id: `resp_${requests.length}`,
      object: "response",
      created_at: 1_700_000_000 + requests.length,
      model: "gpt-test",
      status: "completed",
      output: [
        ...(fixture.reasoning === undefined ? [] : [{
          type: "reasoning", id: fixture.reasoning.id, encrypted_content: fixture.reasoning.encryptedContent,
          summary: fixture.reasoning.summary.map(text => ({ type: "summary_text", text })),
        }]),
        ...(fixture.content == null ? [] : [{
          type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed",
          content: [{ type: "output_text", text: fixture.content, annotations: [] }],
        }]),
        ...(fixture.toolCalls ?? []).map(call => ({
          type: "function_call", id: `fc_${call.id}`, call_id: call.id,
          name: call.name, arguments: JSON.stringify(call.input), status: "completed",
        })),
      ],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    }));
  });
  return {
    model: createConfiguredLanguageModel({
      provider: "openai", model: "gpt-test", limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
    }, { modelApiKey: "test-key" }),
    requests,
    urls,
  };
}
