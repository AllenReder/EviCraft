import { resolve } from "node:path";
import { expect, it } from "vitest";
import task, { discoveryAssignment } from "./task.ts";

it("passes each config's Harness settings through and gives every instance the same assignment", async () => {
  const files = ["deepseek-v4.1-flash-s100-g.json", "deepseek-v4.1-flash-s100-l.json"];
  const configured = await Promise.all(files.map(file => task.configure(resolve("tasks/minecraft-item-discovery/config/deepseek-v4-1-flash", file))));
  expect(task).toMatchObject({ id: "minecraft-item-discovery", revision: "2" });
  for (const [index, entry] of configured.entries()) expect(entry.configuration).toMatchObject({
    profile: index === 0 ? "grounded_evidence" : "loaded_world_state",
    tickBudget: 144000, harness: { command: ["node", "../../../../apps/agent/dist/cli.js"], config: { mode: "code", abilitySet: "shared" } },
    assignment: discoveryAssignment,
    promptRevision: "3", observationSchemaVersion: "2",
  });
  expect(discoveryAssignment).not.toMatch(/48000|秒|评分/u);
});
