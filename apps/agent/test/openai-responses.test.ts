import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import { loadSkillControl } from "../src/harness/control-tools.js";
import { HarnessRunEventLog } from "../src/harness/harness-run-event-log.js";
import { decisionCycle } from "./support/decision-cycle.js";
import { ModelSurface } from "../src/harness/model-surface.js";
import { messageToolCalls, textMessage, toolResultMessage } from "../src/harness/model-surface-message.js";
import { projectToolContract } from "../src/harness/tool-contract.js";
import { createOpenAiTestTransport } from "./support/openai-test-transport.js";

const limits = { contextWindowTokens: 200_000, maxOutputTokens: 32_768 };
const inspect = {
  name: "inspect", description: "Inspect a target.",
  inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
};
const call = (id: string) => ({ id, name: "inspect", input: { target: "furnace" } });

describe("configured OpenAI Responses history", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  it("preserves the load_skill non-strict contract and omission of its optional file", async () => {
    const transport = createOpenAiTestTransport([
      { toolCalls: [{ id: "load-body", name: "load_skill", input: { name: "containers" } }] },
    ]);
    const decision = await new AiSdkModelSession(transport.model, limits).complete({
      messages: [textMessage("user", "Load the containers Skill body without a reference file.")],
      tools: [projectToolContract(loadSkillControl)],
    });

    expect(transport.requests[0]).toMatchObject({ tools: [{
      type: "function", name: "load_skill", strict: false,
      parameters: { required: ["name"], properties: { file: { type: "string" } } },
    }] });
    const selected = messageToolCalls(decision.message)[0]!;
    expect(loadSkillControl.input.parse(JSON.parse(selected.arguments))).toEqual({ name: "containers" });
  });

  it.each([{ summary: [] }, { summary: ["Inspect the furnace.", "Then inspect the chest."] }])(
    "replays encrypted reasoning and its tool result with summary $summary, retaining only the first call",
    async ({ summary }) => {
      const transport = createOpenAiTestTransport([
        { reasoning: { id: "rs_first", encryptedContent: "encrypted-first", summary }, toolCalls: [call("first"), call("discarded")] },
        { toolCalls: [call("next")] },
      ]);
      const session = new AiSdkModelSession(transport.model, limits);
      const context = textMessage("user", "Inspect the furnace and chest.");
      const decision = await session.complete({ messages: [context], tools: [inspect] });

      expect(decision.serialToolCallReduction).toEqual({ received: 2, retained: "first" });
      expect(messageToolCalls(decision.message)).toHaveLength(1);
      expect(decision.message.content).toEqual(expect.arrayContaining([
        // Streaming attaches encrypted continuation metadata to the final summary part.
        expect.objectContaining({ type: "reasoning", text: summary.at(-1) ?? "", providerOptions: {
          openai: { itemId: "rs_first", reasoningEncryptedContent: "encrypted-first" },
        } }),
      ]));

      await session.complete({ messages: [context, decision.message,
        toolResultMessage("first", "inspect", "furnace is ready"), textMessage("user", "Continue with fresh observation."),
      ], tools: [inspect] });

      expect(transport.urls).toEqual(["https://openai.test/v1/responses", "https://openai.test/v1/responses"]);
      expect(transport.requests[1]).toMatchObject({
        model: "gpt-test", store: false, include: ["reasoning.encrypted_content"], parallel_tool_calls: false,
        input: [
          expect.objectContaining({ role: "user" }),
          { type: "reasoning", id: "rs_first", encrypted_content: "encrypted-first",
            summary: summary.map(text => ({ type: "summary_text", text })) },
          expect.objectContaining({ type: "function_call", call_id: "first", name: "inspect", arguments: '{"target":"furnace"}' }),
          { type: "function_call_output", call_id: "first", output: "furnace is ready" },
          expect.objectContaining({ role: "user" }),
        ],
      });
      expect(JSON.stringify(transport.requests[1])).not.toContain("discarded");
      expect(transport.requests[1]).not.toHaveProperty("previous_response_id");
      expect(transport.requests[1]).not.toHaveProperty("conversation");
    },
  );

});
