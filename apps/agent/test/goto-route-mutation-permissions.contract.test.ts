import { describe, expect, it, vi } from "vitest";

import { AbilityRuntime } from "../src/index.js";
import { runtimeAbilities } from "../src/harness/abilities/index.js";

const goto = runtimeAbilities.find((definition) => definition.name === "goto");
if (goto === undefined) throw new Error("goto Ability is not registered");

describe("goto Route Mutation Permission contract", () => {
  const presets = [
    { x: 4, z: -2 },
    { x: 4, y: 64, z: -2 },
    { y: 12 },
    { block_id_glob: "minecraft:*_log" },
  ] as const;

  it.each(presets)("accepts omitted and explicit permissions for %j", (preset) => {
    expect(goto.input.parse(preset)).toEqual(preset);
    expect(goto.input.parse({
      ...preset,
      route_mutation_permissions: ["OPEN", "PLACE"],
    })).toEqual({
      ...preset,
      route_mutation_permissions: ["OPEN", "PLACE"],
    });
  });

  it("rejects unknown and duplicate permissions as ordinary input failures", () => {
    expect(() => goto.input.parse({
      x: 4,
      z: -2,
      route_mutation_permissions: ["OPEN", "FLY"],
    })).toThrow();
    expect(() => goto.input.parse({
      x: 4,
      z: -2,
      route_mutation_permissions: ["BREAK", "BREAK"],
    })).toThrow(/unique/u);
  });

  it("publishes the optional unique enum set on every preset", () => {
    const schema = goto.input.jsonSchema as { readonly oneOf: readonly Array<Record<string, unknown>> };
    for (const branch of schema.oneOf) {
      expect(branch).toMatchObject({
        properties: {
          route_mutation_permissions: {
            type: "array",
            uniqueItems: true,
            items: { enum: ["OPEN", "BREAK", "PLACE"] },
          },
        },
      });
      expect(branch.required).not.toContain("route_mutation_permissions");
    }
  });

  it("forwards explicit permissions to the Runtime goal call", async () => {
    const runtime = new AbilityRuntime();
    await runtime.register(goto);
    const call = vi.fn(async () => ({
      ok: true as const,
      message: "arrived",
      data: { position: { x: 4.5, y: 64, z: -1.5 }, ground_y: 63 },
    }));
    const input = {
      x: 4,
      z: -2,
      route_mutation_permissions: ["OPEN"] as const,
    };

    await runtime.dispatch("goto", input, { runtime: { call } as never });

    expect(call).toHaveBeenCalledWith("goto", {
      goal: { kind: "column", x: 4, z: -2 },
      route_mutation_permissions: ["OPEN"],
    }, expect.any(AbortSignal));
  });
});
