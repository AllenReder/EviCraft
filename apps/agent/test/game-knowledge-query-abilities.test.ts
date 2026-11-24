import { describe, expect, it, vi } from "vitest";

import { AbilityRuntime, ToolCallError } from "../src/index.js";
import { runtimeAbilities } from "../src/harness/abilities/index.js";
import {
  RuntimeAdapter,
  type RuntimeSdkClient,
} from "../src/harness/runtime-adapter.js";

describe("Game Knowledge Query Abilities", () => {
  it("preserves the exact registry and recipe Runtime Tool calls", async () => {
    const client = fakeClient();
    vi.mocked(client.startToolCall)
      .mockReturnValueOnce({
        taskId: 1,
        result: Promise.resolve({
          success: true,
          message: "registry matches",
          data: {
            kind: "entity",
            query: "zombie",
            candidates: [{
              kind: "entity",
              id: "minecraft:zombie",
              path: "zombie",
              name: "Zombie",
            }],
            truncated: false,
          },
        }),
      })
      .mockReturnValueOnce({
        taskId: 2,
        result: Promise.resolve({ success: true, message: "recipe matches", data: {} }),
      });
    const runtime = await queryRuntime();
    const adapter = new RuntimeAdapter(client);

    await expect(runtime.dispatch("lookup_registry", {
      kind: "entity",
      query: "zombie",
    }, { runtime: adapter })).resolves.toEqual({
      ok: true,
      message: "registry matches",
      data: {
        kind: "entity",
        query: "zombie",
        candidates: [{
          kind: "entity",
          id: "minecraft:zombie",
          path: "zombie",
          name: "Zombie",
        }],
        truncated: false,
      },
    });
    await expect(runtime.dispatch("lookup_recipe", {
      recipe_or_output_id_glob: "minecraft:*_pickaxe",
    }, { runtime: adapter })).resolves.toEqual({
      ok: true,
      message: "recipe matches",
      data: {},
    });

    expect(client.startToolCall).toHaveBeenNthCalledWith(1, "lookup_registry", {
      kind: "entity",
      query: "zombie",
    });
    expect(client.startToolCall).toHaveBeenNthCalledWith(2, "lookup_recipe", {
      recipe_or_output_id_glob: "minecraft:*_pickaxe",
    });
  });

  it.each([
    {
      name: "lookup_registry",
      input: { kind: "entity", query: "zombie" },
      malformedData: {},
    },
    {
      name: "lookup_recipe",
      input: { recipe_or_output_id_glob: "minecraft:*_pickaxe" },
      malformedData: { unexpected: true },
    },
  ] as const)("validates malformed $name results at the AbilityRuntime Tool Contract seam", async ({
    name,
    input,
    malformedData,
  }) => {
    const client = fakeClient();
    vi.mocked(client.startToolCall).mockReturnValue({
      taskId: 1,
      result: Promise.resolve({
        success: true,
        message: "malformed query result",
        data: malformedData,
      }),
    });
    const runtime = await queryRuntime();

    await expect(runtime.dispatch(name, input, {
      runtime: new RuntimeAdapter(client),
    })).rejects.toEqual(expect.objectContaining({
      name: ToolCallError.name,
      ability: name,
      message: expect.stringContaining(`${name} output`),
    }));
  });
});

async function queryRuntime(): Promise<AbilityRuntime> {
  const runtime = new AbilityRuntime();
  for (const name of ["lookup_registry", "lookup_recipe"] as const) {
    const definition = runtimeAbilities.find((candidate) => candidate.name === name);
    if (definition === undefined) throw new Error(`${name} Ability is not registered`);
    await runtime.register(definition);
  }
  return runtime;
}

function fakeClient(): RuntimeSdkClient {
  return {
    runtimeInfo: vi.fn(async () => ({ world_knowledge_profile: "grounded_evidence" })),
    ensureBot: vi.fn(),
    actorGet: vi.fn(),
    startToolCall: vi.fn(),
    taskCancel: vi.fn(),
    observe: vi.fn(async () => ({ observation_revision: 8, server_tick: 0, game_time: 0 })),
    afterTicks: vi.fn(() => new Promise<{ server_tick: number }>(() => {})),
    blockGet: vi.fn(),
    blockFind: vi.fn(),
    blockRegion: vi.fn(),
    entityList: vi.fn(),
    onOccurrence: vi.fn(() => () => {}),
    onDisconnect: vi.fn(() => () => {}),
    close: vi.fn(),
  };
}
