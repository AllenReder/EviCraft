import { resolve } from "node:path";
import { expect, it } from "vitest";
import task, { survivalAssignment } from "./task.ts";

it("gives the paper configs the Survival assignment and each its own knowledge profile", async () => {
  const files = ["deepseek-v4.1-flash-s100-g.json", "deepseek-v4.1-flash-s100-l.json"];
  const configured = await Promise.all(files.map(file => task.configure(resolve("tasks/minecraft-survival/config/deepseek-v4-1-flash", file))));
  expect(task).toMatchObject({ id: "minecraft-survival", revision: "2" });
  for (const [index, entry] of configured.entries()) expect(entry.configuration).toMatchObject({
    profile: index === 0 ? "grounded_evidence" : "loaded_world_state", seed: "100",
    tickBudget: 72000, deathPolicy: "respawn", assignment: survivalAssignment, promptRevision: "3", observationSchemaVersion: "2",
    harness: { command: ["node", "../../../../apps/agent/dist/cli.js"], config: { mode: "code", abilitySet: "shared", hazardDecisions: "enabled" } },
  });
  expect(survivalAssignment).toContain("If you die, you respawn and continue.");
});
