import { describe, expect, it } from "vitest";

import { AbilityRuntime } from "../src/harness/ability-runtime.js";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { abilities } from "../src/harness/abilities/index.js";
import { unavailableToolsForMenu } from "../src/harness/menu-tool-availability.js";

describe("Harness Ability catalog", () => {
  it("contains only the approved Runtime, Harness-local, and Composite names", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of abilities) {
      await runtime.register(definition);
    }

    expect(runtime.names).toEqual([
      "activate_block", "attack", "break_block", "close_menu", "collect_blocks", "collect_items", "craft", "drop_items", "eat", "enter_bed", "equip_item",
      "explore_and_return", "fill_bucket", "find_known_blocks", "goto", "goto_and_activate_block", "goto_and_break_block", "goto_and_place_block", "goto_and_use_item_on_block", "goto_block_interaction_pose", "goto_block_placement_pose",
      "interact_entity", "look_around", "lookup_recipe", "lookup_registry", "manage_scaffold_materials", "mine_down", "observe_block", "observe_blocks", "observe_entities",
      "observe_inventory", "observe_menu", "observe_self", "place_block", "place_block_nearby",
      "sleep_in_bed", "smelt_at_furnace", "suffocation_escape", "surface", "throw_eye_of_ender", "transfer_item",
      "tunnel_for_blocks", "use_item", "use_item_on_block", "wait",
    ]);
    expect(runtime.names).not.toContain("craft_on_current_surface");
    for (const removed of [
      "navigate", "interact_at", "interact_block", "use_item_on_block_face",
      "attack_entity", "fight_entity", "pickup", "drop_item", "entity_get",
      "inspect_gui", "transfer", "collect_nearby_items", "break_and_collect", "scaffold_materials",
    ]) {
      expect(runtime.names).not.toContain(removed);
    }
    expect(unavailableToolsForMenu("storage", new Set(runtime.names))).toContainEqual({
      error: "MENU_OPEN",
      tools: expect.arrayContaining([
        "activate_block", "break_block", "collect_blocks", "goto_and_activate_block", "goto_and_break_block", "goto_and_place_block",
        "goto_block_interaction_pose", "goto_block_placement_pose", "place_block", "place_block_nearby", "sleep_in_bed", "suffocation_escape", "use_item", "use_item_on_block",
      ]),
    });
    expect(JSON.stringify(unavailableToolsForMenu("storage", new Set(runtime.names))))
      .not.toContain("interact_at");
    expect(runtime.modelTools().map((tool) => tool.name)).toEqual(runtime.names);
    const observeBlocks = runtime.modelTools().find((tool) => tool.name === "observe_blocks");
    expect(observeBlocks).toMatchObject({
      description: expect.stringContaining("newest Turn Observation lacks"),
      inputSchema: {
        oneOf: [
          { properties: { radius: { default: 4, minimum: 1, maximum: 16 } } },
          { required: ["min", "max"] },
        ],
      },
    });
    const sdk = runtime.typescriptSdk();
    expect(sdk).not.toContain("readonly reason");
    expect(sdk).toContain("type AbilityInputMap = {");
    expect(sdk).toContain("type AbilityOutputMap = {");
    expect(sdk).toContain("type CanonicalAbilitySuccess<Data>");
    expect(sdk).toContain("readonly message: string");
    expect(sdk).toContain("readonly data: Data");
    for (const name of runtime.names) {
      expect(sdk.match(new RegExp(`readonly ${name}:`, "gu"))?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("stores every registered Ability in one definition module and removes former monoliths", async () => {
    const root = fileURLToPath(new URL("../src/harness/abilities/", import.meta.url));
    const builtIn = await readdir(`${root}/built-in`);
    const composites = await readdir(`${root}/project-composite`);
    const definitions = [...builtIn, ...composites]
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.slice(0, -3))
      .sort();

    expect(definitions).toEqual(abilities.map(({ name }) => name).sort());
    for (const file of composites.filter((candidate) => candidate.endsWith(".ts"))) {
      const source = await readFile(`${root}/project-composite/${file}`, "utf8");
      expect(source).toContain(`name: "${file.slice(0, -3)}"`);
      expect(source).toContain("input:");
      expect(source).toMatch(/(?:output:|\boutput,)/u);
      expect(source).toContain("async execute(");
    }
    const sharedCompositeSource = await readFile(`${root}/shared/composites.ts`, "utf8");
    expect(sharedCompositeSource).not.toMatch(/export (?:const|async function) execute[A-Z]/u);
    await expect(access(`${root}/../runtime-abilities.ts`)).rejects.toThrow();
    await expect(access(`${root}/../query-local-abilities.ts`)).rejects.toThrow();
    await expect(access(`${root}/../project-composite-abilities.ts`)).rejects.toThrow();
    await expect(access(`${root}/ability.ts`)).rejects.toThrow();
    await expect(access(`${root}/built-in/interact_at.ts`)).rejects.toThrow();
  });
});
