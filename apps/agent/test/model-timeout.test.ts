import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSdkModelSession } from "../src/harness/ai-sdk-model-session.js";
import { validateHarnessConfig } from "../src/harness/config.js";

const { streamText } = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async importOriginal => ({ ...await importOriginal<typeof import("ai")>(), streamText }));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("model request timeout", () => {
  it.each([
    { missing: "requestTimeoutMs", beforeOutput: false, gapMs: 180_000 },
    { missing: "firstOutputTimeoutMs", beforeOutput: true, gapMs: 180_000 },
    { missing: "outputIdleTimeoutMs", beforeOutput: false, gapMs: 90_000 },
  ] as const)("uses the DeepSeek-aligned default when $missing is omitted", async ({ missing, beforeOutput, gapMs }) => {
    vi.useFakeTimers();
    const limits = { contextWindowTokens: 128000, maxOutputTokens: 4096,
      requestTimeoutMs: 7_200_000, firstOutputTimeoutMs: 600_000, outputIdleTimeoutMs: 7_200_000 };
    const { [missing]: omitted, ...configured } = limits;
    void omitted;
    streamText.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => ({
      fullStream: (async function* () {
        if (!beforeOutput) yield { type: "reasoning-delta", text: "thinking" };
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(abortSignal.reason); };
          const timer = setTimeout(() => { abortSignal.removeEventListener("abort", abort); resolve(); }, gapMs);
          abortSignal.addEventListener("abort", abort, { once: true });
        });
        yield { type: "text-delta", text: "ok" };
      })(),
      toolCalls: [], responseMessages: [], text: "ok", reasoningText: "thinking", usage: {}, finishReason: "stop",
    }));
    const controller = new AbortController();
    const result = new AiSdkModelSession("test-model", configured)
      .complete({ messages: [{ role: "user", content: "test" }] }, { signal: controller.signal })
      .then(() => "completed", () => "failed");
    await vi.advanceTimersByTimeAsync(gapMs + 1);
    controller.abort();
    expect(await result).toBe("completed");
    expect(streamText).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 600000])("disables SDK retries and passes cancellation for timeout %s", async requestTimeoutMs => {
    streamText.mockReturnValue({ fullStream: (async function* () {})(), toolCalls: [], responseMessages: [], text: "ok", usage: {}, finishReason: "stop" });
    const controller = new AbortController();
    const session = new AiSdkModelSession("test-model", { contextWindowTokens: 128000, maxOutputTokens: 4096,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) });
    await session.complete({ messages: [{ role: "user", content: "test" }] }, { signal: controller.signal });
    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, abortSignal: expect.any(AbortSignal) }));
  });

  it.each(["requestTimeoutMs", "firstOutputTimeoutMs", "outputIdleTimeoutMs"])("preserves %s and rejects invalid values", key => {
    const config = (value: number) => ({ model: { provider: "openai", model: "test", limits: { contextWindowTokens: 128000, maxOutputTokens: 4096, [key]: value } } });
    expect(validateHarnessConfig(config(600000)).model.limits).toHaveProperty(key, 600000);
    for (const value of [0, -1, 1.5, NaN]) expect(() => validateHarnessConfig(config(value))).toThrow(key);
  });

  it("accepts retries and retryMaxDelayMs, leaves them unset by default, and rejects invalid values", () => {
    const config = (limits: Record<string, unknown>) => ({ model: { provider: "openai", model: "test", limits: { contextWindowTokens: 128000, maxOutputTokens: 4096, ...limits } } });
    const unset = validateHarnessConfig(config({})).model.limits;
    expect(unset).not.toHaveProperty("retries");
    expect(unset).not.toHaveProperty("retryMaxDelayMs");
    expect(validateHarnessConfig(config({ retries: 0 })).model.limits).toHaveProperty("retries", 0);
    expect(validateHarnessConfig(config({ retries: 8, retryMaxDelayMs: 30000 })).model.limits).toMatchObject({ retries: 8, retryMaxDelayMs: 30000 });
    for (const value of [-1, 1.5, NaN, "8"]) expect(() => validateHarnessConfig(config({ retries: value }))).toThrow("retries");
    for (const value of [0, -1, 1.5, NaN]) expect(() => validateHarnessConfig(config({ retryMaxDelayMs: value }))).toThrow("retryMaxDelayMs");
  });
});
