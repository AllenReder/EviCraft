import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type RunCliIo } from "../src/harness-cli.js";
import { validateHarnessConfig } from "../src/harness/config.js";
import { createConfiguredLanguageModel } from "../src/harness/model-route.js";
import type { OperatorInteraction } from "../src/harness/operator-interaction.js";
import type { HarnessRunResult, RunHarnessOptions } from "../src/harness/run-harness.js";
import { createDeepSeekTestTransport } from "./support/deepseek-test-transport.js";

describe("Harness CLI", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("plays the task file: its assignment, its Bot, its Runtime address and its output directory", async () => {
    const task = await taskFile(directories, {
      provider: "openai",
      model: "test-model",
      limits: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
    }, { hazardDecisions: "disabled", skillsPath: "skills" });
    const outputDirectory = directories.at(-1)!;
    const runHarness = vi.fn(async (options: RunHarnessOptions): Promise<HarnessRunResult> => {
      expect(options.agentContext).toEqual({ revision: 0, assertions: [{ id: "assignment", text: "Test assignment" }] });
      expect(options.existingBotId).toBe(BOT_ID);
      expect(options.config).toEqual({
        mode: "code",
        model: { provider: "openai", model: "test-model", limits: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 } },
        runtime: { url: "ws://127.0.0.1:8765/rpc" },
        bot: { username: "HarnessBot" },
        data: { directory: outputDirectory },
        artifacts: { directory: join(outputDirectory, "harness") },
      });
      expect(options.modelLimits).toEqual({ contextWindowTokens: 200_000, maxOutputTokens: 8_192 });
      expect(options.hazardDecisions).toBe("disabled");
      expect(options.projectSkillSnapshotBuilder).toBeDefined();
      expect(options.onProgress).toBeUndefined();
      return ended("external_stop");
    });

    expect(await runCli([], io([], false), {
      runHarness,
      createLanguageModel: () => createDeepSeekTestTransport([]).model,
      environment: { ...task, OPENAI_API_KEY: "openai-secret" },
    })).toBe(0);
    expect(runHarness).toHaveBeenCalledOnce();
  });

  it("shows the live transcript only on a terminal, and fails without a task file", async () => {
    const task = await taskFile(directories);
    const runHarness = vi.fn(async (options: RunHarnessOptions): Promise<HarnessRunResult> => {
      expect(typeof options.onProgress).toBe("function");
      return ended("external_stop");
    });
    const dependencies = { runHarness, createLanguageModel: () => createDeepSeekTestTransport([]).model };
    expect(await runCli([], io([], true), { ...dependencies, environment: { ...task, OPENAI_API_KEY: "openai-secret" } })).toBe(0);

    const output: string[] = [];
    expect(await runCli([], io(output, false), { ...dependencies, environment: { OPENAI_API_KEY: "openai-secret" } })).toBe(2);
    expect(JSON.parse(output[0]!)).toMatchObject({ failure: { code: "CONFIG_INVALID", message: expect.stringContaining("EVICRAFT_TASK_FILE") } });
    expect(runHarness).toHaveBeenCalledOnce();
  });

  it("runs one operator-driven native Harness Run from the manual subcommand", async () => {
    const task = await taskFile(directories);
    const operator = fakeOperator();
    let interrupt: (() => void) | undefined;
    const runHarness = vi.fn(async (options: RunHarnessOptions): Promise<HarnessRunResult> => {
      expect(options.mode).toBe("native");
      expect(options.hazardDecisions).toBe("disabled");
      expect(options.operator).toBe(operator);
      expect(options.existingBotId).toBe(BOT_ID);
      expect(options.secrets).toEqual({
        runtimeBearerToken: "runtime-secret",
      });
      expect(typeof options.onProgress).toBe("function");
      interrupt?.();
      expect(options.signal?.aborted).toBe(true);
      return ended("external_stop");
    });
    const output: string[] = [];

    const code = await runCli(["manual"], io(output, true), {
      runHarness,
      createOperatorInteraction: () => operator,
      registerInterrupt: (handler) => {
        interrupt = handler;
        return () => { interrupt = undefined; };
      },
      environment: { ...task, EVICRAFT_RUNTIME_BEARER_TOKEN: "runtime-secret" },
    });

    expect(code).toBe(0);
    expect(runHarness).toHaveBeenCalledOnce();
    expect(output).toEqual([
      "Manual Ability Session ended (external_stop)",
      `Artifacts: ${join(directories.at(-1)!, "harness")}`,
    ]);
  });

  it("assembles the configured OpenAI model and drives the public Harness Run seam", async () => {
    const task = await taskFile(directories);
    const model = createDeepSeekTestTransport([]).model;
    const createLanguageModel = vi.fn(() => model);
    const runHarness = vi.fn(async (options: RunHarnessOptions): Promise<HarnessRunResult> => {
      expect(options.config).toMatchObject({
        model: {
          provider: "openai",
          model: "test-model",
          limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
        },
      });
      expect(options.config).not.toHaveProperty("artifacts.runLabel");
      expect(options.languageModel).toBe(model);
      expect(options.modelLimits).toEqual({ contextWindowTokens: 200_000, maxOutputTokens: 512 });
      expect(options.secrets).toEqual({ modelApiKey: "openai-secret" });
      return ended("external_stop");
    });

    const code = await runCli([], io([], false), {
      runHarness,
      createLanguageModel,
      environment: { ...task, OPENAI_API_KEY: "openai-secret" },
    });

    expect(code).toBe(0);
    expect(createLanguageModel).toHaveBeenCalledOnce();
    expect(runHarness).toHaveBeenCalledOnce();
  });

  it("assembles the configured DeepSeek model and drives the public Harness Run seam", async () => {
    const task = await taskFile(directories, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      limits: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
    });
    const model = createDeepSeekTestTransport([]).model;
    const createLanguageModel = vi.fn(() => model);
    const runHarness = vi.fn(async (options: RunHarnessOptions): Promise<HarnessRunResult> => {
      expect(options.config).toMatchObject({
        model: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          limits: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
        },
      });
      expect(options.languageModel).toBe(model);
      expect(options.modelLimits).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 4_096 });
      expect(options.secrets).toEqual({ modelApiKey: "deepseek-secret" });
      return ended("external_stop");
    });

    const code = await runCli([], io([], false), {
      runHarness,
      createLanguageModel,
      environment: { ...task, DEEPSEEK_API_KEY: "deepseek-secret" },
    });

    expect(code).toBe(0);
    expect(createLanguageModel).toHaveBeenCalledOnce();
    expect(runHarness).toHaveBeenCalledOnce();
  });

  it("reports a missing OpenAI credential before constructing a model or running the Harness", async () => {
    const task = await taskFile(directories);
    const output: string[] = [];
    const createLanguageModel = vi.fn();
    const runHarness = vi.fn();

    expect(await runCli([], io(output, false), {
      runHarness,
      createLanguageModel,
      environment: task,
    })).toBe(2);

    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "setup_failure",
      failure: { code: "CONFIG_INVALID", message: expect.stringContaining("OPENAI_API_KEY") },
    });
    expect(createLanguageModel).not.toHaveBeenCalled();
    expect(runHarness).not.toHaveBeenCalled();
  });

  it("reports a missing DeepSeek credential before constructing a model or running the Harness", async () => {
    const task = await taskFile(directories, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      limits: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
    });
    const output: string[] = [];
    const createLanguageModel = vi.fn();
    const runHarness = vi.fn();

    expect(await runCli([], io(output, false), {
      runHarness,
      createLanguageModel,
      environment: task,
    })).toBe(2);

    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "setup_failure",
      failure: { code: "CONFIG_INVALID", message: expect.stringContaining("DEEPSEEK_API_KEY") },
    });
    expect(createLanguageModel).not.toHaveBeenCalled();
    expect(runHarness).not.toHaveBeenCalled();
  });

  it.each([
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
  ])("accepts the supported DeepSeek V4 model %s", (model) => {
    expect(validateHarnessConfig({
      mode: "code",
      model: {
        provider: "deepseek",
        model,
        limits: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
      },
    }).model).toMatchObject({ provider: "deepseek", model });
  });
  it("defaults to the shared ability set and accepts an explicit profile-selected set", () => {
    const config = { mode: "native", model: { provider: "openai", model: "test", limits: { contextWindowTokens: 4096, maxOutputTokens: 512 } } };
    expect(validateHarnessConfig(config).abilitySet).toBe("shared");
    expect(validateHarnessConfig({ ...config, abilitySet: "profile-default" }).abilitySet).toBe("profile-default");
    expect(() => validateHarnessConfig({ ...config, abilitySet: "unknown" })).toThrow("config.abilitySet");
  });

  it("assembles an authenticated OpenAI-compatible model and drives the public Harness Run seam", async () => {
    const task = await taskFile(directories, compatibleModel({
      apiKeyEnvironmentVariable: "VLLM_API_KEY",
    }));
    const model = createDeepSeekTestTransport([]).model;
    const createLanguageModel = vi.fn(() => model);
    const runHarness = vi.fn(async (options: RunHarnessOptions): Promise<HarnessRunResult> => {
      expect(options.config).toMatchObject({
        model: {
          provider: "openai-compatible",
          name: "local-vllm",
          model: "local-model",
          baseUrl: "http://127.0.0.1:8000/v1",
          protocol: "chat-completions",
          limits: { contextWindowTokens: 32_768, maxOutputTokens: 1_024 },
          apiKeyEnvironmentVariable: "VLLM_API_KEY",
        },
      });
      expect(options.secrets).toEqual({ modelApiKey: "local-secret" });
      expect(options.languageModel).toBe(model);
      expect(options.modelLimits).toEqual({ contextWindowTokens: 32_768, maxOutputTokens: 1_024 });
      return ended("external_stop");
    });

    expect(await runCli([], io([], false), {
      runHarness,
      createLanguageModel,
      environment: { ...task, VLLM_API_KEY: "local-secret", OPENAI_API_KEY: "must-not-be-used" },
    })).toBe(0);

    expect(createLanguageModel).toHaveBeenCalledOnce();
    expect(runHarness).toHaveBeenCalledOnce();
  });

  it("assembles an unauthenticated OpenAI-compatible model without reading OPENAI_API_KEY", async () => {
    const task = await taskFile(directories, compatibleModel());
    const model = createDeepSeekTestTransport([]).model;
    const createLanguageModel = vi.fn(() => model);
    const runHarness = vi.fn(async (options: RunHarnessOptions): Promise<HarnessRunResult> => {
      expect(options.secrets).toEqual({});
      expect(options.languageModel).toBe(model);
      return ended("external_stop");
    });

    expect(await runCli([], io([], false), {
      runHarness,
      createLanguageModel,
      environment: { ...task, OPENAI_API_KEY: "must-not-be-used" },
    })).toBe(0);

    expect(createLanguageModel).toHaveBeenCalledOnce();
    expect(runHarness).toHaveBeenCalledOnce();
  });

  it("uses the explicit compatible Provider name when constructing the AI SDK model", () => {
    const config = validateHarnessConfig({
      mode: "code",
      model: compatibleModel(),
    });

    const model = createConfiguredLanguageModel(config.model, {});

    expect(model.provider).toBe("local-vllm.chat");
  });

  it("reports a missing named OpenAI-compatible credential before constructing a model or running the Harness", async () => {
    const task = await taskFile(directories, compatibleModel({
      apiKeyEnvironmentVariable: "VLLM_API_KEY",
    }));
    const output: string[] = [];
    const createLanguageModel = vi.fn();
    const runHarness = vi.fn();

    expect(await runCli([], io(output, false), {
      runHarness,
      createLanguageModel,
      environment: { ...task, OPENAI_API_KEY: "must-not-be-used" },
    })).toBe(2);

    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "setup_failure",
      failure: { code: "CONFIG_INVALID", message: expect.stringContaining("VLLM_API_KEY") },
    });
    expect(createLanguageModel).not.toHaveBeenCalled();
    expect(runHarness).not.toHaveBeenCalled();
  });

  it("requires every explicit OpenAI-compatible route field", async () => {
    const incompleteModels = [
      { ...compatibleModel(), name: undefined },
      { ...compatibleModel(), model: undefined },
      { ...compatibleModel(), baseUrl: undefined },
      { ...compatibleModel(), limits: { contextWindowTokens: 32_768 } },
    ];
    for (const model of incompleteModels) {
      const task = await taskFile(directories, model);
      const output: string[] = [];
      expect(await runCli([], io(output, false), {
        createLanguageModel: vi.fn(),
        runHarness: vi.fn(),
        environment: task,
      })).toBe(2);
      expect(JSON.parse(output[0]!)).toMatchObject({ status: "setup_failure", failure: { code: "CONFIG_INVALID" } });
    }
  });
  it("requires an interactive terminal and rejects any other argument", async () => {
    const runHarness = vi.fn();
    const nonTty: string[] = [];
    const invalidFlags: string[] = [];

    expect(await runCli(["manual"], io(nonTty, false), { runHarness })).toBe(2);
    expect(await runCli(["manual", "--mode", "native"], io(invalidFlags, true), { runHarness })).toBe(2);
    expect(await runCli(["--config", "harness.json"], io(invalidFlags, true), { runHarness })).toBe(2);

    expect(runHarness).not.toHaveBeenCalled();
    expect(nonTty.join("\n")).toContain("interactive TTY");
    expect(invalidFlags.join("\n")).toContain("cli.js manual");
  });

  it("requires the input and output streams used by the TUI to be terminals", async () => {
    const runHarness = vi.fn();
    const output: string[] = [];

    expect(await runCli(["manual"], {
      ...io(output, true),
      stdinIsTTY: true,
      stdoutIsTTY: false,
    }, { runHarness })).toBe(2);

    expect(runHarness).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("interactive TTY");
  });
});

function io(lines: string[], isTTY: boolean): RunCliIo {
  return {
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    isTTY,
    noColor: true,
  };
}

function fakeOperator(): OperatorInteraction {
  return {
    choose: async () => { throw new Error("not called by CLI seam test"); },
  };
}

function ended(endReason: "external_stop"): HarnessRunResult {
  return {
    status: "ended",
    endReason,
    ready: {
      uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d",
      username: "HarnessBot",
      lifecycle: "alive",
      observationRevision: 1,
    },
    runId: "run-id",
    runStartedAt: "2026-08-19T00:00:00.000Z",
    latestObservation: {
      ok: true,
      dimension: "minecraft:overworld",
      position: { x: 0.5, y: 64, z: 0.5 },
      feet: { x: 0, y: 64, z: 0 },
      facing: "north",
      health: 20,
      max_health: 20,
      food: 20,
      air: 300,
      max_air: 300,
      on_ground: true,
      in_water: false,
      underwater: false,
      in_lava: false,
      on_fire: false,
      velocity: { x: 0, y: 0, z: 0 },
      fall_distance: 0,
      main_hand: null,
      active_effects: [],
    },
  };
}

function compatibleModel(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openai-compatible",
    name: "local-vllm",
    model: "local-model",
    baseUrl: "http://127.0.0.1:8000/v1",
    protocol: "chat-completions",
    limits: { contextWindowTokens: 32_768, maxOutputTokens: 1_024 },
    ...extra,
  };
}

const BOT_ID = "1060d6bd-3af2-42ae-92dc-ecab4536f00d";

/** Writes a task file as the benchmark would and returns the environment that names it. */
async function taskFile(directories: string[], model: Record<string, unknown> = {
  provider: "openai",
  model: "test-model",
  limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
}, settings: Record<string, unknown> = {}): Promise<{ EVICRAFT_TASK_FILE: string }> {
  const directory = await mkdtemp(join(tmpdir(), "harness-cli-"));
  directories.push(directory);
  const path = join(directory, "harness-task.json");
  await writeFile(path, JSON.stringify({
    assignment: "Test assignment",
    bot: { id: BOT_ID, username: "HarnessBot" },
    runtime: { url: "ws://127.0.0.1:8765/rpc" },
    outputDirectory: directory,
    config: { mode: "code", model, ...settings },
  }), "utf8");
  return { EVICRAFT_TASK_FILE: path };
}
