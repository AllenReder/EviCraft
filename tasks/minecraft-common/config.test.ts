import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadTaskConfiguration } from "./config.ts";

const generatedConfigurations = await mkdtemp(join(tmpdir(), "task-configurations-"));
let generatedConfigurationIndex = 0;
afterAll(async () => await rm(generatedConfigurations, { recursive: true, force: true }));

async function configuration(input: Readonly<Record<string, unknown>> = {}) {
  const path = join(generatedConfigurations, `${generatedConfigurationIndex++}.json`);
  await writeFile(path, JSON.stringify({
    serverTemplatePath: "server",
    serverCommand: ["server"],
    snapshotPath: resolve("tasks/minecraft-survival/snapshots/seed-100-v1"),
    harness: { command: ["harness"] },
    ...input,
  }));
  return await loadTaskConfiguration(path);
}

describe("Task configuration", () => {
  it("passes the Harness section through unread and records it in the metadata", async () => {
    const settings = { model: { anything: true }, mode: "native", extra: [1, 2, 3] };
    const config = await configuration({ harness: { command: ["python3", "agent.py"], config: settings } });
    expect(config.harness).toMatchObject({ command: ["python3", "agent.py"], config: settings, cwd: generatedConfigurations });
    expect(config.metadata.harness).toEqual({ command: ["python3", "agent.py"], config: settings });
  });

  it("requires a Harness command and defaults its config to null", async () => {
    expect((await configuration()).harness.config).toBeNull();
    await expect(configuration({ harness: { config: {} } })).rejects.toThrow("harness.command is required");
    await expect(configuration({ harness: undefined })).rejects.toThrow("harness.command is required");
  });

  it("samples every 20 ticks and pauses an idle world by default", async () => {
    expect(await configuration()).toMatchObject({ sampleIntervalTicks: 20, pauseWhenIdle: true,
      metadata: { sampleIntervalTicks: 20, pausePolicy: "runtime-pause-when-idle" } });
    expect(await configuration({ sampleIntervalTicks: 5, pauseWhenIdle: false })).toMatchObject({ sampleIntervalTicks: 5,
      metadata: { pausePolicy: "realtime" } });
    await expect(configuration({ sampleIntervalTicks: 0 })).rejects.toThrow("sampleIntervalTicks");
  });

  it("defaults to respawn and a 30-minute budget, and names the frozen world it starts from", async () => {
    const config = await configuration();
    expect(config).toMatchObject({
      deathPolicy: "respawn",
      tickBudget: 36000,
      metadata: { seed: "100", observationSchemaVersion: "2" },
    });
    await expect(configuration({ deathPolicy: "first_death" })).rejects.toThrow("deathPolicy must be respawn");
    await expect(configuration({ snapshotPath: undefined })).rejects.toThrow("snapshotPath is required");
  });

  it("keeps Runtime defaults in both world configuration and result metadata", async () => {
    const config = await configuration();
    const grounded = { groundedBlockExpiryTicks: 400, groundedEntityExpiryTicks: 400, groundedFieldOfViewDegrees: 360 };
    expect(config.world).toMatchObject(grounded);
    expect(config.metadata).toMatchObject(grounded);
  });

  it("forwards a narrower grounded field of view and rejects angles outside 1 through 360", async () => {
    const config = await configuration({ groundedFieldOfViewDegrees: 110 });
    expect(config.world).toMatchObject({ groundedFieldOfViewDegrees: 110 });
    expect(config.metadata).toMatchObject({ groundedFieldOfViewDegrees: 110 });
    for (const value of [0, 361, 90.5]) {
      await expect(configuration({ groundedFieldOfViewDegrees: value })).rejects.toThrow("groundedFieldOfViewDegrees");
    }
  });

  it.each(["grounded_evidence", "loaded_world_state"] as const)(
    "forwards explicit expiry for %s without changing profile",
    async (profile) => {
      const config = await configuration({
        profile,
        groundedBlockExpiryTicks: 1200,
        groundedEntityExpiryTicks: -1,
      });
      expect(config.world).toMatchObject({
        worldKnowledgeProfile: profile,
        groundedBlockExpiryTicks: 1200,
        groundedEntityExpiryTicks: -1,
      });
      expect(config.metadata).toMatchObject({
        profile,
        groundedBlockExpiryTicks: 1200,
        groundedEntityExpiryTicks: -1,
      });
    },
  );

  it.each(["groundedBlockExpiryTicks", "groundedEntityExpiryTicks"] as const)(
    "rejects invalid %s before starting a server",
    async (name) => {
      for (const value of [0, -2, 1.5, 2147483648]) {
        await expect(configuration({ [name]: value })).rejects.toThrow(name);
      }
    },
  );
});

it("resolves resources relative to each config file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-files-"));
  try {
    await writeFile(join(directory, "g.json"), JSON.stringify({
      serverTemplatePath: "server", serverCommand: ["server"],
      snapshotPath: resolve("tasks/minecraft-survival/snapshots/seed-100-v1"),
      camera: { clientTemplatePath: "camera" }, profile: "grounded_evidence", harness: { command: ["harness"] },
    }));
    const config = await loadTaskConfiguration(join(directory, "g.json"));
    expect(config.serverWorkingDirectoryTemplate).toBe(join(directory, "server"));
    expect(config.camera).toEqual({ clientTemplate: join(directory, "camera"), viewDistance: 4, width: 854, height: 480 });
    expect(config.harness.cwd).toBe(directory);
    expect(config.metadata).not.toHaveProperty("pairId");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
