import { describe, expect, it } from "vitest";

import { runSimulationSuspensionSmoke } from "./integration/runtime-sdk/simulation-suspension.mjs";

describe("pause-when-idle scenario", () => {
  it("requires an idle World Run to stand still and a wait to advance exactly its ticks", async () => {
    let gameTime = 10;
    const receipt = await runSimulationSuspensionSmoke({
      command: async () => `The time is ${gameTime}`,
      client: {
        runtimeInfo: async () => ({ simulation_suspended: true, pause_when_idle: true }),
        toolCall: async (_name: string, input: { ticks: number }) => { gameTime += input.ticks; return { success: true, message: "waited" }; },
      },
    });

    expect(receipt).toEqual({ idleGameTime: 10, frozenGameTime: 10, afterWait: 50, pausedAgain: 50 });
  }, 10_000);

  it("rejects a World Run that keeps advancing while idle", async () => {
    let gameTime = 10;
    await expect(runSimulationSuspensionSmoke({
      command: async () => `The time is ${gameTime++}`,
      client: {
        runtimeInfo: async () => ({ simulation_suspended: true, pause_when_idle: true }),
        toolCall: async () => ({ success: true, message: "waited" }),
      },
    })).rejects.toThrow(/advanced while the World Run was idle/u);
  }, 10_000);
});
