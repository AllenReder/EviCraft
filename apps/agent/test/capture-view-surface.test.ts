import { describe, expect, it } from "vitest";

import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import { createConfiguredLanguageModel } from "../src/harness/model-route.js";
import { chatSse, sseResponse } from "./support/model-stream-fixtures.js";

import { AbilityRuntime } from "../src/harness/ability-runtime.js";
import { validateHarnessConfig } from "../src/harness/config.js";
import { captureViewControl } from "../src/harness/control-tools.js";
import { operatingContract } from "../src/harness/decision-request-assembler.js";
import { ModelSurface, OMITTED_IMAGE_TEXT } from "../src/harness/model-surface.js";
import {
  imageMessage, messageImageCount, textMessage, toolResultMessage, type ModelMessage,
} from "../src/harness/model-surface-message.js";
import { executeToolContract } from "../src/harness/tool-contract.js";

const context = (value: string) => ({ message: textMessage("user", "OBS " + value), historyMessage: textMessage("user", "history " + value) });
const decision = (id: string) => ({ role: "assistant" as const,
  content: [{ type: "tool-call" as const, toolCallId: id, toolName: "capture_view", input: {} }] });

function imagesIn(messages: readonly ModelMessage[]): number {
  return messages.reduce((count, message) => count + messageImageCount(message), 0);
}

describe("capture_view image history", () => {
  it("places each image right after its tool result and keeps only the newest retained images", () => {
    const surface = new ModelSurface(textMessage("system", "CONTRACT"), context("0"), 2);
    for (const id of ["a", "b", "c"]) {
      surface.commit(decision(id), toolResultMessage(id, "capture_view", `{"ok":true,"id":"${id}"}`),
        { message: imageMessage(`view ${id}`, Buffer.from(id).toString("base64")), journalPlaceholder: `[image file ${id}.png]` });
    }
    const messages = surface.requestMessages();
    expect(imagesIn(messages)).toBe(2);
    const roles = messages.map(message => message.role);
    // contract, then (context, assistant, tool, image) per cycle, then the current context
    expect(roles).toEqual(["system", ...Array(3).fill(["user", "assistant", "tool", "user"]).flat(), "user"]);
    const oldest = messages[4]!;
    expect(messageImageCount(oldest)).toBe(0);
    expect(JSON.stringify(oldest)).toContain(OMITTED_IMAGE_TEXT);
    expect(messageImageCount(messages[8]!)).toBe(1);
    expect(messageImageCount(messages[12]!)).toBe(1);
  });

  it("journals the image file name instead of the encoded image", () => {
    const surface = new ModelSurface(textMessage("system", "CONTRACT"), context("0"), 1);
    const encoded = Buffer.alloc(64, 7).toString("base64");
    const journaled = surface.commit(decision("a"), toolResultMessage("a", "capture_view", "{}"),
      { message: imageMessage("view", encoded), journalPlaceholder: "[image file views/view-0001.png]" });
    expect(JSON.stringify(journaled)).not.toContain(encoded);
    expect(JSON.stringify(journaled.attachment)).toContain("views/view-0001.png");
    expect(imagesIn(surface.requestMessages())).toBe(1);
  });
});

describe("capture_view control contract", () => {
  it("accepts an omitted or bounded direction and rejects out-of-range angles", async () => {
    const ok = { ok: true as const, data: { dimension: "minecraft:overworld", eye: { x: 0, y: 64, z: 0 },
      yaw: 90, pitch: 10, width: 854, height: 480, server_tick: 5 } };
    await expect(executeToolContract(captureViewControl, {}, async () => ok)).resolves.toMatchObject({ canonicalOutput: ok });
    await expect(executeToolContract(captureViewControl, { yaw: 90, pitch: 10 }, async () => ok)).resolves.toMatchObject({ canonicalOutput: ok });
    await expect(executeToolContract(captureViewControl, { pitch: 120 }, async () => ok)).rejects.toThrow();
    await expect(executeToolContract(captureViewControl, { yaw: 270 }, async () => ok)).rejects.toThrow();
    const aimed = { ok: true as const, data: { ...ok.data, target: { x: -3, y: 70, z: 12 } } };
    await expect(executeToolContract(captureViewControl, { target: { x: -3, y: 70, z: 12 } }, async () => aimed))
      .resolves.toMatchObject({ canonicalOutput: aimed });
    await expect(executeToolContract(captureViewControl, { target: { x: 1.5, y: 70, z: 12 } }, async () => aimed)).rejects.toThrow();
  });
});

describe("vision configuration", () => {
  const model = { provider: "deepseek", model: "deepseek-v4-flash", limits: { contextWindowTokens: 131072, maxOutputTokens: 8192 } };

  it("is enabled by its presence and keeps the configured image retention", () => {
    expect(validateHarnessConfig({ model }).vision).toBeUndefined();
    expect(validateHarnessConfig({ model, vision: { retainedImages: 1 } }).vision).toEqual({ retainedImages: 1 });
  });

  it("requires a positive retention and rejects unknown vision fields", () => {
    expect(() => validateHarnessConfig({ model, vision: {} })).toThrow(/retainedImages/);
    expect(() => validateHarnessConfig({ model, vision: { retainedImages: 0 } })).toThrow(/retainedImages/);
    expect(() => validateHarnessConfig({ model, vision: { retainedImages: 3, enabled: true } })).toThrow(/config.vision.enabled/);
  });
});

describe("capture_view operating contract", () => {
  const contract = (vision: boolean) => operatingContract({ mode: "native", runtime: new AbilityRuntime(), projectSkills: [], vision });

  it("tells the model what capture_view shows only when the run exposes it", () => {
    expect(contract(true).wireText).toContain("capture_view shows what the Bot currently sees");
    expect(contract(false).wireText).not.toContain("capture_view");
    expect(contract(true).sections.find(section => section.title === "Harness Contract")?.body).toContain("capture_view");
  });
});

describe("capture_view image on the chat-completions wire", () => {
  it("sends the tool result as text and the image as an image_url in the following user message", async () => {
    const limits = { contextWindowTokens: 200_000, maxOutputTokens: 512 };
    const model = createConfiguredLanguageModel({ provider: "openai-compatible", name: "local-sglang", model: "local-model",
      baseUrl: "http://127.0.0.1:30000/v1", protocol: "chat-completions", limits }, {});
    const encoded = Buffer.from("not-really-a-png").toString("base64");
    let body: { messages: Array<{ role: string; content: unknown }> } = { messages: [] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return sseResponse(chatSse({ id: "test", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    };
    try {
      await new AiSdkModelSession(model, limits, "auto").complete({ messages: [
        textMessage("user", "OBS"), decision("look"), toolResultMessage("look", "capture_view", '{"ok":true}'),
        imageMessage("capture_view image", encoded), textMessage("user", "OBS 2"),
      ] });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const tool = body.messages.find(message => message.role === "tool");
    expect(tool?.content).toBe('{"ok":true}');
    const imageTurn = body.messages[body.messages.indexOf(tool!) + 1]!;
    expect(imageTurn.role).toBe("user");
    expect(imageTurn.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: `data:image/png;base64,${encoded}` }) }),
    ]));
  });
});
