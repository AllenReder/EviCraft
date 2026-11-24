import { chatSse, sseResponse } from "./model-stream-fixtures.js";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export interface OpenAiCompatibleToolCallFixture {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface OpenAiCompatibleResponseFixture {
  readonly content?: string | null;
  readonly toolCalls?: readonly OpenAiCompatibleToolCallFixture[];
  readonly error?: Readonly<{ statusCode: number; code: string; message: string }>;
}

export interface OpenAiCompatibleTestTransport {
  readonly model: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>;
  readonly requests: readonly Readonly<Record<string, unknown>>[];
  readonly urls: readonly string[];
  readonly authorizationHeaders: readonly string[];
}

/** Fake HTTP transport for a configured OpenAI-compatible AI SDK Provider. */
export function createOpenAiCompatibleTestTransport(
  fixtures: readonly OpenAiCompatibleResponseFixture[],
  options: Readonly<{ name: string; baseUrl: string; apiKey?: string }>,
): OpenAiCompatibleTestTransport {
  const pending = [...fixtures];
  const requests: Readonly<Record<string, unknown>>[] = [];
  const urls: string[] = [];
  const authorizationHeaders: string[] = [];
  const provider = createOpenAICompatible({
    name: options.name,
    baseURL: options.baseUrl,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    fetch: async (input, init) => {
      urls.push(String(input));
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== null) authorizationHeaders.push(authorization);
      const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
      requests.push(request);
      const fixture = pending.shift();
      if (fixture === undefined) throw new Error("OpenAI-compatible test transport ran out of responses");
      if (fixture.error !== undefined) {
        return Response.json({
          error: { message: fixture.error.message, type: "invalid_request_error", code: fixture.error.code },
        }, { status: fixture.error.statusCode });
      }
      return sseResponse(chatSse({
        id: `response-${requests.length}`,
        object: "chat.completion",
        created: 1_700_000_000 + requests.length,
        model: "compatible-test",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: fixture.content ?? null,
            ...(fixture.toolCalls === undefined ? {} : {
              tool_calls: fixture.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }),
          },
          finish_reason: fixture.toolCalls === undefined ? "stop" : "tool_calls",
        }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }));
    },
  });
  return {
    model: provider.chatModel("compatible-test"),
    requests,
    urls,
    authorizationHeaders,
  };
}
