import { setTimeout as delay } from "node:timers/promises";
import { ScriptedLanguageModel } from "../../../dist/harness/testing/scripted-language-model.js";
export {
  runScenarioHarness, scriptedScenarioEnd, scriptedToolDecision,
} from "../../../dist/smoke/scenario-harness.js";

/**
 * Low-level context operations shared by Runtime SDK smoke scenarios.
 * Scenario fixtures and assertions stay in their owning modules.
 */

export async function waitForLog(runtime, needle, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.output().includes(needle)) return;
    const failure = runtime.failure?.();
    if (failure !== undefined) {
      throw new Error(`Runtime failed before ${needle}: ${failure.message}\n${runtime.output().slice(-6000)}`);
    }
    if (runtime.exited()) {
      throw new Error(`Runtime exited before ${needle}:\n${runtime.output().slice(-6000)}`);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${needle}:\n${runtime.output().slice(-6000)}`);
}

export { rconPacket, readRconPacket, runtimeCommand } from "../../../dist/smoke/rcon.js";

export function sameBlockPosition(actual, expected) {
  return actual?.x === expected.x && actual?.y === expected.y && actual?.z === expected.z;
}

export function recordingRuntimeClient(client, calls) {
  return new Proxy(client, {
    get(target, property) {
      if (property === "startToolCall") {
        return (name, args) => {
          calls.push({ name, args });
          return target.startToolCall(name, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function scriptedSmokeModel(respond) {
  return new ScriptedLanguageModel({
    limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
    respond: async (request, _index, context) => await respond(request, { signal: context.signal }),
  });
}

export function smokeModelConfig() {
  return {
    provider: "openai",
    model: "smoke-script",
    limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
  };
}
