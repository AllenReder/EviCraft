import { describe, expect, it, vi } from "vitest";

import {
  ActorUnavailableError,
  AbilityRuntime,
  ProgrammaticExecutionError,
  ToolCallError,
  defineAbility,
  defineCompositeAbility,
  type ScopedAbilityNamespace,
} from "../src/index.js";
import {
  knownBlockEvidenceSchema,
  projectCompositeAbilities,
  runtimeAbilities,
} from "../src/harness/abilities/index.js";
import { programmaticCodeContract } from "../src/harness/programmatic-code-contract.js";
import { normalizeTaskResult } from "../src/harness/runtime-adapter.js";
import { executeToolContract, projectToolContract } from "../src/harness/tool-contract.js";
import { toolSchema as s, type ToolSchema } from "../src/harness/tool-schema.js";

function testObject(fields: Readonly<Record<string, unknown>>): ToolSchema<Readonly<Record<string, unknown>>> {
  const annotated = Object.fromEntries(Object.entries(fields).map(([name, value]) => [
    name,
    isToolField(value)
      ? value
      : s.field(value as ToolSchema<unknown>, { description: `Test ${name}.` }),
  ]));
  return s.object(annotated as never) as ToolSchema<Readonly<Record<string, unknown>>>;
}

function testOneOf(...schemas: readonly ToolSchema<unknown>[]): ToolSchema<unknown> {
  const branches = schemas.map((schema, index) => s.branch(schema, {
    title: `Test branch ${index + 1}`,
    description: `Test exact-one branch ${index + 1}.`,
  }));
  return s.oneOf(...branches as never);
}

function isToolField(value: unknown): boolean {
  return value !== null && typeof value === "object" && "field" in value && value.field === true;
}

describe("Ability Runtime contract", () => {
  it("documents body actions and Composite progress without changing nested canonical semantics", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of [...runtimeAbilities, ...projectCompositeAbilities]) {
      if ([
        "attack", "collect_items", "throw_eye_of_ender", "wait",
        "mine_down", "surface", "tunnel_for_blocks",
      ].includes(definition.name)) await runtime.register(definition);
    }

    const sdk = runtime.typescriptSdk();
    for (const text of [
      "Exact embodied Entity Track UUIDs to attack",
      "Verified total item units collected.",
      "Verified terminal outcome of the thrown Ender Eye.",
      "Game time to wait in seconds",
      "Requested bounded descent depth in whole block levels.",
      "Verified number of bounded upward movement steps completed.",
      "Exact block positions verified broken while tunnelling.",
    ]) expect(sdk).toContain(text);
    expect(sdk).not.toMatch(/:\s*unknown\b/u);
    expect(sdk).not.toContain("readonly run_code:");

    const wait = runtimeAbilities.find((definition) => definition.name === "wait");
    if (wait === undefined) throw new Error("wait Ability is not registered");
    expect(wait.input.parse({ seconds: 0.5 })).toEqual({ seconds: 0.5 });
    expect(() => wait.input.parse({ seconds: 301 })).toThrow(/at most 300/u);
  });

  it("documents exact interaction targets, effects, and expected failure branches", async () => {
    const runtime = new AbilityRuntime();
    for (const name of ["activate_block", "break_block", "interact_entity", "place_block", "use_item_on_block"]) {
      const definition = runtimeAbilities.find((candidate) => candidate.name === name);
      if (definition === undefined) throw new Error(`${name} Ability is not registered`);
      await runtime.register(definition);
    }

    const tools = Object.fromEntries(runtime.modelTools().map((tool) => [tool.name, tool.inputSchema]));
    expect(tools.activate_block).toMatchObject({
      properties: { position: { description: expect.stringContaining("Exact current-dimension position") } },
    });
    expect(tools.interact_entity).toMatchObject({
      properties: {
        uuid: { examples: ["123e4567-e89b-42d3-a456-426614174000"] },
        hold_ticks: { minimum: -1, maximum: 1200 },
      },
    });
    const sdk = runtime.typescriptSdk();
    for (const text of [
      "Menu opened. Activation is verified by an open Block Menu.",
      "Stable reason the exact block disappearance was not verified.",
      "Exact embodied Entity Track UUID to interact with.",
      "Exact current-dimension anchor: bed foot, door lower half, or the single block. Every filled cell must be known air or a known replaceable block",
      "Adjacent block changed. Success is verified by one exact adjacent BlockState change.",
    ]) expect(sdk).toContain(text);

    const place = runtimeAbilities.find((definition) => definition.name === "place_block");
    if (place === undefined) throw new Error("place_block Ability is not registered");
    expect(() => place.input.parse({
      item_id: "minecraft:cobblestone",
      position: { x: 4, y: 64, z: -2 },
      face: "up",
    })).toThrow(/face is not supported/u);
  });

  it("documents item lifecycle and Menu action contracts with executor-owned omission semantics", async () => {
    const runtime = new AbilityRuntime();
    for (const name of ["close_menu", "drop_items", "eat", "equip_item", "transfer_item"]) {
      const definition = runtimeAbilities.find((candidate) => candidate.name === name);
      if (definition === undefined) throw new Error(`${name} Ability is not registered`);
      await runtime.register(definition);
    }

    const tools = Object.fromEntries(runtime.modelTools().map((tool) => [tool.name, tool.inputSchema]));
    expect(tools.drop_items).toMatchObject({
      properties: {
        item_id: { examples: ["minecraft:cobblestone"] },
        count: { minimum: 1, maximum: 999, examples: [16] },
      },
    });
    expect(tools.equip_item).toMatchObject({
      properties: {
        action: { description: expect.stringContaining("omission defaults to equip") },
        slot: { examples: ["mainhand"] },
      },
    });
    const equip = runtimeAbilities.find((definition) => definition.name === "equip_item");
    if (equip === undefined) throw new Error("equip_item Ability is not registered");
    expect(equip.input.parse({})).toEqual({});

    const sdk = runtime.typescriptSdk();
    for (const text of [
      "Verified ordinary item-entity UUIDs produced by the drop action.",
      "Verified food level after eating.",
      "Equipment summary. The result summarizes removed and retained worn items.",
      "Semantic source location debited by the move.",
      "Transfer verification mismatch.",
    ]) expect(sdk).toContain(text);
  });

  it("documents world evidence and knowledge-query contracts without diverging from validation", async () => {
    const runtime = new AbilityRuntime();
    for (const name of [
      "observe_block", "observe_blocks", "observe_entities",
      "find_known_blocks", "lookup_registry", "lookup_recipe",
    ]) {
      const definition = runtimeAbilities.find((candidate) => candidate.name === name);
      if (definition === undefined) throw new Error(`${name} Ability is not registered`);
      await runtime.register(definition);
    }

    const tools = Object.fromEntries(runtime.modelTools().map((tool) => [tool.name, tool]));
    expect(tools.find_known_blocks?.inputSchema).toMatchObject({
      properties: {
        block_id_glob: {
          description: expect.stringContaining("Full-match Canonical ID Glob"),
          examples: ["minecraft:*_log"],
        },
      },
    });
    expect(tools.observe_blocks?.inputSchema).toMatchObject({
      oneOf: [{ properties: { radius: { default: 4, examples: [2] } } }, { required: ["min", "max"] }],
    });
    expect(tools.lookup_registry?.inputSchema).toMatchObject({
      properties: {
        kind: {
          enum: [
            "item", "block", "entity", "biome", "structure",
            "item_tag", "block_tag", "biome_tag", "structure_tag",
          ],
        },
      },
    });
    const sdk = runtime.typescriptSdk();
    for (const text of [
      "Exact queried block position.",
      "Current embodied evidence verifies a BlockState.",
      "Nearest matching remembered block candidates, bounded to 32 entries.",
      "Stable observed entity UUID.",
      "Canonical registry or Tag identifier.",
      "Full-match Canonical ID Glob over canonical recipe ids",
    ]) expect(sdk).toContain(text);

    const find = runtimeAbilities.find((definition) => definition.name === "find_known_blocks");
    if (find === undefined) throw new Error("find_known_blocks Ability is not registered");
    expect(find.input.parse({ block_id_glob: "minecraft:*_log" })).toEqual({
      block_id_glob: "minecraft:*_log",
    });
    expect(() => find.input.parse({ block_id_glob: "minecraft:*_log", flags: "i" })).toThrow(/flags is not supported/u);
    const lookupRegistry = runtimeAbilities.find((definition) => definition.name === "lookup_registry");
    if (lookupRegistry === undefined) throw new Error("lookup_registry Ability is not registered");
    expect(lookupRegistry.input.parse({ kind: "entity", query: "zombie" })).toEqual({
      kind: "entity", query: "zombie",
    });
  });

  it("documents body-state observation inputs and verified canonical outputs in both Tool modes", async () => {
    const runtime = new AbilityRuntime();
    for (const name of ["observe_self", "observe_inventory", "observe_menu"]) {
      const definition = runtimeAbilities.find((candidate) => candidate.name === name);
      if (definition === undefined) throw new Error(`${name} Ability is not registered`);
      await runtime.register(definition);
    }

    for (const tool of runtime.modelTools()) {
      expect(tool.inputSchema).toEqual({
        type: "object", properties: {}, required: [], additionalProperties: false,
      });
    }
    const sdk = runtime.typescriptSdk();
    for (const text of [
      "Current health points.",
      "Current integer Feet Cell in the world.",
      "Aggregated verified item counts without raw slot indices.",
      "Current semantic furnace input stack, or null.",
      "Canonical status-effect registry identifier.",
    ]) expect(sdk).toContain(text);
    expect(sdk.match(/CanonicalAbilityResult</gu)?.length).toBe(4);
    expect(sdk).not.toContain("Promise<unknown>");

    const unavailable = { ok: false, error: "RUNTIME_FAILED", message: "unavailable", data: {} } as const;
    await expect(runtime.runCode("return await abilities.observe_inventory({});", {
      runtime: {
        async call() { return unavailable; },
        semantic: { async observeInventory() { return unavailable; } },
      } as never,
    })).resolves.toMatchObject({ result: unavailable });
  });

  it("derives the complete craft Native, Code SDK, parsing, and canonical result contract from annotations", async () => {
    const runtime = new AbilityRuntime();
    const primitive = runtimeAbilities.find((definition) => definition.name === "craft_on_current_surface");
    if (primitive === undefined) throw new Error("craft_on_current_surface Ability is not registered");
    // Exposed here only to inspect the annotation-derived contract; production keeps it internal.
    const { visibility: _internal, ...exposed } = primitive;
    await runtime.register(exposed);

    expect(runtime.modelTools()).toEqual([expect.objectContaining({
      name: "craft_on_current_surface",
      description: expect.stringContaining("current 2x2 inventory grid"),
      inputSchema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        required: ["item_id"],
        properties: {
          item_id: expect.objectContaining({
            description: expect.stringContaining("canonical item registry identifier"),
            examples: ["minecraft:crafting_table"],
          }),
          count: expect.objectContaining({
            description: expect.stringContaining("Desired number of new items to craft"),
            default: 1,
            examples: [4],
          }),
        },
      }),
    })]);

    const sdk = runtime.typescriptSdk();
    expect(sdk).toContain("type AbilityInputMap = {");
    expect(sdk).toContain("type AbilityOutputMap = {");
    expect(sdk.match(/type CanonicalAbilityResult</gu)).toHaveLength(1);
    expect(sdk).toContain('readonly craft_on_current_surface: CanonicalAbilityResult<');
    expect(sdk).toContain("canonical item registry identifier");
    expect(sdk).toContain("@default 1");
    expect(sdk).toContain('@example "minecraft:crafting_table"');
    expect(sdk).toContain("readonly crafted: number");
    expect(sdk).toContain("readonly carrying: number");

    const call = vi.fn(async () => ({
      ok: true as const,
      message: "crafted planks",
      data: { crafted: 4, carrying: 4 },
    }));
    await expect(runtime.dispatch("craft_on_current_surface", { item_id: "minecraft:oak_planks" }, {
      runtime: { call } as never,
    })).resolves.toEqual({
      ok: true,
      message: "crafted planks",
      data: { crafted: 4, carrying: 4 },
    });
    expect(call).toHaveBeenCalledWith("craft", { item_id: "minecraft:oak_planks" }, expect.any(AbortSignal));

    const expectedFailure = {
      ok: false as const,
      error: "RUNTIME_FAILED" as const,
      message: "missing ingredients",
      data: { failure_type: "missing_ingredients", missing: ["4x oak planks (have 0)"] },
    };
    await expect(runtime.runCode([
      'const result = await abilities.craft_on_current_surface({ item_id: "minecraft:crafting_table", count: 1 });',
      "return { ok: result.ok, error: result.ok ? null : result.error };",
    ].join("\n"), {
      runtime: { async call() { return expectedFailure; } } as never,
    })).resolves.toMatchObject({
      result: { ok: false, error: "RUNTIME_FAILED" },
      modelOutput: expect.not.stringContaining("missing ingredients"),
    });

    await expect(runtime.dispatch("craft_on_current_surface", { item_id: "minecraft:oak_planks" }, {
      runtime: { async call() {
        return { ok: true, message: "malformed", data: { crafted: 1, carrying: Number.NaN } };
      } } as never,
    })).rejects.toMatchObject({ name: "ToolCallError", ability: "craft_on_current_surface" });
  });

  it("declares and renders the concise canonical run_code output independently from rich audit data", async () => {
    expect(projectToolContract(programmaticCodeContract.tool)).toEqual({
      name: "run_code",
      description: programmaticCodeContract.tool.description,
      inputSchema: programmaticCodeContract.tool.input.jsonSchema,
      strict: false,
    });
    expect(programmaticCodeContract.tool.output.jsonSchema).toEqual({
      type: "object",
      properties: {
        logs: {
          type: "array",
          items: { type: "string" },
          description: "Ordered text explicitly printed by the Programmatic Execution.",
        },
        result: {
          description: "Optional lossless JSON value explicitly returned by the Programmatic Execution.",
        },
      },
      required: ["logs"],
      additionalProperties: false,
    });
    expect(programmaticCodeContract.tool.output.parse({
      logs: ["observed"],
      result: { ok: true, position: { x: 1, y: 64, z: 2 } },
    })).toEqual({
      logs: ["observed"],
      result: { ok: true, position: { x: 1, y: 64, z: 2 } },
    });
    const execution = await executeToolContract(
      programmaticCodeContract.tool,
      { description: "Inspect the current Actor", code: "return { ok: true };" },
      async () => ({
        logs: ["observed current Actor\n"],
        result: { ok: true },
      }),
    );
    expect(execution).toEqual({
      input: { description: "Inspect the current Actor", code: "return { ok: true };" },
      canonicalOutput: { logs: ["observed current Actor\n"], result: { ok: true } },
      modelContent: "observed current Actor\n{\n  \"ok\": true\n}",
    });
    expect(execution.modelContent).not.toMatch(/rootId|runtimeTrace|stdout/u);
    expect(programmaticCodeContract.renderSystemPromptContribution("SDK")).toContain(
      "Do not call `observe_blocks` routinely",
    );
    expect(programmaticCodeContract.renderSystemPromptContribution("SDK")).toContain(
      "with `ok`, readable `message`, and typed `data`; failures also include stable `error`",
    );
  });

  it("expresses bounded collections and annotated defaults through one schema vocabulary", () => {
    const bounded = testObject({
      radius: s.optional(s.number({ minimum: 1, maximum: 32 }), {
        description: "Test radius.",
        default: 8,
      }),
      blocks: s.array(s.string(), { minItems: 1, maxItems: 3, uniqueItems: true }),
    });

    expect(bounded.jsonSchema).toEqual({
      type: "object",
      properties: {
        radius: { type: "number", minimum: 1, maximum: 32, description: "Test radius.", default: 8 },
        blocks: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          description: "Test blocks.",
        },
      },
      required: ["blocks"],
      additionalProperties: false,
    });
    expect(bounded.parse({ blocks: ["stone", "dirt"] })).toEqual({ blocks: ["stone", "dirt"] });
    expect(() => bounded.parse({ radius: 0, blocks: ["stone"] })).toThrow("radius must be at least 1");
    expect(() => bounded.parse({ blocks: ["stone", "stone"] })).toThrow("blocks must contain unique items");

  });

  it("projects every Project Composite Ability directly through the shared Ability Contract", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of projectCompositeAbilities) await runtime.register(definition);

    expect(projectCompositeAbilities
      .filter(({ name }) => (
        name === "look_around" || name === "place_block_nearby" || name === "sleep_in_bed"
        || name === "smelt_at_furnace"
      ))
      .map((definition) => ({
        name: definition.name,
        compositeProgram: "compositeProgram" in definition && definition.compositeProgram,
      })))
      .toEqual([
        { name: "look_around", compositeProgram: true },
        { name: "place_block_nearby", compositeProgram: true },
        { name: "sleep_in_bed", compositeProgram: true },
        { name: "smelt_at_furnace", compositeProgram: true },
      ]);

    expect(runtime.names).toEqual([
      "collect_blocks",
      "craft",
      "explore_and_return",
      "fill_bucket",
      "goto_and_activate_block",
      "goto_and_break_block",
      "goto_and_place_block",
      "goto_and_use_item_on_block",
      "look_around",
      "mine_down",
      "place_block_nearby",
      "sleep_in_bed",
      "smelt_at_furnace",
      "suffocation_escape",
      "surface",
      "tunnel_for_blocks",
    ]);
    const sdk = runtime.typescriptSdk();
    for (const name of runtime.names) {
      expect(sdk.match(new RegExp(`readonly ${name}:`, "gu"))?.length).toBe(2);
    }
    for (const name of runtime.names) {
      expect(sdk).toContain(`readonly ${name}: CanonicalAbilityResult<`);
    }
    expect(sdk).not.toContain("Promise<unknown>");
    expect(sdk).not.toMatch(/readonly tunnel_for_blocks: \{ readonly start:/u);

    const tools = Object.fromEntries(runtime.modelTools().map((tool) => [tool.name, tool.inputSchema]));
    await expect(runtime.dispatch("mine_down", {
      depth: 1,
      mode: "legacy",
    })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "mine_down",
      message: expect.stringContaining("input.mode is not supported"),
    });
    await expect(runtime.dispatch("mine_down", { depth: 1 })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "mine_down",
      message: expect.stringContaining("input.direction is required"),
    });
    await expect(runtime.dispatch("tunnel_for_blocks", {
      block_id_glob: "minecraft:stone",
      direction: "north",
      max_length: 1,
      movement: {},
    })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "tunnel_for_blocks",
      message: expect.stringContaining("input.movement is not supported"),
    });
    await expect(runtime.dispatch("tunnel_for_blocks", {
      start: { x: 0, y: 64, z: 0 },
      block_id_glob: "minecraft:stone",
      direction: "north",
      max_length: 1,
    })).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "tunnel_for_blocks",
      message: expect.stringContaining("input.start is not supported"),
    });
    expect(tools.mine_down).toMatchObject({
      required: ["depth", "direction"],
      properties: {
        depth: { minimum: 1, maximum: 64 },
        direction: { enum: ["north", "east", "south", "west", "down"] },
      },
    });
    expect(tools.tunnel_for_blocks).toMatchObject({
      required: ["block_id_glob", "direction", "max_length"],
      properties: {
        max_length: { minimum: 1, maximum: 128 },
        direction: { enum: ["north", "east", "south", "west"] },
      },
    });
  });

  it("defines bounded excavation through the typed Composite Program form", () => {
    const excavation = projectCompositeAbilities.filter(({ name }) => (
      name === "mine_down" || name === "tunnel_for_blocks"
    ));

    expect(excavation).toHaveLength(2);
    expect(excavation).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "mine_down", execution: "composite", compositeProgram: true }),
      expect.objectContaining({ name: "tunnel_for_blocks", execution: "composite", compositeProgram: true }),
    ]));
  });

  it("defines collect_blocks through the typed Composite Program form", () => {
    const collectBlocks = projectCompositeAbilities.find(({ name }) => name === "collect_blocks");

    expect(collectBlocks).toMatchObject({
      name: "collect_blocks",
      execution: "composite",
      compositeProgram: true,
    });
  });

  it("preserves canonical goto failures through the public Programmatic Execution contract", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push(event); } });
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const interrupted = normalizeTaskResult({
      success: false,
      message: "navigation interrupted",
      interrupted: true,
      data: { position: { x: 117.5, y: 69, z: 179.5 }, ground_y: 69 },
    });

    const execution = await runtime.runCode([
      "const result = await abilities.goto({ x: 128, z: 0 });",
      "return { message: result.message };",
    ].join("\n"), {
      runtime: {
        async call() { return interrupted; },
      } as never,
    });

    expect(execution.result).toEqual({ message: "navigation interrupted" });
    expect(events.find((event) => event.type === "ability_call_finished" && event.ability === "goto"))
      .toMatchObject({
        outcome: "failed",
        result: { ok: false, message: "navigation interrupted" },
      });
    expect(runtime.typescriptSdk()).toContain("readonly goto:");
    expect(runtime.typescriptSdk()).not.toContain("readonly navigate:");
  });

  it("preserves expected self-observation failures in dependent query results", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const unavailable = normalizeTaskResult({
      success: false,
      message: "self observation unavailable",
    });

    await expect(runtime.runCode([
      "return await abilities.observe_block({ x: 0, y: 64, z: 0 });",
    ].join("\n"), {
      runtime: {
        async call() { return unavailable; },
      } as never,
    })).resolves.toMatchObject({ result: unavailable });
  });

  it("returns compact nearest remembered block candidates from the current dimension", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const blockFind = vi.fn();
    const runtimeAdapter = {
      async call(name: string) {
        if (name !== "get_self_status") throw new Error(`unexpected Runtime call: ${name}`);
        return selfStatusResult();
      },
      blockFind,
    } as never;

    blockFind.mockResolvedValueOnce({
      operation: "block.find", matches: [], has_more: false, complete: false,
    });
    await expect(runtime.dispatch("find_known_blocks", {
      block_id_glob: "minecraft:iron_ore",
    }, { runtime: runtimeAdapter })).resolves.toEqual({
      ok: true,
      message: "no matching remembered block evidence"
        + " (note: minecraft:iron_ore misses minecraft:deepslate_iron_ore; minecraft:*iron_ore matches both)",
      data: { matches: [], truncated: false },
    });
    expect(blockFind).toHaveBeenNthCalledWith(1,
      "minecraft:overworld", "minecraft:iron_ore", {
        origin: { x: 0, y: 64, z: 0 }, limit: 32,
      });

    const match = blockEvidence("minecraft:iron_ore", { x: 4, y: 12, z: -2 }, 3);
    blockFind.mockResolvedValueOnce({
      operation: "block.find", matches: [match], has_more: true, complete: false,
    });
    await expect(runtime.dispatch("find_known_blocks", {
      block_id_glob: "minecraft:iron_ore",
    }, { runtime: runtimeAdapter })).resolves.toEqual({
      ok: true,
      message: "found matching remembered block evidence"
        + " (note: minecraft:iron_ore misses minecraft:deepslate_iron_ore; minecraft:*iron_ore matches both)",
      data: {
        matches: [{ position: { x: 4, y: 12, z: -2 }, block_state: "minecraft:iron_ore" }],
        truncated: true,
      },
    });
    expect(blockFind).toHaveBeenNthCalledWith(2,
      "minecraft:overworld", "minecraft:iron_ore", {
        origin: { x: 0, y: 64, z: 0 }, limit: 32,
      });
  });

  it("publishes exact Runtime and Composite results with the strict goto intent union", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of [...runtimeAbilities, ...projectCompositeAbilities]) {
      await runtime.register(definition);
    }

    const sdk = runtime.typescriptSdk();
    expect(sdk).not.toMatch(/:\s*unknown\b/u);
    expect(sdk).toContain("block_id_glob");
    expect(sdk).not.toMatch(/goto\(input:.*readonly block\??:/u);

    const goto = runtimeAbilities.find(({ name }) => name === "goto");
    if (goto === undefined) throw new Error("goto Ability is not registered");
    expect(goto.input.jsonSchema).toMatchObject({
      oneOf: [
        { title: "XZ mode", description: expect.stringContaining("X/Z column") },
        { title: "XYZ mode", description: expect.stringContaining("exact integer Feet Cell") },
        { title: "Y mode", description: expect.stringContaining("requested elevation") },
        { title: "Block mode", description: expect.stringContaining("remembered block") },
      ],
    });
    expect(sdk).toContain("XZ mode. Navigate to a supported feet cell");
    expect(sdk).toContain("XYZ mode. First attempt the exact integer Feet Cell");
    expect(sdk).toContain('@example "minecraft:*_log"');
    expect(goto.input.parse({ x: 4, z: -2 })).toEqual({ x: 4, z: -2 });
    expect(goto.input.parse({ x: 4, y: 70, z: -2 })).toEqual({ x: 4, y: 70, z: -2 });
    expect(goto.input.parse({ y: 12 })).toEqual({ y: 12 });
    expect(goto.input.parse({ block_id_glob: "minecraft:*_log" })).toEqual({
      block_id_glob: "minecraft:*_log",
    });
    for (const invalid of [
      {},
      { x: 4 },
      { x: 4.5, z: -2 },
      { x: 4, z: -2, block_id_glob: "minecraft:*_log" },
      { block: "minecraft:*_log" },
    ]) {
      expect(() => goto.input.parse(invalid)).toThrow();
    }
    expect(goto.description).toContain("within three blocks");

    const findKnownBlocks = runtimeAbilities.find(({ name }) => name === "find_known_blocks");
    if (findKnownBlocks === undefined) throw new Error("find_known_blocks Ability is not registered");
    expect(findKnownBlocks.description).toContain("minecraft:*_log");
    expect(() => findKnownBlocks.output.parse({
      ok: true,
      message: "too many candidates",
      data: {
        matches: Array.from({ length: 33 }, (_, x) => ({
          position: { x, y: 64, z: 0 }, block_state: "minecraft:stone",
        })),
        truncated: true,
      },
    })).toThrow();

    const waterEvidence = {
      dimension: "minecraft:overworld",
      position: { x: 4, y: 62, z: -2 },
      state: "KNOWN_BLOCK" as const,
      block_state: "minecraft:water[level=0]",
      fluid: "minecraft:water[falling=false,level=0]",
      source: "raycast",
      observed_tick: 20,
      observation_revision: 3,
    };
    expect(knownBlockEvidenceSchema.parse(waterEvidence)).toEqual(waterEvidence);

    const observeBlocks = runtimeAbilities.find(({ name }) => name === "observe_blocks");
    if (observeBlocks === undefined) throw new Error("observe_blocks Ability is not registered");
    expect(observeBlocks.output.parse({
      ok: true,
      message: "bounded embodied block perception",
      data: {
        operation: "block.region",
        dimension: "minecraft:overworld",
        min: { x: 4, y: 62, z: -2 },
        size: { x: 1, y: 1, z: 1 },
        palette: [{
          state: "KNOWN_BLOCK",
          block_state: "minecraft:water[level=0]",
          fluid: "minecraft:water[falling=false,level=0]",
          source: "raycast",
          observed_tick: 20,
          observation_revision: 3,
        }],
        indices: [0],
        complete: true,
      },
    })).toMatchObject({ ok: true });
  });

  it("passes Agent-facing goto block_id_glob through to the Runtime", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const call = vi.fn(async () => ({
      ok: true as const,
      message: "arrived beside remembered block",
      data: { position: { x: 1.5, y: 64, z: 2.5 }, ground_y: 64 },
    }));

    await expect(runtime.runCode(
      'return await abilities.goto({ block_id_glob: "minecraft:*_log" });',
      { runtime: { call } as never },
    )).resolves.toMatchObject({ result: { ok: true } });
    expect(call).toHaveBeenCalledWith(
      "goto",
      { goal: { kind: "block", block_id_glob: "minecraft:*_log" } },
      expect.any(AbortSignal),
    );
  });

  it("validates exact activate_block success and closed Runtime failure data", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const position = { x: 4, y: 64, z: -2 };
    const call = vi.fn(async () => ({
      ok: true as const,
      message: "verified block activation",
      data: { position, outcome: "menu_opened" as const },
    }));

    await expect(runtime.dispatch("activate_block", { position }, {
      runtime: { call } as never,
    })).resolves.toEqual({
      ok: true,
      message: "verified block activation",
      data: { position, outcome: "menu_opened" },
    });
    expect(call).toHaveBeenCalledWith("activate_block", { position }, expect.any(AbortSignal));

    await expect(runtime.dispatch("activate_block", { position }, {
      runtime: { async call() {
        return {
          ok: true, message: "lever changed",
          data: { position, outcome: "block_state_changed", block_state: "minecraft:lever[powered=true]" },
        };
      } } as never,
    })).resolves.toMatchObject({
      ok: true,
      data: { position, outcome: "block_state_changed", block_state: "minecraft:lever[powered=true]" },
    });

    for (const failure_type of [
      "menu_open", "target_not_known_block", "target_changed",
      "out_of_reach", "occluded", "no_effect",
    ] as const) {
      await expect(runtime.dispatch("activate_block", { position }, {
        runtime: { async call() {
          return { ok: false, error: "RUNTIME_FAILED", message: "failed", data: { position, failure_type } };
        } } as never,
      })).resolves.toEqual({
        ok: false, error: "RUNTIME_FAILED", message: "failed", data: { position, failure_type },
      });
    }

    await expect(runtime.dispatch("activate_block", { position }, {
      runtime: { async call() {
        return { ok: false, error: "INTERRUPTED", message: "stopped", data: { position } };
      } } as never,
    })).resolves.toEqual({
      ok: false, error: "INTERRUPTED", message: "stopped", data: { position },
    });
    await expect(runtime.dispatch("activate_block", { position, hand: "off" }, {
      runtime: { call } as never,
    })).rejects.toThrow();

    for (const malformed of [
      { ok: true, message: "failed", data: { position, outcome: "block_state_changed" } },
      { ok: true, message: "failed", data: { position, outcome: "unknown" } },
      { ok: true, message: "failed", data: { position, outcome: "menu_opened", extra: true } },
      { ok: false, error: "RUNTIME_FAILED", message: "failed", data: { position } },
      { ok: false, error: "RUNTIME_FAILED", message: "failed", data: { position, failure_type: "unknown" } },
      { ok: false, error: "RUNTIME_FAILED", message: "failed", data: { position, failure_type: "no_effect", reason: "extra" } },
      { ok: false, error: "INTERRUPTED", message: "failed", data: {} },
      { ok: false, error: "INTERRUPTED", message: "failed", data: { position, reason: "extra" } },
    ]) {
      await expect(runtime.dispatch("activate_block", { position }, {
        runtime: { async call() { return malformed; } } as never,
      })).rejects.toMatchObject({ name: "ToolCallError", ability: "activate_block" });
    }
  });

  it("adapts break_block to one hidden left interaction and validates its exact result", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const position = { x: 4, y: 64, z: -2 };
    const call = vi.fn(async () => ({
      ok: true as const,
      message: "verified exact target disappearance",
      data: { position, observed_drop_entities: [] },
    }));

    await expect(runtime.dispatch("break_block", { position }, {
      runtime: { call } as never,
    })).resolves.toEqual({
      ok: true,
      message: "verified exact target disappearance",
      data: { position, observed_drop_entities: [] },
    });
    expect(call).toHaveBeenCalledWith("break_block", { position }, expect.any(AbortSignal));

    for (const failure_type of [
      "menu_open", "target_not_known_block", "target_changed", "out_of_reach",
      "occluded", "unsupported_shape", "unbreakable", "no_effect",
    ] as const) {
      await expect(runtime.dispatch("break_block", { position }, {
        runtime: { async call() {
          return { ok: false, error: "RUNTIME_FAILED", message: "failed", data: { position, failure_type } };
        } } as never,
      })).resolves.toEqual({
        ok: false, error: "RUNTIME_FAILED", message: "failed", data: { position, failure_type },
      });
    }

    const occluding_block = {
      position: { x: 3, y: 64, z: -2 },
      block_state: "minecraft:oak_leaves[persistent=true]",
    };
    await expect(runtime.dispatch("break_block", { position }, {
      runtime: { async call() {
        return {
          ok: false, error: "RUNTIME_FAILED", message: "target is occluded",
          data: { position, failure_type: "occluded", occluding_block },
        };
      } } as never,
    })).resolves.toEqual({
      ok: false, error: "RUNTIME_FAILED", message: "target is occluded",
      data: { position, failure_type: "occluded", occluding_block },
    });

    await expect(runtime.dispatch("break_block", { position }, {
      runtime: { async call() {
        return { ok: false, error: "INTERRUPTED", message: "stopped", data: { position } };
      } } as never,
    })).resolves.toEqual({
      ok: false, error: "INTERRUPTED", message: "stopped", data: { position },
    });
    await expect(runtime.dispatch("break_block", { position, hold_ticks: 20 }, {
      runtime: { call } as never,
    })).rejects.toThrow();

    for (const malformed of [
      { ok: true, message: "bad", data: {} },
      { ok: true, message: "bad", data: { position, dropped_entities: [] } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: { position } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: { position, failure_type: "unknown" } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: { position, failure_type: "no_effect", durability_used: 1 } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: {
        position, failure_type: "occluded", occluding_block: { position: { x: 3, y: 64 }, block_state: "minecraft:oak_leaves" },
      } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: {
        position, failure_type: "unbreakable", occluding_block,
      } },
      { ok: false, error: "INTERRUPTED", message: "bad", data: {} },
      { ok: false, error: "INTERRUPTED", message: "bad", data: { position, partial: true } },
    ]) {
      await expect(runtime.dispatch("break_block", { position }, {
        runtime: { async call() { return malformed; } } as never,
      })).rejects.toMatchObject({ name: "ToolCallError", ability: "break_block" });
    }
  });

  it("validates exact use_item_on_block effects, partial failures, and malformed Runtime data", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const position = { x: 4, y: 64, z: -2 };
    const item_id = "minecraft:flint_and_steel";
    const effect_position = { x: 3, y: 64, z: -2 };
    const call = vi.fn(async () => ({
      ok: true as const, message: "verified item use",
      data: {
        item_id, position, face: "west" as const, outcome: "adjacent_block_changed" as const,
        effect_position, block_state: "minecraft:fire[age=0]",
        consumed_count: 0, durability_used: 1,
      },
    }));

    await expect(runtime.dispatch("use_item_on_block", { item_id, position }, {
      runtime: { call } as never,
    })).resolves.toEqual({
      ok: true, message: "verified item use",
      data: {
        item_id, position, face: "west", outcome: "adjacent_block_changed",
        effect_position, block_state: "minecraft:fire[age=0]",
        consumed_count: 0, durability_used: 1,
      },
    });
    expect(call).toHaveBeenCalledWith(
      "use_item_on_block", { item_id, position }, expect.any(AbortSignal),
    );

    await expect(runtime.dispatch("use_item_on_block", {
      item_id: "minecraft:ender_eye", position,
    }, {
      runtime: { async call() {
        return {
          ok: true, message: "eye inserted",
          data: {
            item_id: "minecraft:ender_eye", position, face: "up",
            outcome: "target_block_changed", effect_position: position,
            block_state: "minecraft:end_portal_frame[eye=true,facing=north]",
            consumed_count: 1, durability_used: 0,
          },
        };
      } } as never,
    })).resolves.toMatchObject({ ok: true, data: { outcome: "target_block_changed" } });

    for (const failure_type of [
      "menu_open", "target_not_known_block", "target_changed", "item_not_found",
      "item_not_supported", "out_of_reach", "occluded", "no_effect", "verification_failed",
    ] as const) {
      await expect(runtime.dispatch("use_item_on_block", { item_id, position }, {
        runtime: { async call() {
          return {
            ok: false, error: "RUNTIME_FAILED", message: "failed",
            data: { item_id, position, failure_type },
          };
        } } as never,
      })).resolves.toMatchObject({ ok: false, data: { failure_type } });
    }

    await expect(runtime.dispatch("use_item_on_block", { item_id, position }, {
      runtime: { async call() {
        return {
          ok: false, error: "RUNTIME_FAILED", message: "partial failure",
          data: {
            item_id, position, failure_type: "verification_failed", face: "west",
            consumed_count: 0, durability_used: 1,
          },
        };
      } } as never,
    })).resolves.toMatchObject({ data: { durability_used: 1 } });

    await expect(runtime.dispatch("use_item_on_block", { item_id, position }, {
      runtime: { async call() {
        return { ok: false, error: "INTERRUPTED", message: "stopped", data: { item_id, position } };
      } } as never,
    })).resolves.toMatchObject({ ok: false, error: "INTERRUPTED" });

    await expect(runtime.dispatch("use_item_on_block", {
      item_id, position, face: "west",
    }, { runtime: { call } as never })).rejects.toThrow();

    for (const malformed of [
      { ok: true, message: "bad", data: { item_id, position, face: "west", outcome: "item_changed", consumed_count: 0 } },
      { ok: true, message: "bad", data: { item_id, position, face: "west", outcome: "target_block_changed", effect_position, block_state: "minecraft:fire", consumed_count: 0, durability_used: 0, extra: true } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: { item_id, position, failure_type: "unknown" } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: { item_id, position, failure_type: "no_effect", hand: "main" } },
      { ok: false, error: "INTERRUPTED", message: "bad", data: { position } },
    ]) {
      await expect(runtime.dispatch("use_item_on_block", { item_id, position }, {
        runtime: { async call() { return malformed; } } as never,
      })).rejects.toMatchObject({ name: "ToolCallError", ability: "use_item_on_block" });
    }
  });

  it("validates exact place_block results, closed failures, and malformed Runtime data", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const position = { x: 4, y: 64, z: -2 };
    const item_id = "minecraft:oak_stairs";
    const call = vi.fn(async () => ({
      ok: true as const, message: "verified placement",
      data: {
        item_id, position,
        block_state: "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]",
        consumed_count: 1,
        placed_blocks: [{ position, block_state: "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]" }],
      },
    }));

    await expect(runtime.dispatch("place_block", { item_id, position }, {
      runtime: { call } as never,
    })).resolves.toMatchObject({ ok: true, data: { item_id, position, consumed_count: 1 } });
    expect(call).toHaveBeenCalledWith(
      "place_block", { item_id, position }, expect.any(AbortSignal),
    );

    for (const failure_type of [
      "menu_open", "target_unknown", "target_occupied", "second_cell_not_free",
      "target_changed", "item_not_found", "item_not_block", "multi_cell_item", "no_support",
      "body_in_target", "entity_blocked", "out_of_reach", "occluded", "unsupported_shape",
      "no_effect", "verification_failed",
    ] as const) {
      await expect(runtime.dispatch("place_block", { item_id, position }, {
        runtime: { async call() {
          return {
            ok: false, error: "RUNTIME_FAILED", message: "failed",
            data: { item_id, position, failure_type },
          };
        } } as never,
      })).resolves.toMatchObject({ ok: false, data: { failure_type } });
    }

    await expect(runtime.dispatch("place_block", { item_id, position }, {
      runtime: { async call() {
        return {
          ok: false, error: "RUNTIME_FAILED", message: "partial",
          data: {
            item_id, position, failure_type: "verification_failed",
            block_state: "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]",
            consumed_count: 1,
          },
        };
      } } as never,
    })).resolves.toMatchObject({ data: { consumed_count: 1 } });

    await expect(runtime.dispatch("place_block", {
      item_id, position, face: "up",
    }, { runtime: { call } as never })).rejects.toThrow();

    for (const malformed of [
      { ok: true, message: "bad", data: { item_id, position, consumed_count: 1 } },
      { ok: true, message: "bad", data: { item_id, position, block_state: "minecraft:oak_stairs", consumed_count: 1, face: "up" } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: { item_id, position, failure_type: "unknown" } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: { item_id, position, failure_type: "no_effect", receipt: {} } },
      { ok: false, error: "INTERRUPTED", message: "bad", data: { position } },
    ]) {
      await expect(runtime.dispatch("place_block", { item_id, position }, {
        runtime: { async call() { return malformed; } } as never,
      })).rejects.toMatchObject({ name: "ToolCallError", ability: "place_block" });
    }
  });

  it("validates exact placement-pose results without exposing placement facts", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const item_id = "minecraft:oak_stairs";
    const position = { x: 4, y: 64, z: -2 };
    const feet = { x: 2, y: 64, z: -2 };
    const call = vi.fn(async () => ({
      ok: true as const,
      message: "verified placement pose",
      data: { item_id, position, feet },
    }));

    await expect(runtime.dispatch("goto_block_placement_pose", { item_id, position }, {
      runtime: { call } as never,
    })).resolves.toEqual({ ok: true, message: "verified placement pose", data: { item_id, position, feet } });
    expect(call).toHaveBeenCalledWith(
      "goto_block_placement_pose", { item_id, position }, expect.any(AbortSignal),
    );

    for (const failure_type of [
      "menu_open", "target_unknown", "target_occupied", "target_changed", "item_not_found",
      "item_not_block", "multi_cell_item", "no_support", "no_placement_pose",
    ] as const) {
      await expect(runtime.dispatch("goto_block_placement_pose", { item_id, position }, {
        runtime: { async call() {
          return { ok: false, error: "RUNTIME_FAILED", message: "failed", data: { item_id, position, failure_type } };
        } } as never,
      })).resolves.toMatchObject({ ok: false, error: "RUNTIME_FAILED", data: { failure_type } });
    }

    await expect(runtime.dispatch("goto_block_placement_pose", { item_id, position }, {
      runtime: { async call() {
        return { ok: false, error: "INTERRUPTED", message: "stopped", data: { item_id, position } };
      } } as never,
    })).resolves.toMatchObject({ ok: false, error: "INTERRUPTED", data: { item_id, position } });

    for (const malformed of [
      { ok: true, message: "bad", data: { item_id, position, feet, block_state: "minecraft:stone" } },
      { ok: true, message: "bad", data: { item_id, position } },
      { ok: false, error: "RUNTIME_FAILED", message: "bad", data: { item_id, position, failure_type: "occluded" } },
      { ok: false, error: "INTERRUPTED", message: "bad", data: { item_id, position, feet } },
    ]) {
      await expect(runtime.dispatch("goto_block_placement_pose", { item_id, position }, {
        runtime: { async call() { return malformed; } } as never,
      })).rejects.toMatchObject({ name: "ToolCallError", ability: "goto_block_placement_pose" });
    }
  });

  it("exposes Glob-and-UUID best-effort collect_items to the Agent", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) await runtime.register(definition);
    const call = vi.fn(async () => ({
      ok: true as const,
      message: "collected",
      data: {
        collected_entities: 1,
        collected_items: 1,
        skipped_entities: 1,
        radius: 8,
        selection: "item_id_glob" as const,
      },
    }));
    const runtimeAdapter = { call } as never;
    const itemEntityId = "00000000-0000-4000-8000-000000000064";

    await expect(runtime.dispatch("collect_items", { uuids: [itemEntityId] }, {
      runtime: { call: vi.fn(async () => ({
        ok: true as const, message: "collected exact drop", data: {
          collected_entities: 1, collected_items: 1, skipped_entities: 0,
          radius: 8, selection: "uuids" as const,
        },
      })) } as never,
    })).resolves.toMatchObject({ ok: true, data: { selection: "uuids" } });
    await runtime.runCode(`return await abilities.collect_items({ item_id_glob: "minecraft:cobblestone" });`, {
      runtime: runtimeAdapter,
    });

    expect(call).toHaveBeenCalledWith(
      "collect_items", { item_id_glob: "minecraft:cobblestone" }, expect.any(AbortSignal),
    );
    expect(runtime.modelTools().find(({ name }) => name === "collect_items")?.inputSchema)
      .toMatchObject({
        oneOf: expect.arrayContaining([
          expect.objectContaining({ required: ["item_id_glob"] }),
          expect.objectContaining({ required: ["uuids"] }),
        ]),
      });
    expect(runtime.typescriptSdk()).toContain("readonly collect_items:");
    expect(runtime.typescriptSdk()).not.toContain("readonly pickup:");
    expect(runtime.typescriptSdk()).not.toContain("open_blocks");
  });

  it("surfaces in bounded evidence-driven steps and stops after breathable evidence", async () => {
    const events: string[] = [];
    const observations = [
      {
        underwater: true,
        position: { x: 0.5, y: 60, z: 0.5 },
        feet: { x: 0, y: 60, z: 0 },
      },
      {
        underwater: true,
        position: { x: 0.5, y: 62, z: 0.5 },
        feet: { x: 0, y: 62, z: 0 },
      },
      {
        underwater: false,
        position: { x: 0.5, y: 64, z: 0.5 },
        feet: { x: 0, y: 64, z: 0 },
      },
    ];
    const runtime = new AbilityRuntime();
    await runtime.register(defineAbility({
      name: "observe_self",
      description: "Return scripted underwater state.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ ok: s.literal(true), message: s.string(), data: s.losslessJson() }),
      async execute() {
        events.push("observe_self");
        return { ok: true as const, message: "self", data: observations.shift()! };
      },
    }));
    await runtime.register(defineAbility({
      name: "goto",
      description: "Record elevation movement.",
      execution: "body",
      input: testObject({ x: s.integer(), y: s.integer(), z: s.integer() }),
      output: testObject({ ok: s.literal(true), message: s.string(), data: s.losslessJson() }),
      async execute(input) {
        events.push(`goto:${input.x},${input.y},${input.z}`);
        return { ok: true as const, message: "moved", data: {} };
      },
    }));
    const surface = projectCompositeAbilities.find(({ name }) => name === "surface");
    if (surface === undefined) throw new Error("surface Project Composite is not registered");
    await runtime.register(surface);

    await expect(runtime.dispatch("surface", {})).resolves.toMatchObject({
      ok: true,
      data: { ascent_steps: 2 },
    });
    expect(events).toEqual([
      "observe_self", "goto:0,62,0", "observe_self", "goto:0,64,0", "observe_self",
    ]);
  });

  it("dispatches nested Composite peers in one Root without statically occupying the Body gate", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push({ ...event }); } });
    const compiledLeaf = defineAbility({
      name: "compiled_leaf",
      description: "One Body leaf.",
      execution: "body",
      input: testObject({ value: s.integer() }),
      output: testObject({ ok: s.literal(true), value: s.integer() }),
      async execute(input) { return { ok: true, value: input.value }; },
    });
    type InnerAbilities = ScopedAbilityNamespace<readonly [typeof compiledLeaf]>;
    const compiledInner = defineCompositeAbility<InnerAbilities>()({
      name: "compiled_inner",
      description: "One Composite peer.",
      input: testObject({ value: s.integer() }),
      output: testObject({ ok: s.literal(true), value: s.integer() }),
      async execute(input, { abilities }) {
        return await abilities.compiled_leaf(input);
      },
    });
    type OuterAbilities = ScopedAbilityNamespace<readonly [typeof compiledInner]>;
    const compiledOuter = defineCompositeAbility<OuterAbilities>()({
      name: "compiled_outer",
      description: "A Composite-to-Composite chain.",
      input: testObject({ value: s.integer() }),
      output: testObject({ ok: s.literal(true), value: s.integer() }),
      async execute(input, { abilities }) {
        return await abilities.compiled_inner(input);
      },
    });
    for (const definition of [compiledLeaf, compiledInner, compiledOuter]) {
      await runtime.register(definition);
    }

    await expect(runtime.dispatch("compiled_outer", { value: 7 })).resolves.toEqual({ ok: true, value: 7 });
    expect(events.filter((event) => event.type === "ability_call_started")).toMatchObject([
      { ability: "compiled_outer", depth: 1 },
      { ability: "compiled_inner", depth: 2 },
      { ability: "compiled_leaf", depth: 3 },
    ]);
    expect(events.find((event) => event.ability === "compiled_inner" && event.type === "ability_call_started"))
      .toMatchObject({ parentExecutionId: expect.any(String) });
  });

  it("runs a Composite Program through a test-local precise Ability Namespace", async () => {
    const runtime = new AbilityRuntime();
    const typedLeaf = defineAbility({
      name: "typed_leaf",
      description: "Return one precisely typed local value.",
      concurrency: "safe",
      input: testObject({ value: s.integer() }),
      output: testObject({ value: s.integer() }),
      async execute(input) { return input; },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof typedLeaf]>;
    const typedComposite = defineCompositeAbility<LocalAbilities>()({
      name: "typed_composite",
      description: "Call one local Ability through the scoped namespace.",
      concurrency: "safe",
      input: testObject({ value: s.integer() }),
      output: testObject({ value: s.integer() }),
      async execute(input, context) {
        expect(Object.keys(context).sort()).toEqual(["abilities", "signal"]);
        expect(context.signal).toBeInstanceOf(AbortSignal);
        return await context.abilities.typed_leaf(input);
      },
    });
    for (const definition of [typedLeaf, typedComposite]) {
      await runtime.register(definition);
    }

    await expect(runtime.dispatch("typed_composite", { value: 7 })).resolves.toEqual({ value: 7 });
  });

  it("cancels queued children and drains active cleanup after a Composite Program returns", async () => {
    const runtime = new AbilityRuntime();
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    let childAborted = false;
    let releaseAbortFallback!: () => void;
    const abortFallback = new Promise<void>((resolve) => { releaseAbortFallback = resolve; });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let queuedStarted = false;
    const activeChild = defineAbility({
      name: "scoped_active_child",
      description: "Wait for local Composite Program cancellation and cleanup.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, context) {
        childStarted();
        await Promise.race([
          new Promise<void>((resolve) => {
            if (context.signal.aborted) {
              childAborted = true;
              resolve();
            } else {
              context.signal.addEventListener("abort", () => {
                childAborted = true;
                resolve();
              }, { once: true });
            }
          }),
          abortFallback,
        ]);
        await cleanup;
        return { ok: false as const, error: "INTERRUPTED" as const };
      },
    });
    const queuedChild = defineAbility({
      name: "scoped_queued_child",
      description: "Record an incorrectly started queued child.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() {
        queuedStarted = true;
        return { ok: true as const };
      },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof activeChild, typeof queuedChild]>;
    const composite = defineCompositeAbility<LocalAbilities>()({
      name: "returning_scoped_composite",
      description: "Return with one active and one queued direct child.",
      input: testObject({}),
      output: testObject({ returned: s.literal(true) }),
      async execute(_input, { abilities }) {
        void abilities.scoped_active_child({});
        await started;
        void abilities.scoped_queued_child({});
        return { returned: true as const };
      },
    });
    for (const definition of [activeChild, queuedChild, composite]) await runtime.register(definition);

    let settled = false;
    const result = runtime.dispatch("returning_scoped_composite", {})
      .finally(() => { settled = true; });
    await started;
    try {
      await vi.waitFor(() => expect(childAborted).toBe(true), { timeout: 200 });
      expect(queuedStarted).toBe(false);
      expect(settled).toBe(false);
      releaseCleanup();
      await expect(result).resolves.toEqual({ returned: true });
    } finally {
      releaseAbortFallback();
      releaseCleanup();
      await result.catch(() => undefined);
    }
  });

  it("cancels queued children and drains active cleanup after a Composite Program fails", async () => {
    const runtime = new AbilityRuntime();
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    let childAborted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let queuedStarted = false;
    const activeChild = defineAbility({
      name: "failure_scoped_active_child",
      description: "Wait for failed Composite Program cleanup.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, context) {
        childStarted();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        childAborted = true;
        await cleanup;
        return { ok: false as const, error: "INTERRUPTED" as const };
      },
    });
    const queuedChild = defineAbility({
      name: "failure_scoped_queued_child",
      description: "Must remain queued when the Composite Program fails.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() {
        queuedStarted = true;
        return { ok: true as const };
      },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof activeChild, typeof queuedChild]>;
    const composite = defineCompositeAbility<LocalAbilities>()({
      name: "failing_scoped_composite",
      description: "Fail with one active and one queued direct child.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute(_input, { abilities }) {
        void abilities.failure_scoped_active_child({});
        await started;
        void abilities.failure_scoped_queued_child({});
        throw new Error("program exploded");
      },
    });
    for (const definition of [activeChild, queuedChild, composite]) await runtime.register(definition);

    let settled = false;
    const result = runtime.dispatch("failing_scoped_composite", {})
      .finally(() => { settled = true; });
    await started;
    await vi.waitFor(() => expect(childAborted).toBe(true));
    expect(queuedStarted).toBe(false);
    expect(settled).toBe(false);
    releaseCleanup();

    await expect(result).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "failing_scoped_composite",
      message: "program exploded",
    });
  });

  it("drains started Composite Program cleanup after Root cancellation", async () => {
    const runtime = new AbilityRuntime();
    const controller = new AbortController();
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    let childAborted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const child = defineAbility({
      name: "root_canceled_scoped_child",
      description: "Observe combined Root and Composite Program cancellation.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute(_input, context) {
        childStarted();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        childAborted = true;
        await cleanup;
        throw context.signal.reason;
      },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof child]>;
    const composite = defineCompositeAbility<LocalAbilities>()({
      name: "root_canceled_scoped_composite",
      description: "Await one Root-canceled child.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute(_input, { abilities }) {
        return await abilities.root_canceled_scoped_child({});
      },
    });
    for (const definition of [child, composite]) await runtime.register(definition);

    let settled = false;
    const result = runtime.dispatch("root_canceled_scoped_composite", {}, { signal: controller.signal })
      .finally(() => { settled = true; });
    await started;
    controller.abort(new Error("operator stop"));
    await vi.waitFor(() => expect(childAborted).toBe(true));
    expect(settled).toBe(false);
    releaseCleanup();

    await expect(result).rejects.toMatchObject({
      name: "ToolCallError",
      message: "operator stop",
    });
  });

  it("recursively drains nested descendants without canceling sibling Composite Programs", async () => {
    const runtime = new AbilityRuntime();
    let nestedChildStarted!: () => void;
    const nestedStarted = new Promise<void>((resolve) => { nestedChildStarted = resolve; });
    let nestedChildAborted = false;
    let releaseNestedCleanup!: () => void;
    const nestedCleanup = new Promise<void>((resolve) => { releaseNestedCleanup = resolve; });
    let siblingChildStarted!: () => void;
    const siblingStarted = new Promise<void>((resolve) => { siblingChildStarted = resolve; });
    let siblingChildFinished!: () => void;
    const siblingFinished = new Promise<void>((resolve) => { siblingChildFinished = resolve; });
    let siblingChildAborted = false;
    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
    const nestedChild = defineAbility({
      name: "nested_owned_child",
      description: "Require cleanup owned by the nested Composite Program.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, context) {
        nestedChildStarted();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        nestedChildAborted = true;
        await nestedCleanup;
        return { ok: false as const, error: "INTERRUPTED" as const };
      },
    });
    const siblingChild = defineAbility({
      name: "sibling_owned_child",
      description: "Remain isolated from another Composite Program's cancellation.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ done: s.literal(true) }),
      async execute(_input, context) {
        siblingChildStarted();
        await Promise.race([
          siblingGate,
          new Promise<void>((resolve) => {
            if (context.signal.aborted) {
              siblingChildAborted = true;
              resolve();
            } else {
              context.signal.addEventListener("abort", () => {
                siblingChildAborted = true;
                resolve();
              }, { once: true });
            }
          }),
        ]);
        siblingChildFinished();
        return { done: true as const };
      },
    });
    type NestedAbilities = ScopedAbilityNamespace<readonly [typeof nestedChild]>;
    const nestedComposite = defineCompositeAbility<NestedAbilities>()({
      name: "nested_owner_composite",
      description: "Return only after its un-awaited descendant is drained.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ done: s.literal(true) }),
      async execute(_input, { abilities }) {
        void abilities.nested_owned_child({});
        await nestedStarted;
        return { done: true as const };
      },
    });
    type SiblingAbilities = ScopedAbilityNamespace<readonly [typeof siblingChild]>;
    const siblingComposite = defineCompositeAbility<SiblingAbilities>()({
      name: "sibling_owner_composite",
      description: "Await work isolated in a sibling Composite Program scope.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ done: s.literal(true) }),
      async execute(_input, { abilities }) {
        return await abilities.sibling_owned_child({});
      },
    });
    type OuterAbilities = ScopedAbilityNamespace<readonly [typeof nestedComposite, typeof siblingComposite]>;
    const outerComposite = defineCompositeAbility<OuterAbilities>()({
      name: "outer_owner_composite",
      description: "Run two sibling Composite Programs in one Root.",
      input: testObject({}),
      output: testObject({ done: s.literal(true) }),
      async execute(_input, { abilities }) {
        await Promise.all([
          abilities.nested_owner_composite({}),
          abilities.sibling_owner_composite({}),
        ]);
        return { done: true as const };
      },
    });
    for (const definition of [
      nestedChild, siblingChild, nestedComposite, siblingComposite, outerComposite,
    ]) await runtime.register(definition);

    let settled = false;
    const result = runtime.dispatch("outer_owner_composite", {})
      .finally(() => { settled = true; });
    await Promise.all([nestedStarted, siblingStarted]);
    await vi.waitFor(() => expect(nestedChildAborted).toBe(true));
    expect(siblingChildAborted).toBe(false);
    releaseSibling();
    await siblingFinished;
    expect(settled).toBe(false);
    releaseNestedCleanup();

    await expect(result).resolves.toEqual({ done: true });
  });

  it("bridges a locally canceled queued call through the global ordered commit chain", async () => {
    const runtime = new AbilityRuntime();
    let predecessorStarted!: () => void;
    const started = new Promise<void>((resolve) => { predecessorStarted = resolve; });
    let releasePredecessor!: () => void;
    const predecessorGate = new Promise<void>((resolve) => { releasePredecessor = resolve; });
    let laterExecuted!: () => void;
    const executed = new Promise<void>((resolve) => { laterExecuted = resolve; });
    let canceledStarted = false;
    let laterCommitted = false;
    const predecessor = defineAbility({
      name: "commit_chain_predecessor",
      description: "Hold the first safe commit slot.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ id: s.literal("predecessor") }),
      async execute() {
        predecessorStarted();
        await predecessorGate;
        return { id: "predecessor" as const };
      },
    });
    const canceledExclusive = defineAbility({
      name: "locally_canceled_exclusive",
      description: "Remain queued behind the active safe predecessor.",
      input: testObject({}),
      output: testObject({ id: s.literal("canceled") }),
      async execute() {
        canceledStarted = true;
        return { id: "canceled" as const };
      },
    });
    const later = defineAbility({
      name: "commit_chain_later",
      description: "Execute after local cancellation but commit after the predecessor.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ id: s.literal("later") }),
      async execute() {
        laterExecuted();
        return { id: "later" as const };
      },
    });
    type CancelerAbilities = ScopedAbilityNamespace<readonly [typeof canceledExclusive]>;
    const canceler = defineCompositeAbility<CancelerAbilities>()({
      name: "queued_call_canceler",
      description: "Return after submitting one exclusive child that remains queued.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ done: s.literal(true) }),
      async execute(_input, { abilities }) {
        void abilities.locally_canceled_exclusive({});
        return { done: true as const };
      },
    });
    type OuterAbilities = ScopedAbilityNamespace<readonly [typeof predecessor, typeof canceler, typeof later]>;
    const outer = defineCompositeAbility<OuterAbilities>()({
      name: "ordered_scope_parent",
      description: "Observe commitment across a locally canceled queued slot.",
      input: testObject({}),
      output: testObject({ commits: s.array(s.string()) }),
      async execute(_input, { abilities }) {
        const commits: string[] = [];
        const first = abilities.commit_chain_predecessor({}).then(() => { commits.push("predecessor"); });
        await started;
        await abilities.queued_call_canceler({});
        const tail = abilities.commit_chain_later({}).then(() => {
          laterCommitted = true;
          commits.push("later");
        });
        await Promise.all([first, tail]);
        return { commits };
      },
    });
    for (const definition of [predecessor, canceledExclusive, later, canceler, outer]) {
      await runtime.register(definition);
    }

    const result = runtime.dispatch("ordered_scope_parent", {});
    await executed;
    expect(canceledStarted).toBe(false);
    expect(laterCommitted).toBe(false);
    releasePredecessor();

    await expect(result).resolves.toEqual({ commits: ["predecessor", "later"] });
    expect(laterCommitted).toBe(true);
  });

  it("preserves cycle detection through the scoped Composite Program namespace", async () => {
    const runtime = new AbilityRuntime();
    type RecursiveAbilities = Readonly<{
      recursive_scoped_composite(input: Readonly<Record<string, unknown>>): Promise<{ ok: true }>;
    }>;
    const recursive = defineCompositeAbility<RecursiveAbilities>()({
      name: "recursive_scoped_composite",
      description: "Attempt one recursive scoped Composite Program call.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute(_input, { abilities }) {
        return await abilities.recursive_scoped_composite({});
      },
    });
    await runtime.register(recursive);

    await expect(runtime.dispatch("recursive_scoped_composite", {})).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "recursive_scoped_composite",
      message: expect.stringContaining("runtime Ability cycle"),
    });
  });

  it("does not let Composite Program source swallow Root-fatal Actor unavailability", async () => {
    const runtime = new AbilityRuntime();
    const actorFatalChild = defineAbility({
      name: "scoped_actor_fatal_child",
      description: "Report Root-fatal Actor unavailability.",
      input: testObject({}),
      output: testOneOf(
        testObject({ ok: s.literal(true), message: s.string(), data: testObject({}) }),
        testObject({
          ok: s.literal(false),
          error: s.literal("ACTOR_UNAVAILABLE"),
          message: s.string(),
          data: testObject({}),
        }),
      ),
      async execute() {
        return {
          ok: false as const,
          error: "ACTOR_UNAVAILABLE" as const,
          message: "Actor epoch changed",
          data: {},
        };
      },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof actorFatalChild]>;
    const composite = defineCompositeAbility<LocalAbilities>()({
      name: "actor_fatal_swallowing_composite",
      description: "Try to continue after one Root-fatal child call.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute(_input, { abilities }) {
        try { await abilities.scoped_actor_fatal_child({}); } catch {}
        return { ok: true as const };
      },
    });
    for (const definition of [actorFatalChild, composite]) await runtime.register(definition);

    await expect(runtime.dispatch("actor_fatal_swallowing_composite", {}))
      .rejects.toMatchObject({
        name: "ActorUnavailableError",
        message: "Actor epoch changed",
      });
  });

  it("does not let Composite Program source turn Root cancellation into success", async () => {
    const runtime = new AbilityRuntime();
    const controller = new AbortController();
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const canceledChild = defineAbility({
      name: "scoped_root_canceled_child",
      description: "Reject after observing Root cancellation.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute(_input, context) {
        childStarted();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw context.signal.reason;
      },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof canceledChild]>;
    const composite = defineCompositeAbility<LocalAbilities>()({
      name: "root_cancellation_swallowing_composite",
      description: "Try to report success after catching Root cancellation.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute(_input, { abilities }) {
        try { await abilities.scoped_root_canceled_child({}); } catch {}
        return { ok: true as const };
      },
    });
    const interruptedComposite = defineCompositeAbility<LocalAbilities>()({
      name: "root_cancellation_reporting_composite",
      description: "Preserve a canonical interruption after Root cancellation.",
      input: testObject({}),
      output: testObject({
        ok: s.literal(false),
        error: s.literal("INTERRUPTED"),
        message: s.string(),
        data: testObject({}),
      }),
      async execute(_input, { abilities }) {
        try { await abilities.scoped_root_canceled_child({}); } catch {}
        return {
          ok: false as const,
          error: "INTERRUPTED" as const,
          message: "composite interrupted",
          data: {},
        };
      },
    });
    for (const definition of [canceledChild, composite, interruptedComposite]) {
      await runtime.register(definition);
    }

    const result = runtime.dispatch(
      "root_cancellation_swallowing_composite",
      {},
      { signal: controller.signal },
    );
    await started;
    controller.abort(new Error("operator stop"));

    await expect(result).rejects.toMatchObject({ message: "operator stop" });

    const interruptedController = new AbortController();
    interruptedController.abort(new Error("operator stop"));
    await expect(runtime.dispatch(
      "root_cancellation_reporting_composite",
      {},
      { signal: interruptedController.signal },
    )).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: {},
    });
  });

  it("rejects Composite recursion through the generic Root dispatcher", async () => {
    const runtime = new AbilityRuntime();
    type RecursiveAbilities = Readonly<{
      recursive_composite(input: Readonly<Record<string, never>>): Promise<{ ok: true }>;
    }>;
    await runtime.register(defineCompositeAbility<RecursiveAbilities>()({
      name: "recursive_composite",
      description: "A recursion probe.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute(_input, { abilities }) {
        return await abilities.recursive_composite({});
      },
    }));

    await expect(runtime.dispatch("recursive_composite", {})).rejects.toMatchObject({
      name: "ToolCallError",
      ability: "recursive_composite",
      message: expect.stringContaining("runtime Ability cycle"),
    });
  });

  it("executes an acyclic Composite chain beyond the former depth-eight limit", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push({ ...event }); } });
    type DeepName = `deep_${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
    type DeepAbilities = Readonly<Record<DeepName, (
      input: Readonly<Record<string, never>>,
    ) => Promise<{ depth: number }>>>;
    for (let depth = 10; depth >= 0; depth -= 1) {
      const next = `deep_${depth + 1}` as DeepName;
      await runtime.register(defineCompositeAbility<DeepAbilities>()({
        name: `deep_${depth}` as DeepName,
        description: `Execute acyclic depth ${depth}.`,
        input: testObject({}),
        output: testObject({ depth: s.integer() }),
        async execute(_input, { abilities }) {
          if (depth === 10) return { depth };
          return await abilities[next]({});
        },
      }));
    }

    await expect(runtime.dispatch("deep_0", {})).resolves.toEqual({ depth: 10 });
    expect(events.filter((event) => event.type === "ability_call_started").at(-1))
      .toMatchObject({ ability: "deep_10", depth: 11 });
  });

  it("allows more than 1,024 dispatches in Composite and Programmatic Roots", async () => {
    const runtime = new AbilityRuntime();
    const countDispatch = defineAbility({
      name: "count_dispatch",
      description: "Return one dispatch index.",
      concurrency: "safe",
      input: testObject({ index: s.integer() }),
      output: testObject({ index: s.integer() }),
      async execute(input) { return input; },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof countDispatch]>;
    const dispatchMany = defineCompositeAbility<LocalAbilities>()({
      name: "dispatch_many",
      description: "Dispatch more than the former Root limit.",
      input: testObject({ count: s.integer() }),
      output: testObject({ count: s.integer() }),
      async execute(input, { abilities }) {
        for (let index = 0; index < input.count; index += 1) {
          await abilities.count_dispatch({ index });
        }
        return input;
      },
    });
    await runtime.register(countDispatch);
    await runtime.register(dispatchMany);

    await expect(runtime.dispatch("dispatch_many", { count: 1_025 })).resolves.toEqual({ count: 1_025 });
    await expect(runtime.runCode([
      "for (let index = 0; index < 1025; index += 1) {",
      "  await abilities.count_dispatch({ index });",
      "}",
      "return { count: 1025 };",
    ].join("\n"))).resolves.toMatchObject({ result: { count: 1_025 } });
  });

  it("classifies non-erasable TypeScript before Worker execution", async () => {
    const runtime = new AbilityRuntime();

    await expect(runtime.runCode("enum Direction { Up }\nreturn Direction.Up;"))
      .rejects.toEqual(expect.objectContaining({
        name: "ProgrammaticExecutionError",
        code: "typescript_not_erasable",
        rootId: expect.any(String),
        executionId: expect.any(String),
      } satisfies Partial<ProgrammaticExecutionError>));
  });

  it("classifies a Programmatic Execution runtime exception separately from Tool failures", async () => {
    const runtime = new AbilityRuntime();

    await expect(runtime.runCode("throw new Error('program exploded');"))
      .rejects.toEqual(expect.objectContaining({
        name: "ProgrammaticExecutionError",
        code: "worker_runtime_error",
        message: "program exploded",
        rootId: expect.any(String),
        executionId: expect.any(String),
      } satisfies Partial<ProgrammaticExecutionError>));
  });

  it("classifies a final value that cannot be represented as lossless JSON", async () => {
    const runtime = new AbilityRuntime();

    await expect(runtime.runCode("return { count: 1n };"))
      .rejects.toEqual(expect.objectContaining({
        name: "ProgrammaticExecutionError",
        code: "result_not_lossless_json",
      } satisfies Partial<ProgrammaticExecutionError>));
    await expect(runtime.runCode("return { callback() {} };"))
      .rejects.toEqual(expect.objectContaining({
        name: "ProgrammaticExecutionError",
        code: "result_not_lossless_json",
      } satisfies Partial<ProgrammaticExecutionError>));
  });

  it("classifies malformed Worker RPC separately from ordinary Ability validation", async () => {
    const runtime = new AbilityRuntime();
    await runtime.register(defineAbility({
      name: "rpc_probe",
      description: "Accept one JSON string.",
      input: testObject({ value: s.string() }),
      output: testObject({ ok: s.literal(true) }),
      async execute() { return { ok: true }; },
    }));

    await expect(runtime.runCode([
      "try { await abilities.rpc_probe({ value: () => 'not JSON' }); } catch {}",
      "return { continued: true };",
    ].join("\n"))).rejects.toEqual(expect.objectContaining({
      name: "ProgrammaticExecutionError",
      code: "rpc_protocol_error",
    } satisfies Partial<ProgrammaticExecutionError>));
  });

  it("gives a program no way to reach Node from its own context", async () => {
    const runtime = new AbilityRuntime();

    await expect(runtime.runCode([
      "const reachable = [typeof process, typeof require, typeof module, typeof globalThis.process];",
      "let viaConstructor = 'unreachable';",
      "try { viaConstructor = console.log.constructor('return typeof process')(); } catch {}",
      "let imported = 'refused';",
      "try { await import('node:fs'); imported = 'loaded'; } catch {}",
      "return { reachable, viaConstructor, imported };",
    ].join("\n"))).resolves.toMatchObject({
      result: {
        reachable: ["undefined", "undefined", "undefined", "undefined"],
        viaConstructor: "undefined",
        imported: "refused",
      },
    });
  });

  it("contains old-generation heap exhaustion inside the Worker", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: {
        busyMs: 10_000,
        pausedMs: 10_000,
        maxOldGenerationSizeMb: 16,
      },
    });

    await expect(runtime.runCode([
      "const retained = [];",
      "while (true) retained.push(new Array(10_000).fill(Math.random()));",
    ].join("\n"))).rejects.toEqual(expect.objectContaining({
      name: "ProgrammaticExecutionError",
      code: "worker_crash",
      message: expect.stringMatching(/memory|heap|resource limit/iu),
    } satisfies Partial<ProgrammaticExecutionError>));
  });

  it("terminates a Programmatic Execution that spends too long without acting or waiting", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { pausedMs: 30 },
    });

    await expect(runtime.runCode("await new Promise(() => {});"))
      .rejects.toEqual(expect.objectContaining({
        name: "ProgrammaticExecutionError",
        code: "worker_wall_timeout",
      } satisfies Partial<ProgrammaticExecutionError>));
  });

  it("terminates CPU-bound code that exceeds its Worker busy-time limit", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { busyMs: 25, pausedMs: 1_000 },
    });

    await expect(runtime.runCode("while (true) {}"))
      .rejects.toEqual(expect.objectContaining({
        name: "ProgrammaticExecutionError",
        code: "worker_busy_timeout",
      } satisfies Partial<ProgrammaticExecutionError>));
  });

  it("truncates one over-long log line with a visible marker and continues the execution", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { maxOutputBytes: 128 },
    });

    const execution = await runtime.runCode("console.log('界'.repeat(80));");

    // The truncated line keeps its visible marker inside the byte budget; the
    // per-stream truncation notice does not fit beside it and is dropped, so
    // the joined lines stay within the budget and no further marker is needed.
    const truncated = "界".repeat(35) + "…[output truncated]";
    expect(execution.modelOutput).toBe(truncated + "\n");
    expect(Buffer.byteLength(execution.modelOutput)).toBeLessThanOrEqual(128);
    expect(execution.logs).toEqual([{ stream: "stdout", text: "界".repeat(80) + "\n" }]);
  });

  it("keeps later lines intact after truncating an over-long log line", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { maxOutputBytes: 64 },
    });

    const execution = await runtime.runCode([
      "console.log('x'.repeat(80));",
      "console.log('after');",
    ].join("\n"));

    // The truncated prefix leaves no room for anything else inside the budget,
    // so the newest line is kept instead and the omitted notice records the
    // dropped one — all within the budget, with no further marker appended.
    expect(execution.modelOutput).toBe(
      "[run_code: 1 earlier line(s) omitted due to output limit]\nafter\n",
    );
    expect(Buffer.byteLength(execution.modelOutput)).toBeLessThanOrEqual(64);
    expect(execution.modelOutput).not.toContain("x".repeat(80));
  });

  it("drops the oldest lines on total log overflow and injects an omitted notice", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { maxOutputBytes: 128 },
    });

    const source = [
      "for (let line = 1; line <= 20; line += 1) {",
      "  console.log(`line-${String(line).padStart(3, '0')}-xxxxxxxxxxxxxxxxxxxx`);",
      "}",
    ].join("\n");
    const execution = await runtime.runCode(source);

    // The omitted notice is reserved within the byte budget, so only the two
    // newest lines fit beside it; the joined lines stay within the budget and
    // no marker is appended beyond them.
    expect(execution.modelOutput).toBe([
      "[run_code: 18 earlier line(s) omitted due to output limit]",
      "line-019-xxxxxxxxxxxxxxxxxxxx",
      "line-020-xxxxxxxxxxxxxxxxxxxx",
    ].join("\n") + "\n");
    expect(Buffer.byteLength(execution.modelOutput)).toBeLessThanOrEqual(128);
    expect(execution.logs).toHaveLength(20);
  });

  it("keeps the newest lines within the output budget on total log overflow", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { maxOutputBytes: 64 },
    });

    const source = [
      "for (let line = 1; line <= 10; line += 1) {",
      "  console.log(`line-${String(line).padStart(3, '0')}-xxxxxxxxxxxxxxxxxxxx`);",
      "}",
    ].join("\n");
    const execution = await runtime.runCode(source);

    // No retained line fits beside the omitted notice, so the notice alone is
    // the model-visible output — the model still learns that all ten lines
    // were produced and then omitted, and the byte budget holds.
    expect(execution.modelOutput).toBe(
      "[run_code: 10 earlier line(s) omitted due to output limit]\n",
    );
    expect(Buffer.byteLength(execution.modelOutput)).toBeLessThanOrEqual(64);
  });

  it("truncates an oversized rendered returned value instead of failing the execution", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { maxOutputBytes: 64 },
    });

    const execution = await runtime.runCode("return { value: 'x'.repeat(80) };");


    expect(execution.result).toEqual({ value: "x".repeat(80) });
    expect(execution.modelOutput.endsWith("…[output truncated]")).toBe(true);
    expect(execution.modelOutput.startsWith('{\n  "value": "xxx')).toBe(true);
    expect(execution.modelOutput).not.toContain("x".repeat(80));
    expect(Buffer.byteLength(execution.modelOutput)).toBeLessThanOrEqual(64);
  });

  it("never cuts into the retained log lines when an oversized returned value follows near-budget logs", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { maxOutputBytes: 128 },
    });

    const execution = await runtime.runCode([
      "console.log('y'.repeat(100));",
      "return { value: 'x'.repeat(200) };",
    ].join("\n"));

    // The retained log line stands complete; only the returned-value render is
    // truncated, and the marker stays inside the byte budget.
    expect(execution.modelOutput.startsWith("y".repeat(100) + "\n")).toBe(true);
    expect(execution.modelOutput.endsWith("…[output truncated]")).toBe(true);
    expect(Buffer.byteLength(execution.modelOutput)).toBeLessThanOrEqual(128);
  });

  it("renders logs alone when they fill the budget and the returned value has no room", async () => {
    const runtime = new AbilityRuntime({
      testingProgrammaticExecutionLimits: { maxOutputBytes: 64 },
    });

    const execution = await runtime.runCode([
      "for (let line = 1; line <= 20; line += 1) {",
      "  console.log(`line-${String(line).padStart(3, '0')}-xxxxxxxxxxxxxxxxxxxx`);",
      "}",
      "return { value: 'x'.repeat(200) };",
    ].join("\n"));

    // The bounded logs leave no room for any of the returned value, so the
    // render is truncated at the body budget — inside the logs' own omitted
    // notice rather than inside a retained log line — and the oversized
    // returned value does not appear.
    expect(execution.modelOutput).toBe(
      "[run_code: 20 earlier line(s) omitted due t…[output truncated]",
    );
    expect(execution.modelOutput).not.toContain("x".repeat(80));
    expect(Buffer.byteLength(execution.modelOutput)).toBeLessThanOrEqual(64);
  });

  it("runs each Programmatic Execution in a fresh empty context and captures its printed output", async () => {
    const runtime = new AbilityRuntime();
    const source = [
      "globalThis.__programmaticCounter = (globalThis.__programmaticCounter ?? 0) + 1;",
      "console.log('console output');",
      "console.error('console error');",
      "return { counter: globalThis.__programmaticCounter };",
    ].join("\n");

    const expected = {
      result: { counter: 1 },
      logs: [
        { stream: "stdout", text: "console output\n" },
        { stream: "stderr", text: "console error\n" },
      ],
      modelOutput: [
        "console output",
        "console error",
        "{",
        '  "counter": 1',
        "}",
      ].join("\n"),
    };
    await expect(runtime.runCode(source)).resolves.toMatchObject({ rootId: expect.any(String), ...expected });
    await expect(runtime.runCode(source)).resolves.toMatchObject({ rootId: expect.any(String), ...expected });
  });

  it("represents Programmatic Execution as the parent of its direct Ability calls", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push({ ...event }); } });
    await runtime.register(defineAbility({
      name: "programmatic_tree_probe",
      description: "Return one value beneath a Programmatic Execution node.",
      concurrency: "safe",
      input: testObject({ value: s.integer() }),
      output: testObject({ value: s.integer() }),
      async execute(input) { return input; },
    }));

    const result = await runtime.runCode(
      "return await abilities.programmatic_tree_probe({ value: 7 });",
    );

    expect(result).toMatchObject({
      rootId: expect.any(String),
      executionId: expect.any(String),
      result: { value: 7 },
    });
    expect(events.filter((event) => event.type.endsWith("_started"))).toMatchObject([
      {
        type: "programmatic_execution_started",
        rootId: result.rootId,
        executionId: result.executionId,
        depth: 1,
      },
      {
        type: "ability_call_started",
        rootId: result.rootId,
        executionId: expect.any(String),
        parentExecutionId: result.executionId,
        ability: "programmatic_tree_probe",
        depth: 2,
      },
    ]);
    expect(events.filter((event) => event.type.endsWith("_finished"))).toMatchObject([
      {
        type: "ability_call_finished",
        rootId: result.rootId,
        executionId: expect.any(String),
        ability: "programmatic_tree_probe",
        outcome: "succeeded",
      },
      {
        type: "programmatic_execution_finished",
        rootId: result.rootId,
        executionId: result.executionId,
        outcome: "succeeded",
      },
    ]);
    expect(events.find((event) => event.type === "ability_call_started")).toEqual({
      type: "ability_call_started",
      rootId: result.rootId,
      executionId: expect.any(String),
      parentExecutionId: result.executionId,
      ability: "programmatic_tree_probe",
      concurrency: "safe",
      execution: "query",
      depth: 2,
      dispatchCount: 1,
      input: { value: 7 },
      source: "agent",
    });
  });

  it("fixes the Worker Ability names when Programmatic Execution starts", async () => {
    let gateStarted!: () => void;
    const started = new Promise<void>((resolve) => { gateStarted = resolve; });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const runtime = new AbilityRuntime({
      onEvent: async (event) => {
        if (event.type !== "programmatic_execution_started") return;
        await expect(runtime.register(defineAbility({
          name: "registered_after_programmatic_start",
          description: "Must not appear in the already-started Worker namespace.",
          concurrency: "safe",
          input: testObject({}),
          output: testObject({ ok: s.literal(true) }),
          async execute() { return { ok: true }; },
        }))).rejects.toThrow("catalogue is frozen");
      },
    });
    await runtime.register(defineAbility({
      name: "programmatic_namespace_gate",
      description: "Hold the Worker while its fixed Ability names are inspected.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() {
        gateStarted();
        await gate;
        return { ok: true };
      },
    }));

    const result = runtime.runCode([
      "await abilities.programmatic_namespace_gate({});",
      "return Object.keys(abilities);",
    ].join("\n"));
    await started;
    releaseGate();

    await expect(result).resolves.toMatchObject({
      result: ["programmatic_namespace_gate"],
    });
  });

  it("renders an explicit completion message when a program prints and returns nothing", async () => {
    await expect(new AbilityRuntime().runCode("return;")).resolves.toMatchObject({
      logs: [],
      modelOutput: "(run_code completed with no output)",
    });
  });

  it("lets explicitly safe Queries overlap while exclusive Body calls form ordered barriers", async () => {
    const runtime = new AbilityRuntime();
    const events: string[] = [];
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
    await runtime.register(defineAbility({
      name: "query_probe",
      description: "Run a concurrency-safe query.",
      concurrency: "safe",
      input: testObject({ id: s.string() }),
      output: testObject({ id: s.string() }),
      async execute(input) {
        events.push(`query:start:${input.id}`);
        await queryGate;
        events.push(`query:end:${input.id}`);
        return input;
      },
    }));
    await runtime.register(defineAbility({
      name: "body_probe",
      description: "Run one exclusive Body operation.",
      execution: "body",
      input: testObject({ id: s.string() }),
      output: testObject({ id: s.string() }),
      async execute(input) {
        events.push(`body:start:${input.id}`);
        await bodyGate;
        events.push(`body:end:${input.id}`);
        return input;
      },
    }));

    const result = runtime.runCode([
      "const first = abilities.query_probe({ id: 'first' });",
      "const second = abilities.query_probe({ id: 'second' });",
      "const body = abilities.body_probe({ id: 'body' });",
      "return await Promise.all([first, second, body]);",
    ].join("\n"));
    await vi.waitFor(() => expect(events).toEqual(["query:start:first", "query:start:second"]));
    expect(events).not.toContain("body:start:body");

    releaseQuery();
    await vi.waitFor(() => expect(events).toContain("body:start:body"));
    releaseBody();

    await expect(result).resolves.toMatchObject({
      result: [{ id: "first" }, { id: "second" }, { id: "body" }],
    });
    expect(events).toEqual([
      "query:start:first", "query:start:second",
      "query:end:first", "query:end:second",
      "body:start:body", "body:end:body",
    ]);
  });

  it("commits concurrent safe Ability results and completion events in submission order", async () => {
    const execution: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push(event); } });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    await runtime.register(defineAbility({
      name: "ordered_safe_probe",
      description: "Complete safe calls in controlled execution order.",
      concurrency: "safe",
      input: testObject({ id: s.string() }),
      output: testObject({ id: s.string() }),
      async execute(input) {
        execution.push(`start:${input.id}`);
        if (input.id === "first") await firstGate;
        execution.push(`end:${input.id}`);
        return input;
      },
    }));

    let settled = false;
    const result = runtime.runCode([
      "const commits = [];",
      "const first = abilities.ordered_safe_probe({ id: 'first' }).then(() => commits.push('first'));",
      "const second = abilities.ordered_safe_probe({ id: 'second' }).then(() => commits.push('second'));",
      "await Promise.all([first, second]);",
      "return commits;",
    ].join("\n")).finally(() => { settled = true; });
    await vi.waitFor(() => expect(execution).toEqual(["start:first", "start:second", "end:second"]));
    expect(settled).toBe(false);
    releaseFirst();

    await expect(result).resolves.toMatchObject({ result: ["first", "second"] });
    expect(events.filter((event) => event.type === "ability_call_finished")
      .map((event) => event.result)).toEqual([{ id: "first" }, { id: "second" }]);
  });

  it("uses the same submission-ordered scheduler for Project Composite nested calls", async () => {
    const execution: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push(event); } });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const orderProbe = defineAbility({
      name: "composite_order_probe",
      description: "Complete nested safe calls in controlled order.",
      concurrency: "safe",
      input: testObject({ id: s.string() }),
      output: testObject({ id: s.string() }),
      async execute(input) {
        execution.push(`start:${input.id}`);
        if (input.id === "first") await firstGate;
        execution.push(`end:${input.id}`);
        return input;
      },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof orderProbe]>;
    const orderedComposite = defineCompositeAbility<LocalAbilities>()({
      name: "ordered_composite",
      description: "Invoke two safe peers concurrently.",
      input: testObject({}),
      output: testObject({ values: s.array(testObject({ id: s.string() })) }),
      async execute(_input, { abilities }) {
        const first = abilities.composite_order_probe({ id: "first" });
        const second = abilities.composite_order_probe({ id: "second" });
        return { values: await Promise.all([first, second]) };
      },
    });
    await runtime.register(orderProbe);
    await runtime.register(orderedComposite);

    const result = runtime.dispatch("ordered_composite", {});
    await vi.waitFor(() => expect(execution).toEqual(["start:first", "start:second", "end:second"]));
    releaseFirst();

    await expect(result).resolves.toEqual({ values: [{ id: "first" }, { id: "second" }] });
    expect(events.filter((event) => event.type === "ability_call_finished"
      && event.ability === "composite_order_probe").map((event) => event.result))
      .toEqual([{ id: "first" }, { id: "second" }]);
  });


  it("holds an exclusive barrier until its ordered completion commit finishes", async () => {
    const execution: string[] = [];
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const runtime = new AbilityRuntime({
      onEvent: async (event) => {
        if (event.type !== "ability_call_finished" || event.ability !== "commit_barrier_probe") return;
        execution.push("exclusive:commit");
        await commitGate;
      },
    });
    await runtime.register(defineAbility({
      name: "commit_barrier_probe",
      description: "Hold an exclusive Ability through commit.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() {
        execution.push("exclusive:execute");
        return { ok: true };
      },
    }));
    await runtime.register(defineAbility({
      name: "after_commit_probe",
      description: "Start only after the exclusive commit.",
      concurrency: "safe",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() {
        execution.push("tail:execute");
        return { ok: true };
      },
    }));

    const result = runtime.runCode([
      "const exclusive = abilities.commit_barrier_probe({});",
      "const tail = abilities.after_commit_probe({});",
      "return await Promise.all([exclusive, tail]);",
    ].join("\n"));
    await vi.waitFor(() => expect(execution).toEqual(["exclusive:execute", "exclusive:commit"]));
    releaseCommit();

    await expect(result).resolves.toMatchObject({ result: [{ ok: true }, { ok: true }] });
    expect(execution).toEqual(["exclusive:execute", "exclusive:commit", "tail:execute"]);
  });

  it("abandons queued calls and cancels and drains started Body work after a normal return", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push(event); } });
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    let bodyAborted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let queuedStarted = false;
    await runtime.register(defineAbility({
      name: "return_cleanup_probe",
      description: "Wait for return settlement and prove cleanup.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, context) {
        bodyStarted();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted === true) resolve();
          else context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        bodyAborted = true;
        await cleanup;
        return { ok: false, error: "INTERRUPTED" };
      },
    }));
    await runtime.register(defineAbility({
      name: "return_queued_probe",
      description: "Record an incorrectly started queued side effect.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() {
        queuedStarted = true;
        return { ok: true };
      },
    }));

    let settled = false;
    const result = runtime.runCode([
      "void abilities.return_cleanup_probe({});",
      "void abilities.return_queued_probe({});",
      "return { returned: true };",
    ].join("\n")).finally(() => { settled = true; });
    await started;

    await vi.waitFor(() => expect(bodyAborted).toBe(true));
    expect(queuedStarted).toBe(false);
    expect(settled).toBe(false);
    releaseCleanup();

    await expect(result).resolves.toMatchObject({ result: { returned: true } });
    expect(settled).toBe(true);
    expect(events.filter((event) => event.type.startsWith("ability_call_"))).toEqual([
      expect.objectContaining({ type: "ability_call_started", ability: "return_cleanup_probe" }),
      expect.objectContaining({ type: "ability_call_finished", ability: "return_cleanup_probe" }),
    ]);
  });

  it("drains descendants invoked by a Composite called from Programmatic Execution", async () => {
    const runtime = new AbilityRuntime();
    let leafStarted!: () => void;
    const started = new Promise<void>((resolve) => { leafStarted = resolve; });
    let leafAborted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const programmaticLeaf = defineAbility({
      name: "scoped_programmatic_leaf",
      description: "Prove Composite descendant cleanup.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, context) {
        leafStarted();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        leafAborted = true;
        await cleanup;
        return { ok: false, error: "INTERRUPTED" };
      },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof programmaticLeaf]>;
    const programmaticComposite = defineCompositeAbility<LocalAbilities>()({
      name: "scoped_programmatic_composite",
      description: "Invoke one descendant through the scoped Ability Namespace.",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, { abilities }) {
        return await abilities.scoped_programmatic_leaf({});
      },
    });
    await runtime.register(programmaticLeaf);
    await runtime.register(programmaticComposite);

    let settled = false;
    const result = runtime.runCode([
      "void abilities.scoped_programmatic_composite({});",
      "return { returned: true };",
    ].join("\n")).finally(() => { settled = true; });
    await started;

    await vi.waitFor(() => expect(leafAborted).toBe(true));
    expect(settled).toBe(false);
    releaseCleanup();

    await expect(result).resolves.toMatchObject({ result: { returned: true } });
    expect(settled).toBe(true);
  });

  it("abandons queued calls and drains started Body cleanup after a program failure", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push(event); } });
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    let bodyAborted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let queuedStarted = false;
    await runtime.register(defineAbility({
      name: "failure_cleanup_probe",
      description: "Wait for failure settlement and prove cleanup.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, context) {
        bodyStarted();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted === true) resolve();
          else context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        bodyAborted = true;
        await cleanup;
        return { ok: false, error: "INTERRUPTED" };
      },
    }));
    await runtime.register(defineAbility({
      name: "failure_queued_probe",
      description: "Record an incorrectly started queued side effect.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() {
        queuedStarted = true;
        return { ok: true };
      },
    }));

    let settled = false;
    const result = runtime.runCode([
      "void abilities.failure_cleanup_probe({});",
      "void abilities.failure_queued_probe({});",
      "throw new Error('program failed');",
    ].join("\n")).finally(() => { settled = true; });
    await started;

    await vi.waitFor(() => expect(bodyAborted).toBe(true));
    expect(queuedStarted).toBe(false);
    expect(settled).toBe(false);
    releaseCleanup();

    await expect(result).rejects.toMatchObject({
      name: "ProgrammaticExecutionError",
      code: "worker_runtime_error",
      message: "program failed",
    });
    expect(settled).toBe(true);
    expect(events.filter((event) => event.type.startsWith("ability_call_"))).toEqual([
      expect.objectContaining({ type: "ability_call_started", ability: "failure_cleanup_probe" }),
      expect.objectContaining({ type: "ability_call_finished", ability: "failure_cleanup_probe" }),
    ]);
    const programmaticStarted = events.find((event) =>
      event.type === "programmatic_execution_started");
    expect(events.at(-1)).toMatchObject({
      type: "programmatic_execution_finished",
      rootId: programmaticStarted?.rootId,
      executionId: programmaticStarted?.executionId,
      outcome: "error",
    });
  });

  it("does not settle a canceled Root until its started Body call proves neutral cleanup", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = new AbilityRuntime({ onEvent: (event) => { events.push(event); } });
    const controller = new AbortController();
    let bodyAborted = false;
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    await runtime.register(defineAbility({
      name: "body_cleanup_probe",
      description: "Wait for cancellation and then prove cleanup.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, context) {
        bodyStarted();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted === true) resolve();
          else context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        bodyAborted = true;
        await cleanup;
        return { ok: false, error: "INTERRUPTED" };
      },
    }));
    await runtime.register(defineAbility({
      name: "queued_probe",
      description: "Must be abandoned before it starts.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() { return { ok: true }; },
    }));
    let settled = false;
    const result = runtime.runCode([
      "const body = abilities.body_cleanup_probe({});",
      "const queued = abilities.queued_probe({});",
      "return await Promise.all([body, queued]);",
    ].join("\n"), { signal: controller.signal })
      .finally(() => { settled = true; });
    await started;

    controller.abort("operator stop");
    await vi.waitFor(() => expect(bodyAborted).toBe(true));
    expect(settled).toBe(false);
    releaseCleanup();

    await expect(result).rejects.toEqual(expect.objectContaining({
      name: "ProgrammaticExecutionError",
      code: "canceled",
      cause: "operator stop",
    }));
    expect(settled).toBe(true);
    expect(events.filter((event) => event.type.startsWith("ability_call_"))).toEqual([
      expect.objectContaining({ type: "ability_call_started", ability: "body_cleanup_probe" }),
      expect.objectContaining({ type: "ability_call_finished", ability: "body_cleanup_probe" }),
    ]);
  });

  it.each([
    {
      // A Body call is in flight, so the World Run is advancing and only the game-tick limit applies.
      fault: "game-tick limit",
      expectedCode: "worker_tick_timeout",
      limits: { gameTicks: 4 },
      source: [
        "void abilities.limit_cleanup_probe({});",
        "await new Promise(() => {});",
      ].join("\n"),
    },
  ] as const)("drains scoped child cleanup after $fault", async ({ expectedCode, limits, source }) => {
    const runtime = new AbilityRuntime({ testingProgrammaticExecutionLimits: limits });
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    let bodyAborted = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    await runtime.register(defineAbility({
      name: "limit_cleanup_probe",
      description: "Prove Programmatic Worker fault cleanup before settlement.",
      execution: "body",
      input: testObject({}),
      output: testObject({ ok: s.literal(false), error: s.literal("INTERRUPTED") }),
      async execute(_input, context) {
        bodyStarted();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        bodyAborted = true;
        await cleanup;
        return { ok: false, error: "INTERRUPTED" };
      },
    }));

    let settled = false;
    const clock = { afterTicks: async (ticks: number) => { expect(ticks).toBe(4); await new Promise(resolve => setTimeout(resolve, 100)); } };
    const result = runtime.runCode(source, { runtime: clock as never }).finally(() => { settled = true; });
    void result.catch(() => undefined);
    await started;
    await vi.waitFor(() => expect(bodyAborted).toBe(true));
    expect(settled).toBe(false);
    releaseCleanup();

    await expect(result).rejects.toMatchObject({
      name: "ProgrammaticExecutionError",
      code: expectedCode,
      rootId: expect.any(String),
      executionId: expect.any(String),
    });
    expect(settled).toBe(true);
  });

  it("keeps one foreground Body call across concurrent Roots for the same Runtime Adapter scope", async () => {
    const runtime = new AbilityRuntime();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    await runtime.register(defineAbility({
      name: "scoped_body_probe",
      description: "Run one scoped Body operation.",
      execution: "body",
      input: testObject({ id: s.string() }),
      output: testObject({ id: s.string() }),
      async execute(input) {
        events.push(`start:${input.id}`);
        if (input.id === "first") await firstGate;
        events.push(`end:${input.id}`);
        return input;
      },
    }));
    const runtimeAdapter = {} as never;
    const first = runtime.dispatch("scoped_body_probe", { id: "first" }, { runtime: runtimeAdapter });
    await vi.waitFor(() => expect(events).toEqual(["start:first"]));
    const second = runtime.dispatch("scoped_body_probe", { id: "second" }, { runtime: runtimeAdapter });
    await Promise.resolve();
    expect(events).toEqual(["start:first"]);

    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([{ id: "first" }, { id: "second" }]);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("turns canonical Actor unavailability into a fatal Native, Composite, and Programmatic Root error", async () => {
    const runtime = new AbilityRuntime();
    const actorEpochProbe = defineAbility({
      name: "actor_epoch_probe",
      description: "Report that the Runtime Actor incarnation was replaced.",
      input: testObject({}),
      output: testOneOf(
        testObject({ ok: s.literal(true), message: s.string(), data: testObject({}) }),
        testObject({
          ok: s.literal(false),
          error: s.literal("ACTOR_UNAVAILABLE"),
          message: s.string(),
          data: testObject({}),
        }),
      ),
      async execute() {
        return {
          ok: false as const,
          error: "ACTOR_UNAVAILABLE" as const,
          message: "Actor epoch changed",
          data: {},
        };
      },
    });
    type LocalAbilities = ScopedAbilityNamespace<readonly [typeof actorEpochProbe]>;
    const actorEpochComposite = defineCompositeAbility<LocalAbilities>()({
      name: "actor_epoch_composite",
      description: "Forward one Actor-sensitive nested call.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true), message: s.string(), data: testObject({}) }),
      async execute(_input, { abilities }) {
        await abilities.actor_epoch_probe({});
        return { ok: true as const, message: "actor available", data: {} };
      },
    });
    await runtime.register(actorEpochProbe);
    await runtime.register(actorEpochComposite);

    await expect(runtime.dispatch("actor_epoch_probe", {})).rejects.toMatchObject({
      name: "ActorUnavailableError", message: "Actor epoch changed",
    });
    await expect(runtime.dispatch("actor_epoch_composite", {})).rejects.toBeInstanceOf(ActorUnavailableError);
    await expect(runtime.runCode([
      "try { await abilities.actor_epoch_probe({}); } catch {}",
      "return { incorrectly_continued: true };",
    ].join("\n"))).rejects.toBeInstanceOf(ActorUnavailableError);
  });

  it("lets Programmatic code catch an ordinary Ability failure as ToolCallError", async () => {
    const runtime = new AbilityRuntime();
    await runtime.register(defineAbility({
      name: "ordinary_failure_probe",
      description: "Fail in an ordinary recoverable way.",
      input: testObject({}),
      output: testObject({ ok: s.literal(true) }),
      async execute() { throw new Error("ordinary failure"); },
    }));

    await expect(runtime.runCode([
      "try { await abilities.ordinary_failure_probe({}); }",
      "catch (error) {",
      "  return { name: error.name, ability: error.ability, message: error.message };",
      "}",
    ].join("\n"))).resolves.toMatchObject({
      result: {
        name: "ToolCallError",
        ability: "ordinary_failure_probe",
        message: "ordinary failure",
      },
    });
  });

  it("projects canonical output validation failures as ordinary ToolCallError", async () => {
    const runtime = new AbilityRuntime();
    await runtime.register(defineAbility({
      name: "contract_probe",
      description: "Return one validated string.",
      input: testObject({}),
      output: testObject({ value: s.string() }),
      async execute() {
        return { value: 42 } as never;
      },
    }));

    await expect(runtime.dispatch("contract_probe", {})).rejects.toEqual(expect.objectContaining({
      name: "ToolCallError",
      ability: "contract_probe",
      message: "contract_probe output.value must be a string",
    }));
    await expect(runtime.dispatch("contract_probe", { extra: true })).rejects.toBeInstanceOf(ToolCallError);
  });

  it("returns Native model content from the fixed Ability Tool Contract renderer", async () => {
    const runtime = new AbilityRuntime();
    await runtime.register(defineAbility({
      name: "render_probe",
      description: "Render one canonical result through the Ability Tool Contract.",
      input: testObject({}),
      output: testObject({ value: s.string() }),
      async execute() { return { value: "verified" }; },
    }));

    await expect(runtime.dispatchTool("render_probe", {})).resolves.toEqual({
      canonicalOutput: { value: "verified" },
      modelContent: JSON.stringify({ value: "verified" }),
    });
  });

  it("freezes the run catalogue before publishing model schemas or executing work", async () => {
    const runtime = new AbilityRuntime();
    const definition = defineAbility({
      name: "catalogue_probe", description: "Stable run definition.",
      input: testObject({}), output: testObject({ value: s.string() }),
      async execute() { return { value: "stable" }; },
    });
    await runtime.register(definition);
    expect(runtime.modelTools().map((tool) => tool.name)).toEqual(["catalogue_probe"]);
    await expect(runtime.register(definition)).rejects.toThrow("catalogue is frozen");
    await expect(runtime.dispatch("catalogue_probe", {})).resolves.toEqual({ value: "stable" });
  });

  it("keeps registered definitions and event subscriptions owned by one Runtime", async () => {
    const leftEvents: Array<Record<string, unknown>> = [];
    const rightEvents: Array<Record<string, unknown>> = [];
    const left = new AbilityRuntime({ onEvent: (event) => { leftEvents.push(event); } });
    const right = new AbilityRuntime({ onEvent: (event) => { rightEvents.push(event); } });
    const definition = (value: string) => defineAbility({
      name: "run_probe",
      description: "Report the owning Runtime definition.",
      input: testObject({}),
      output: testObject({ value: s.string() }),
      async execute() { return { value }; },
    });

    await left.register(definition("left"));
    await right.register(definition("right"));

    await expect(left.dispatch("run_probe", {})).resolves.toEqual({ value: "left" });
    await expect(right.dispatch("run_probe", {})).resolves.toEqual({ value: "right" });
    expect(leftEvents.filter((event) => event.type === "ability_call_started")).toHaveLength(1);
    expect(rightEvents.filter((event) => event.type === "ability_call_started")).toHaveLength(1);
    expect(leftEvents.find((event) => event.type === "ability_call_finished")).toMatchObject({
      result: { value: "left" },
    });
    expect(rightEvents.find((event) => event.type === "ability_call_finished")).toMatchObject({
      result: { value: "right" },
    });
  });

  it("projects one author definition to Native schema and TypeScript SDK while reserving control Tool names", async () => {
    const runtime = new AbilityRuntime();
    const definition = defineAbility({
      name: "observe_probe",
      description: "Observe one typed value.",
      input: testObject({ radius: s.number() }),
      output: testObject({ value: s.string() }),
      async execute() { return { value: "ok" }; },
    });
    expect(definition.render({ radius: 2 }, { value: "ok" })).toBe('{"value":"ok"}');
    await runtime.register(definition);

    expect(runtime.modelTools()).toEqual([{
      name: "observe_probe",
      description: "Observe one typed value.",
      inputSchema: {
        type: "object",
        properties: { radius: { type: "number", description: "Test radius." } },
        required: ["radius"],
        additionalProperties: false,
      },
      strict: false,
    }]);
    expect(runtime.typescriptSdk()).toContain("* Test radius.");
    expect(runtime.typescriptSdk()).toContain("readonly radius: number;");
    expect(runtime.typescriptSdk()).toContain("* Test value.");
    expect(runtime.typescriptSdk()).toContain("readonly value: string;");
    for (const name of ["run_code", "load_skill", "update_plan", "end_run"] as const) {
      await expect(runtime.register(defineAbility({
        name,
        description: "reserved",
        input: testObject({}),
        output: testObject({}),
        async execute() { return {}; },
      }))).rejects.toThrow("reserved for Harness Control Tools");
    }
    for (const name of [
      "navigate", "interact_at", "interact_block", "use_item_on_block_face",
      "attack_entity", "fight_entity", "pickup", "drop_item", "entity_get", "inspect_gui",
      "transfer", "collect_nearby_items", "break_and_collect", "scaffold_materials",
    ] as const) {
      await expect(runtime.register(defineAbility({
        name,
        description: "retired",
        input: testObject({}),
        output: testObject({}),
        async execute() { return {}; },
      }))).rejects.toThrow("retired Agent-facing Ability name");
    }
    expect(runtime.names).toEqual(["observe_probe"]);
  });

  it("keeps Harness Control Tools outside Programmatic Ability execution", async () => {
    const runtime = new AbilityRuntime();
    for (const definition of runtimeAbilities) {
      await runtime.register(definition);
    }

    const sdk = runtime.typescriptSdk();
    expect(sdk).not.toContain("load_skill(input:");
    expect(sdk).not.toContain("update_plan(input:");
    await expect(runtime.runCode([
      "return await abilities.load_skill({ name: 'containers' });",
    ].join("\n"))).rejects.toMatchObject({
      name: "ProgrammaticExecutionError",
      message: expect.stringContaining("load_skill"),
    });
  });

  it("does not lease query execution and honors disabled Simulation Control", async () => {
    const control = {
      runtimeTimeResume: vi.fn(async () => ({ simulation_suspended: false })),
      observe: vi.fn(async () => ({ observation_revision: 8, server_tick: 0, game_time: 0 })),
    runtimeTimeSuspend: vi.fn(async () => ({ simulation_suspended: true })),
    };
    const runtime = new AbilityRuntime({ simulationControl: control, suspendSimulationDuringIdle: false });
    await runtime.register(defineAbility({
      name: "query_lease_probe", description: "Probe query lease.", execution: "query",
      input: testObject({}), output: testObject({ value: s.literal(true) }),
      async execute() { return { value: true }; },
    }));

    await expect(runtime.dispatch("query_lease_probe", {})).resolves.toEqual({ value: true });
    expect(control.runtimeTimeResume).not.toHaveBeenCalled();
    expect(control.runtimeTimeSuspend).not.toHaveBeenCalled();
  });

});

function selfStatusResult() {
  return {
    ok: true as const,
    message: "body status",
    data: {
      entity_id: 1, name: "HarnessBot", game_mode: "survival" as const,
      hp: 20, max_hp: 20, hunger: 20,
      position: { x: 0.5, y: 64, z: 0.5 }, dimension: "minecraft:overworld",
      equipment: {}, backpack_slots: { used: 0, total: 41 },
      on_ground: true, in_water: false, air: "300/300", in_lava: false,
      underwater: false, on_fire: false, suffocating: false, intersecting_blocks: [],
      fall_distance: 0, facing: "north" as const,
      feet: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, active_effects: [],
    },
  };
}

function blockEvidence(
  blockState: string,
  position: { x: number; y: number; z: number },
  observationRevision: number,
) {
  return {
    dimension: "minecraft:overworld",
    position,
    state: "KNOWN_BLOCK" as const,
    block_state: blockState,
    fluid: "minecraft:empty",
    source: "vision",
    observed_tick: observationRevision * 5,
    observation_revision: observationRevision,
  };
}
