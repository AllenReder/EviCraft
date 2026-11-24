import { chatSse, sseResponse } from "./model-stream-fixtures.js";
import { createDeepSeek } from "@ai-sdk/deepseek";

export interface DeepSeekToolCallFixture {
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

export interface DeepSeekResponseFixture {
  readonly reasoning?: string;
  readonly content?: string | null;
  readonly toolCalls?: readonly DeepSeekToolCallFixture[];
  readonly error?: Readonly<{ statusCode: number; code: string; message: string }>;
}

export interface DeepSeekTestTransport {
  readonly model: ReturnType<ReturnType<typeof createDeepSeek>>;
  readonly requests: readonly Readonly<Record<string, unknown>>[];
}

export function createDeepSeekTestTransport(
  fixtures: readonly DeepSeekResponseFixture[],
): DeepSeekTestTransport {
  const pending = [...fixtures];
  const requests: Readonly<Record<string, unknown>>[] = [];
  const provider = createDeepSeek({
    apiKey: "test-key",
    baseURL: "https://deepseek.test/v1",
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
      requests.push(request);
      const fixture = pending.shift();
      if (fixture === undefined) throw new Error("DeepSeek test transport ran out of responses");
      if (fixture.error !== undefined) {
        return Response.json({ error: { code: fixture.error.code, message: fixture.error.message } }, {
          status: fixture.error.statusCode,
        });
      }

      return sseResponse(chatSse({
        id: `response-${requests.length}`,
        object: "chat.completion",
        created: 1_700_000_000 + requests.length,
        model: "deepseek-v4-flash",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: fixture.content ?? null,
            reasoning_content: fixture.reasoning ?? null,
            tool_calls: fixture.toolCalls?.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          finish_reason: fixture.toolCalls === undefined ? "stop" : "tool_calls",
        }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }));
    },
  });

  return { model: provider("deepseek-v4-flash"), requests };
}
