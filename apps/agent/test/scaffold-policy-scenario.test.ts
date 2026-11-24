import { describe, expect, it } from "vitest";

import { runScaffoldPolicySmoke } from "./integration/runtime-sdk/scaffold-policy.mjs";

const projection = (
  action: string,
  itemIdGlobs: string[],
  effectiveItemCount: number,
  carriedMatchingItems: Array<{ item_id: string; count: number }> = [],
  failureType?: string,
) => ({
  action,
  item_id_globs: itemIdGlobs,
  effective_item_count: effectiveItemCount,
  effective_item_sample: [],
  carried_matching_items: carriedMatchingItems,
  ...(failureType === undefined ? {} : { failure_type: failureType }),
});

describe("Scaffold Material scenario", () => {
  it("drives the policy contract and restores the factory policy", async () => {
    const factoryGlobs = ["minecraft:dirt"];
    const responses = [
      { success: true, data: projection("read", factoryGlobs, 23) },
      { success: true, data: projection("set", ["minecraft:*dirt", "minecraft:stone"], 4, [
        { item_id: "minecraft:dirt", count: 2 },
        { item_id: "minecraft:coarse_dirt", count: 3 },
        { item_id: "minecraft:stone", count: 4 },
      ]) },
      { success: true, data: projection("read", ["minecraft:*dirt", "minecraft:stone"], 4) },
      { success: true, data: projection("add", ["minecraft:*dirt", "minecraft:stone", "minecraft:mud"], 4) },
      { success: true, data: projection("delete", ["minecraft:*dirt", "minecraft:stone", "minecraft:mud"], 4) },
      { success: true, data: projection("delete", ["minecraft:*dirt", "minecraft:mud"], 3) },
      { success: false, data: projection("set", ["minecraft:*dirt", "minecraft:mud"], 3, [], "no_block_item_match") },
      { success: true, data: projection("clear", [], 0) },
      { success: true, data: projection("set", factoryGlobs, 23) },
      { success: true, data: projection("set", factoryGlobs, 23) },
    ];
    const calls: Array<{ name: string; args: unknown }> = [];
    const commands: string[] = [];

    await runScaffoldPolicySmoke({
      client: {
        async toolCall(name: string, args: unknown) {
          calls.push({ name, args });
          const response = responses.shift();
          if (response === undefined) throw new Error("unexpected policy call");
          return response;
        },
      },
      command: async (command: string) => { commands.push(command); },
    });

    expect(responses).toEqual([]);
    expect(calls).toEqual([
      { name: "manage_scaffold_materials", args: {} },
      { name: "manage_scaffold_materials", args: {
        action: "set", item_id_globs: ["minecraft:*dirt", "minecraft:stone", "minecraft:*dirt"],
      } },
      { name: "manage_scaffold_materials", args: { action: "read" } },
      { name: "manage_scaffold_materials", args: {
        action: "add", item_id_globs: ["minecraft:mud", "minecraft:*dirt"],
      } },
      { name: "manage_scaffold_materials", args: {
        action: "delete", item_id_globs: ["minecraft:coarse_dirt"],
      } },
      { name: "manage_scaffold_materials", args: {
        action: "delete", item_id_globs: ["minecraft:stone"],
      } },
      { name: "manage_scaffold_materials", args: {
        action: "set", item_id_globs: ["minecraft:stick"],
      } },
      { name: "manage_scaffold_materials", args: { action: "clear" } },
      { name: "manage_scaffold_materials", args: { action: "set", item_id_globs: factoryGlobs } },
      { name: "manage_scaffold_materials", args: { action: "set", item_id_globs: factoryGlobs } },
    ]);
    expect(commands).toEqual([
      "clear bot",
      "give bot minecraft:dirt 2",
      "give bot minecraft:coarse_dirt 3",
      "give bot minecraft:stone 4",
      "give bot minecraft:mud 5",
      "clear bot",
    ]);
  });
});
