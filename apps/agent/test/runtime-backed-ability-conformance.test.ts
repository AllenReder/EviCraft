import { describe, expect, it } from "vitest";

import { abilities } from "../src/harness/abilities/index.js";
import { assertRuntimeAbilityToolWitnesses } from "../src/smoke/runtime-backed-ability-conformance.js";

describe("real Runtime-backed Ability conformance", () => {
  it("accepts tool.list descriptors as registration and execution witnesses", () => {
    const runtimeToolNames = [
      "activate_block",
      "attack",
      "break_block",
      "close_gui",
      "collect_items",
      "craft",
      "drop_items",
      "eat",
      "enter_bed",
      "equip_item",
      "goto",
      "goto_block_interaction_pose",
      "goto_block_placement_pose",
      "interact_entity",
      "manage_scaffold_materials",
      "place_block",
      "throw_eye_of_ender",
      "use_item",
      "use_item_on_block",
    ];
    const descriptors = [...runtimeToolNames.map((name) => ({
      name,
      execution: "body" as const,
      description: `Runtime-only description for ${name}`,
      input_schema: { type: "object", properties: { runtime_only: { type: "boolean" } } },
    })), { name: "wait", execution: "query" as const }];

    expect(() => assertRuntimeAbilityToolWitnesses(abilities, descriptors)).not.toThrow();
  });

  it("rejects Runtime execution metadata that would invalidate Harness body scheduling", () => {
    const attack = abilities.filter((ability) => ability.name === "attack");
    expect(() => assertRuntimeAbilityToolWitnesses(attack, [{ name: "attack", execution: "query" }]))
      .toThrow("attack: Harness body, Runtime query");
  });

  it("reports every mapped Runtime Tool missing from tool.list", () => {
    expect(() => assertRuntimeAbilityToolWitnesses(abilities, [
      { name: "attack", execution: "body" },
      { name: "close_gui", execution: "body" },
    ])).toThrowError(/activate_block.*break_block.*use_item_on_block/);
  });
});
