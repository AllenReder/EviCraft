import { describe, expect, it, vi } from "vitest";

import { AbilityRuntime } from "../src/harness/ability-runtime.js";
import { runtimeAbilities } from "../src/harness/abilities/index.js";

describe("manage_scaffold_materials Harness contract", () => {
  it("registers the five-action Runtime-backed policy Ability with closed Canonical results", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const definition = runtimeAbilities.find(({ name }) => name === "manage_scaffold_materials");

    expect(definition).toMatchObject({ execution: "body", concurrency: "exclusive" });
    const inputBranches = (definition?.input.jsonSchema.oneOf ?? []) as Array<{
      title?: unknown;
      description?: unknown;
      properties?: Record<string, { description?: unknown }>;
    }>;
    expect(inputBranches).toHaveLength(5);
    for (const branch of inputBranches) {
      expect(branch).toMatchObject({ title: expect.any(String), description: expect.any(String) });
      for (const property of Object.values(branch.properties ?? {})) {
        expect(property.description).toEqual(expect.any(String));
      }
    }
    expect(definition?.input.parse({})).toEqual({});
    expect(definition?.input.parse({ action: "read" })).toEqual({ action: "read" });
    for (const action of ["add", "delete", "set"] as const) {
      expect(definition?.input.parse({
        action,
        item_id_globs: ["minecraft:*dirt", "example:cheap_?tone"],
      })).toEqual({
        action,
        item_id_globs: ["minecraft:*dirt", "example:cheap_?tone"],
      });
    }
    expect(definition?.input.parse({ action: "clear" })).toEqual({ action: "clear" });
    expect(() => definition?.input.parse({ action: "set", item_id_globs: [] })).toThrow();
    expect(() => definition?.input.parse({
      action: "add", item_id_globs: ["minecraft:[a-z]_log"],
    })).toThrow();

    const policy = {
      action: "read" as const,
      item_id_globs: ["minecraft:*dirt"],
      effective_item_count: 3,
      effective_item_sample: ["minecraft:dirt", "minecraft:coarse_dirt", "minecraft:rooted_dirt"],
      carried_matching_items: [{ item_id: "minecraft:dirt", count: 12 }],
    };
    const call = vi.fn(async () => ({ ok: true as const, message: "scaffold policy", data: policy }));

    await expect(runtime.dispatch("manage_scaffold_materials", {}, {
      runtime: { call } as never,
    })).resolves.toEqual({ ok: true, message: "scaffold policy", data: policy });
    expect(call).toHaveBeenCalledWith("manage_scaffold_materials", {}, expect.any(AbortSignal));
    expect(() => definition?.output.parse({
      ok: true, message: "scaffold policy", data: { ...policy, registry_dump: [] },
    })).toThrow();
    expect(() => definition?.output.parse({
      ok: true,
      message: "scaffold policy",
      data: {
        ...policy,
        effective_item_count: 128,
        carried_matching_items: Array.from({ length: 129 }, (_, index) => ({
          item_id: `example:block_${index}`,
          count: 1,
        })),
      },
    })).toThrow("carried_matching_items must contain at most 128 items");
    const outputBranches = (definition?.output.jsonSchema.oneOf ?? []) as Array<{
      title?: unknown;
      description?: unknown;
      properties?: Record<string, {
        description?: unknown;
        properties?: Record<string, { description?: unknown; maxItems?: unknown }>;
      }>;
    }>;
    for (const branch of outputBranches) {
      expect(branch).toMatchObject({ title: expect.any(String), description: expect.any(String) });
      for (const property of Object.values(branch.properties ?? {})) {
        expect(property.description).toEqual(expect.any(String));
      }
      for (const property of Object.values(branch.properties?.data?.properties ?? {})) {
        expect(property.description).toEqual(expect.any(String));
      }
    }
    expect(outputBranches[0]?.properties?.data?.properties?.carried_matching_items?.maxItems).toBe(128);
    expect(runtime.typescriptSdk()).toContain("readonly manage_scaffold_materials:");
  });
});
