import { describe, expect, it, vi } from "vitest";

import { AbilityRuntime, ToolCallError } from "../src/harness/ability-runtime.js";
import { attack } from "../src/harness/abilities/built-in/attack.js";
import { break_block } from "../src/harness/abilities/built-in/break_block.js";
import { close_menu } from "../src/harness/abilities/built-in/close_menu.js";
import { observe_self } from "../src/harness/abilities/built-in/observe_self.js";
import {
  abilities,
  projectCompositeAbilities,
} from "../src/harness/abilities/index.js";
import {
  defineDirectRuntimeAbility,
  runtimeAbilityMapping,
} from "../src/harness/abilities/runtime-backed-ability.js";
import {
  RuntimeAdapter,
  type RuntimeSdkClient,
} from "../src/harness/runtime-adapter.js";

const targetUuid = "123e4567-e89b-42d3-a456-426614174000";

const expectedRuntimeMappingCatalogue = [
  { ability: "activate_block", kind: "direct", runtimeToolName: "activate_block" },
  { ability: "attack", kind: "direct", runtimeToolName: "attack" },
  { ability: "break_block", kind: "direct", runtimeToolName: "break_block" },
  { ability: "close_menu", kind: "direct", runtimeToolName: "close_gui" },
  { ability: "collect_items", kind: "direct", runtimeToolName: "collect_items" },
  { ability: "craft_on_current_surface", kind: "direct", runtimeToolName: "craft" },
  { ability: "drop_items", kind: "direct", runtimeToolName: "drop_items" },
  { ability: "eat", kind: "direct", runtimeToolName: "eat" },
  { ability: "enter_bed", kind: "direct", runtimeToolName: "enter_bed" },
  { ability: "equip_item", kind: "direct", runtimeToolName: "equip_item" },
  { ability: "goto", kind: "input_translated", runtimeToolName: "goto" },
  { ability: "goto_block_interaction_pose", kind: "direct", runtimeToolName: "goto_block_interaction_pose" },
  { ability: "goto_block_placement_pose", kind: "direct", runtimeToolName: "goto_block_placement_pose" },
  { ability: "interact_entity", kind: "direct", runtimeToolName: "interact_entity" },
  { ability: "manage_scaffold_materials", kind: "direct", runtimeToolName: "manage_scaffold_materials" },
  { ability: "place_block", kind: "direct", runtimeToolName: "place_block" },
  { ability: "throw_eye_of_ender", kind: "direct", runtimeToolName: "throw_eye_of_ender" },
  { ability: "use_item", kind: "direct", runtimeToolName: "use_item" },
  { ability: "use_item_on_block", kind: "direct", runtimeToolName: "use_item_on_block" },
  { ability: "wait", kind: "input_translated", runtimeToolName: "wait" },
] as const;

const expectedUnmappedAbilityNames = [
  "find_known_blocks",
  "lookup_recipe",
  "lookup_registry",
  "observe_block",
  "observe_blocks",
  "observe_entities",
  "observe_inventory",
  "observe_menu",
  "observe_self",
  "transfer_item",
  ...projectCompositeAbilities.map(({ name }) => name),
].sort();

const wronglyClassifiedObserveSelf = defineDirectRuntimeAbility({
  name: observe_self.name,
  description: observe_self.description,
  execution: observe_self.execution,
  input: observe_self.input,
  output: observe_self.output,
});
const attackWithoutMapping = Object.freeze({ ...attack });

describe("Runtime-backed Ability Adapter", () => {
  it("contains exactly the intended complete Runtime-backed Ability mapping catalogue", () => {
    expectRuntimeMappingConformance(abilities);
  });

  it("fails conformance for a missing Runtime-backed mapping", () => {
    expect(() => expectRuntimeMappingConformance(abilities.map((definition) => (
      definition.name === "attack" ? attackWithoutMapping : definition
    )))).toThrow();
  });

  it("fails conformance for a duplicate Ability mapping declaration", () => {
    expect(() => expectRuntimeMappingConformance([...abilities, attack])).toThrow();
  });

  it("fails conformance for a wrongly classified Observation Query Ability", () => {
    expect(() => expectRuntimeMappingConformance(abilities.map((definition) => (
      definition.name === "observe_self" ? wronglyClassifiedObserveSelf : definition
    )))).toThrow();
  });

  it("does not retain the obsolete runtimeTool helper export", async () => {
    const sharedRuntime = await import("../src/harness/abilities/shared/runtime.js");

    expect(sharedRuntime).not.toHaveProperty("runtimeTool");
  });

  it("dispatches attack through its same-name direct Runtime Tool mapping", async () => {
    const events: Array<Readonly<Record<string, unknown>>> = [];
    const client = fakeClient();
    client.startToolCall = vi.fn(() => ({
      taskId: 41,
      result: Promise.resolve({
        success: true,
        message: "target defeated",
        data: attackData(),
      }),
    }));
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push(event); } });
    await runtime.register(attack);

    await expect(runtime.dispatch("attack", { uuids: [targetUuid] }, {
      runtime: new RuntimeAdapter(client),
    })).resolves.toEqual({
      ok: true,
      message: "target defeated",
      data: attackData(),
    });

    expect(client.startToolCall).toHaveBeenCalledTimes(1);
    expect(client.startToolCall).toHaveBeenCalledWith("attack", { uuids: [targetUuid] });
    expect(runtimeAbilityMapping(attack)).toEqual({
      kind: "direct",
      runtimeToolName: "attack",
    });
    expect(runtime.modelTools()).toEqual([{
      name: "attack",
      description: "Attack explicit embodied Entity Track UUIDs, or currently visible hostile evidence when omitted. Does not flee or collect drops.",
      inputSchema: attack.input.jsonSchema,
      strict: false,
    }]);
    expect(runtime.typescriptSdk()).not.toContain("runtimeToolName");
    expect(events.find((event) => event.type === "ability_call_finished")).toMatchObject({
      ability: "attack",
      result: { ok: true, message: "target defeated", data: attackData() },
    });
    expect(JSON.stringify(events)).not.toContain("runtimeToolName");
  });

  it("dispatches break_block through one direct break_block mapping", async () => {
    const position = { x: 4, y: 64, z: -2 };
    const client = fakeClient();
    client.startToolCall = vi.fn(() => ({
      taskId: 44,
      result: Promise.resolve({
        success: true,
        message: "verified exact target disappearance",
        data: { position, observed_drop_entities: [] },
      }),
    }));
    const runtime = new AbilityRuntime();
    await runtime.register(break_block);

    await expect(runtime.dispatch("break_block", { position }, {
      runtime: new RuntimeAdapter(client),
    })).resolves.toEqual({
      ok: true,
      message: "verified exact target disappearance",
      data: { position, observed_drop_entities: [] },
    });

    expect(client.startToolCall).toHaveBeenCalledTimes(1);
    expect(client.startToolCall).toHaveBeenCalledWith("break_block", { position });
    expect(runtimeAbilityMapping(break_block)).toEqual({
      kind: "direct",
      runtimeToolName: "break_block",
    });
  });

  it("preserves Runtime task cancellation and interruption through attack dispatch", async () => {
    const client = fakeClient();
    let settle!: (value: {
      success: false;
      message: string;
      interrupted: true;
    }) => void;
    client.startToolCall = vi.fn(() => ({
      taskId: 42,
      result: new Promise((resolve) => { settle = resolve; }),
    }));
    client.taskCancel = vi.fn(async () => {
      settle({ success: false, message: "attack interrupted", interrupted: true });
      return { task_id: 42, cancelled: true };
    });
    const runtime = new AbilityRuntime();
    await runtime.register(attack);
    const controller = new AbortController();

    const result = runtime.dispatch("attack", { uuids: [targetUuid] }, {
      runtime: new RuntimeAdapter(client),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(client.startToolCall).toHaveBeenCalledOnce());
    controller.abort("operator stop");

    await expect(result).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "attack interrupted",
      data: {},
    });
    expect(client.taskCancel).toHaveBeenCalledWith(42);
  });

  it("rejects malformed attack results at the AbilityRuntime output-validation seam", async () => {
    const client = fakeClient();
    client.startToolCall = vi.fn(() => ({
      taskId: 43,
      result: Promise.resolve({ success: true, message: "malformed", data: {} }),
    }));
    const runtime = new AbilityRuntime();
    await runtime.register(attack);

    await expect(runtime.dispatch("attack", {}, {
      runtime: new RuntimeAdapter(client),
    })).rejects.toEqual(expect.objectContaining<Partial<ToolCallError>>({
      name: "ToolCallError",
      ability: "attack",
      message: expect.stringContaining("attack output.data"),
    }));
  });

  it("dispatches close_menu through its aliased close_gui direct Runtime Tool mapping", async () => {
    const events: Array<Readonly<Record<string, unknown>>> = [];
    const client = fakeClient();
    client.startToolCall = vi.fn(() => ({
      taskId: 44,
      result: Promise.resolve({ success: true, message: "menu closed", data: {} }),
    }));
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push(event); } });
    await runtime.register(close_menu);

    await expect(runtime.dispatch("close_menu", {}, {
      runtime: new RuntimeAdapter(client),
    })).resolves.toEqual({ ok: true, message: "menu closed", data: {} });

    expect(client.startToolCall).toHaveBeenCalledTimes(1);
    expect(client.startToolCall).toHaveBeenCalledWith("close_gui", {});
    expect(runtimeAbilityMapping(close_menu)).toEqual({
      kind: "direct",
      runtimeToolName: "close_gui",
    });
    expect(close_menu).toMatchObject({
      name: "close_menu",
      description: "Idempotently close the current Block Menu.",
      concurrency: "exclusive",
      execution: "body",
    });
    expect(runtime.modelTools()).toEqual([{
      name: "close_menu",
      description: "Idempotently close the current Block Menu.",
      inputSchema: close_menu.input.jsonSchema,
      strict: false,
    }]);
    expect(runtime.typescriptSdk()).toContain("readonly close_menu: CanonicalAbilityResult<{}, {}>;");
    expect(runtime.typescriptSdk()).not.toContain("close_gui");
    expect(events.find((event) => event.type === "ability_call_finished")).toMatchObject({
      ability: "close_menu",
      result: { ok: true, message: "menu closed", data: {} },
    });
    expect(JSON.stringify(events)).not.toContain("close_gui");
  });

  it("preserves expected Runtime failure through aliased close_menu dispatch", async () => {
    const client = fakeClient();
    client.startToolCall = vi.fn(() => ({
      taskId: 45,
      result: Promise.resolve({ success: false, message: "menu close failed", data: {} }),
    }));
    const runtime = new AbilityRuntime();
    await runtime.register(close_menu);

    await expect(runtime.dispatch("close_menu", {}, {
      runtime: new RuntimeAdapter(client),
    })).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "menu close failed",
      data: {},
    });
  });

  it("preserves Runtime task cancellation and interruption through aliased close_menu dispatch", async () => {
    const client = fakeClient();
    let settle!: (value: {
      success: false;
      message: string;
      interrupted: true;
    }) => void;
    client.startToolCall = vi.fn(() => ({
      taskId: 46,
      result: new Promise((resolve) => { settle = resolve; }),
    }));
    client.taskCancel = vi.fn(async () => {
      settle({ success: false, message: "menu close interrupted", interrupted: true });
      return { task_id: 46, cancelled: true };
    });
    const runtime = new AbilityRuntime();
    await runtime.register(close_menu);
    const controller = new AbortController();

    const result = runtime.dispatch("close_menu", {}, {
      runtime: new RuntimeAdapter(client),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(client.startToolCall).toHaveBeenCalledOnce());
    controller.abort("operator stop");

    await expect(result).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "menu close interrupted",
      data: {},
    });
    expect(client.taskCancel).toHaveBeenCalledWith(46);
  });

  it("rejects malformed close_menu results at the AbilityRuntime output-validation seam", async () => {
    const client = fakeClient();
    client.startToolCall = vi.fn(() => ({
      taskId: 47,
      result: Promise.resolve({
        success: true,
        message: "malformed",
        data: { unexpected: true },
      }),
    }));
    const runtime = new AbilityRuntime();
    await runtime.register(close_menu);

    await expect(runtime.dispatch("close_menu", {}, {
      runtime: new RuntimeAdapter(client),
    })).rejects.toEqual(expect.objectContaining<Partial<ToolCallError>>({
      name: "ToolCallError",
      ability: "close_menu",
      message: expect.stringContaining("close_menu output.data"),
    }));
  });
});

function attackData() {
  return {
    mode: "explicit_uuids" as const,
    requested_uuids: [targetUuid],
    completion: "all" as const,
    defeated_uuids: [targetUuid],
    lost_uuids: [],
    unreachable_uuids: [],
    strikes: 1,
    combat_by_entity: { [targetUuid]: { status: "defeated" as const, strikes: 1 } },
    observed_drop_entities: [],
  };
}

function expectRuntimeMappingConformance(
  definitions: ReadonlyArray<Parameters<typeof runtimeAbilityMapping>[0]>,
): void {
  const abilityNames = definitions.map(({ name }) => name);
  expect(new Set(abilityNames).size).toBe(abilityNames.length);

  const catalogue = definitions.flatMap((definition) => {
    const mapping = runtimeAbilityMapping(definition);
    return mapping === undefined ? [] : [{ ability: definition.name, ...mapping }];
  }).sort((left, right) => left.ability.localeCompare(right.ability));
  expect(catalogue).toEqual(expectedRuntimeMappingCatalogue);

  const unmappedAbilityNames = definitions
    .filter((definition) => runtimeAbilityMapping(definition) === undefined)
    .map(({ name }) => name)
    .sort();
  expect(unmappedAbilityNames).toEqual(expectedUnmappedAbilityNames);

  const runtimeToolNames = catalogue.map(({ runtimeToolName }) => runtimeToolName);
  expect(new Set(runtimeToolNames).size).toBe(runtimeToolNames.length);
}

function fakeClient(): RuntimeSdkClient {
  return {
    runtimeInfo: vi.fn(async () => ({ world_knowledge_profile: "grounded_evidence" })),
    ensureBot: vi.fn(), actorGet: vi.fn(), startToolCall: vi.fn(), taskCancel: vi.fn(),
    observe: vi.fn(async () => ({ observation_revision: 8, server_tick: 0, game_time: 0 })),
    afterTicks: vi.fn(() => new Promise<{ server_tick: number }>(() => {})),
    blockGet: vi.fn(), blockFind: vi.fn(), blockRegion: vi.fn(), entityList: vi.fn(),
    onOccurrence: vi.fn(() => () => {}), onDisconnect: vi.fn(() => () => {}), close: vi.fn(),
  };
}
