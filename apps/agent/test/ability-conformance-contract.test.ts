import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  abilities,
  projectCompositeAbilities,
  runtimeAbilities,
} from "../src/harness/abilities/index.js";
describe("Ability Conformance contract", () => {
  it("publishes the accepted names, origins, and enhanced contracts", () => {
    const origins = new Map<string, "built-in" | "project">([
      ...runtimeAbilities.map(({ name }) => [name, "built-in"] as const),
      ...projectCompositeAbilities.map(({ name }) => [name, "project"] as const),
    ]);
    expect(Object.fromEntries([...origins].filter(([name]) => [
      "manage_scaffold_materials",
      "goto_block_interaction_pose",
      "goto_block_placement_pose",
      "enter_bed",
      "goto_and_break_block",
      "goto_and_activate_block",
      "goto_and_place_block",
      "collect_blocks",
      "place_block_nearby",
      "smelt_at_furnace",
      "sleep_in_bed",
      "suffocation_escape",
    ].includes(name)))).toEqual({
      manage_scaffold_materials: "built-in",
      goto_block_interaction_pose: "built-in",
      goto_block_placement_pose: "built-in",
      enter_bed: "built-in",
      goto_and_break_block: "project",
      goto_and_activate_block: "project",
      goto_and_place_block: "project",
      collect_blocks: "project",
      place_block_nearby: "project",
      smelt_at_furnace: "project",
      sleep_in_bed: "project",
      suffocation_escape: "project",
    });

    const definitions = new Map(abilities.map((ability) => [ability.name, ability]));
    const breakBlock = definitions.get("break_block")!;
    const transferItem = definitions.get("transfer_item")!;
    const collectItems = definitions.get("collect_items")!;
    const collectBlocks = definitions.get("collect_blocks")!;

    const breakOutputSchema = JSON.stringify(breakBlock.output.jsonSchema);
    expect(breakOutputSchema).toContain("observed_drop_entities");
    expect(breakOutputSchema).toMatch(/best-effort.*no completeness/iu);
    const transferOutputSchema = JSON.stringify(transferItem.output.jsonSchema);
    expect(transferOutputSchema).toContain("requested_count");
    expect(transferOutputSchema).toContain("source_delta");
    expect(transferOutputSchema).toContain("target_delta");
    expect(transferItem.description).toMatch(/already-open menu/iu);
    expect(transferItem.description).toMatch(/exact.*fuel consumed immediately.*furnace/iu);
    expect(transferItem.description).toMatch(/failure.*source_delta.*target_delta/iu);
    expect(runtimeAbilities).toContain(collectItems);
    expect(projectCompositeAbilities).not.toContain(collectItems);
    expect(collectItems.description).toMatch(/embodied.*evidence/iu);
    expect(() => collectItems.input.parse({})).toThrow();
    expect(() => collectItems.input.parse({
      uuids: ["00000000-0000-4000-8000-000000000001"],
      item_id_glob: "minecraft:*_ingot",
    })).toThrow();
    expect(collectItems.input.parse({
      uuids: ["00000000-0000-4000-8000-000000000001"],
      radius: 12,
    })).toEqual({
      uuids: ["00000000-0000-4000-8000-000000000001"],
      radius: 12,
    });
    expect(collectItems.input.parse({ item_id_glob: "minecraft:*_ingot" }))
      .toEqual({ item_id_glob: "minecraft:*_ingot" });
    expect(collectItems.input.jsonSchema).toMatchObject({
      oneOf: [
        {
          title: "Dropped-item Canonical ID Glob",
          properties: {
            item_id_glob: { description: expect.any(String) },
            radius: { description: expect.any(String) },
          },
        },
        {
          title: "Exact dropped-item UUIDs",
          properties: {
            uuids: { description: expect.any(String) },
            radius: { description: expect.any(String) },
          },
        },
      ],
    });
    expect(JSON.stringify(collectBlocks.output.jsonSchema))
      .toMatch(/completed block targets.*unresolved/iu);
  });

  it("keeps Canonical ID Glob as the sole live selector contract", async () => {
    const activeSources = await Promise.all([
      sourceTree(new URL("../src/harness/", import.meta.url)),
      sourceTree(new URL("../../../runtime/sdk/typescript/src/", import.meta.url)),
      sourceTree(new URL(
        "../../../runtime/api/common/src/main/java/dev/mcagent/runtime/",
        import.meta.url,
      )),
      sourceTree(new URL(
        "../../../runtime/core/common/src/main/java/dev/mcagent/runtime/core/",
        import.meta.url,
      )),
    ]);
    const production = activeSources.flat().join("\n");

    expect(production).not.toMatch(
      /\b(?:block_id|item_id|entity_id|recipe_or_output_id)_regex\b/u,
    );
    expect(production).toContain("block_id_glob");
    expect(production).toContain("item_id_glob");
    expect(production).toContain("entity_id_glob");
    expect(production).toContain("recipe_or_output_id_glob");
  });

});

async function sourceTree(rootUrl: URL): Promise<readonly string[]> {
  const root = fileURLToPath(rootUrl);
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:java|ts)$/u.test(entry.name)) {
        found.push(await readFile(path, "utf8"));
      }
    }
  };
  await visit(root);
  return found;
}
