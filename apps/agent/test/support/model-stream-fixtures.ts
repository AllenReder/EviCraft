/** Wire fixtures shared by HTTP transport tests; production always requests SSE. */
export function sseBody(events: readonly unknown[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

interface ChatResponse {
  id: string;
  model: string;
  created?: number;
  choices: readonly {
    index: number;
    message: { role: string; content?: string | null; reasoning_content?: string | null;
      tool_calls?: readonly { id?: string; type: string; function: { name?: string; arguments?: string } }[] };
    finish_reason: string;
  }[];
  usage?: unknown;
  object?: string;
}

export function chatSse(body: ChatResponse): string {
  const metadata = { id: body.id, model: body.model, created: body.created ?? 0, object: "chat.completion.chunk" };
  return sseBody([
    { ...metadata, choices: body.choices.map(choice => ({ index: choice.index, delta: { ...choice.message,
      tool_calls: choice.message.tool_calls?.map((call, index) => ({ ...call, index })) }, finish_reason: null })) },
    { ...metadata, choices: body.choices.map(choice => ({ index: choice.index, delta: {}, finish_reason: choice.finish_reason })), usage: body.usage },
  ]);
}

interface OutputItem {
  type: string;
  id: string;
  role?: string;
  status?: string;
  content?: readonly { type: string; text: string; annotations: readonly unknown[] }[];
  summary?: readonly { type: string; text: string }[];
  encrypted_content?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}
interface ResponsesResponse {
  id: string;
  created_at: number;
  model: string;
  status: string;
  object?: string;
  output: readonly OutputItem[];
  usage: unknown;
}

export function responsesSse(body: ResponsesResponse): string {
  const events: unknown[] = [{ type: "response.created", response: { ...body, output: [], status: "in_progress" } }];
  body.output.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item: { ...item, content: [], summary: [], arguments: "" } });
    if (item.type === "message") {
      item.content?.forEach((part, content_index) => {
        events.push({ type: "response.content_part.added", item_id: item.id, output_index, content_index, part: { ...part, text: "" } },
          { type: "response.output_text.delta", item_id: item.id, output_index, content_index, delta: part.text },
          { type: "response.output_text.done", item_id: item.id, output_index, content_index, text: part.text });
      });
    } else if (item.type === "reasoning") {
      item.summary?.forEach((part, summary_index) => {
        events.push({ type: "response.reasoning_summary_part.added", item_id: item.id, output_index, summary_index, part: { ...part, text: "" } },
          { type: "response.reasoning_summary_text.delta", item_id: item.id, output_index, summary_index, delta: part.text },
          { type: "response.reasoning_summary_part.done", item_id: item.id, output_index, summary_index, part });
      });
    } else if (item.type === "function_call") {
      events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({ type: "response.completed", response: body });
  return sseBody(events);
}

export function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
