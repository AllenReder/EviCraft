import { describe, expect, it, vi } from "vitest";

import {
  AbilityRuntime,
  defineAbility,
  toolSchema as s,
} from "../src/index.js";
import { projectCompositeAbilities } from "../src/harness/abilities/index.js";

const origin = { x: 0, y: 64, z: 0 };
const north = { x: 0, y: 64, z: -1 };

describe("suffocation_escape Project Composite contract", () => {
  it("cancels and drains nested work before returning the thirty-second failure", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const runtime = new AbilityRuntime();
      let startBreak!: () => void;
      const breakStarted = new Promise<void>((resolve) => {
        startBreak = resolve;
      });
      let childDrained = false;
      await runtime.register(
        scripted("observe_self", [self(origin, true)], calls),
      );
      await runtime.register(
        scripted(
          "observe_block",
          [...Array.from({ length: 13 }, () => cell("KNOWN_BLOCK"))],
          calls,
        ),
      );
      await runtime.register(
        defineAbility({
          name: "break_block",
          description: "Block until the composite deadline cancels this child.",
          execution: "body",
          input: s.losslessJson(),
          output: s.losslessJson(),
          async execute(input, { signal }) {
            calls.push(`break_block:${JSON.stringify(input)}`);
            startBreak();
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            await Promise.resolve();
            childDrained = true;
            return {
              ok: false,
              error: "INTERRUPTED",
              message: "break canceled",
              data: { position: origin },
            };
          },
        }),
      );
      await runtime.register(
        projectCompositeAbilities.find(
          ({ name }) => name === "suffocation_escape",
        )!,
      );

      // The deadline is thirty seconds of game time, read from the Runtime clock.
      const afterTicks = vi.fn(async (_ticks: number) => { await new Promise(resolve => setTimeout(resolve, 30_000)); });
      const result = runtime.dispatch("suffocation_escape", {}, { runtime: { afterTicks } as never });
      await breakStarted;
      expect(afterTicks.mock.calls[0]?.[0]).toBe(600);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toEqual({
        ok: false,
        error: "RUNTIME_FAILED",
        message: "suffocation escape reached the thirty-second time limit",
        data: {
          failure_type: "time_limit",
          last_observed_feet: origin,
          last_observed_suffocating: true,
          adjacent_attempts: 0,
          broken_blocks: [],
        },
      });
      expect(childDrained).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns INTERRUPTED only after externally canceled nested work drains", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    const controller = new AbortController();
    let startBreak!: () => void;
    const breakStarted = new Promise<void>((resolve) => {
      startBreak = resolve;
    });
    let childDrained = false;
    await runtime.register(
      scripted("observe_self", [self(origin, true)], calls),
    );
    await runtime.register(
      scripted(
        "observe_block",
        [...Array.from({ length: 13 }, () => cell("KNOWN_BLOCK"))],
        calls,
      ),
    );
    await runtime.register(
      defineAbility({
        name: "break_block",
        description: "Drain after external cancellation.",
        execution: "body",
        input: s.losslessJson(),
        output: s.losslessJson(),
        async execute(_input, { signal }) {
          startBreak();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await Promise.resolve();
          childDrained = true;
          return {
            ok: false,
            error: "INTERRUPTED",
            message: "break canceled",
            data: { position: origin },
          };
        },
      }),
    );
    await runtime.register(
      projectCompositeAbilities.find(
        ({ name }) => name === "suffocation_escape",
      )!,
    );

    const result = runtime.dispatch(
      "suffocation_escape",
      {},
      { signal: controller.signal },
    );
    await breakStarted;
    controller.abort(new Error("operator canceled escape"));
    await expect(result).resolves.toEqual({
      ok: false,
      error: "INTERRUPTED",
      message: "composite interrupted",
      data: {
        last_observed_feet: origin,
        last_observed_suffocating: true,
        adjacent_attempts: 0,
        broken_blocks: [],
      },
    });
    expect(childDrained).toBe(true);
  });

  it("is registered and verifies exact adjacent relief through fresh embodied evidence", async () => {
    const calls: string[] = [];
    const runtime = new AbilityRuntime();
    await runtime.register(
      scripted("observe_self", [self(origin, true), self(north, false)], calls),
    );
    await runtime.register(
      scripted(
        "observe_block",
        [
          cell("KNOWN_AIR"),
          cell("KNOWN_AIR"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_AIR"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_AIR"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_AIR"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_AIR"),
        ],
        calls,
      ),
    );
    await runtime.register(
      scripted(
        "goto",
        [
          success({
            position: { x: 0.5, y: 64, z: -0.5 },
            ground_y: 63,
          }),
        ],
        calls,
        "body",
      ),
    );
    await runtime.register(scripted("break_block", [], calls, "body"));
    await runtime.register(scripted("collect_items", [], calls, "body"));

    const escape = projectCompositeAbilities.find(
      ({ name }) => name === "suffocation_escape",
    );
    expect(escape).toMatchObject({
      name: "suffocation_escape",
      execution: "composite",
      compositeProgram: true,
    });
    await runtime.register(escape!);

    await expect(runtime.dispatch("suffocation_escape", {})).resolves.toEqual({
      ok: true,
      message: "escaped suffocation through an adjacent supported Feet Cell",
      data: {
        escape_method: "adjacent",
        final_feet: north,
        adjacent_attempts: 1,
        broken_blocks: [],
      },
    });
    expect(calls).toEqual([
      "observe_self:{}",
      `observe_block:${JSON.stringify(north)}`,
      `observe_block:${JSON.stringify({ x: 0, y: 65, z: -1 })}`,
      `observe_block:${JSON.stringify({ x: 0, y: 63, z: -1 })}`,
      `observe_block:${JSON.stringify({ x: 1, y: 64, z: 0 })}`,
      `observe_block:${JSON.stringify({ x: 1, y: 65, z: 0 })}`,
      `observe_block:${JSON.stringify({ x: 1, y: 63, z: 0 })}`,
      `observe_block:${JSON.stringify({ x: 0, y: 64, z: 1 })}`,
      `observe_block:${JSON.stringify({ x: 0, y: 65, z: 1 })}`,
      `observe_block:${JSON.stringify({ x: 0, y: 63, z: 1 })}`,
      `observe_block:${JSON.stringify({ x: -1, y: 64, z: 0 })}`,
      `observe_block:${JSON.stringify({ x: -1, y: 65, z: 0 })}`,
      `observe_block:${JSON.stringify({ x: -1, y: 63, z: 0 })}`,
      `goto:${JSON.stringify(north)}`,
      "observe_self:{}",
      `observe_block:${JSON.stringify(north)}`,
    ]);
    expect(calls.some((call) => call.startsWith("collect_items:"))).toBe(false);
  });

  it("re-observes falling head blocks, clears the feet cell, and verifies the final pose", async () => {
    const calls: string[] = [];
    const head = { x: 0, y: 65, z: 0 };
    const runtime = new AbilityRuntime();
    await runtime.register(
      scripted(
        "observe_self",
        [
          self(origin, true),
          self(origin, true),
          self(origin, false),
          self(origin, false),
        ],
        calls,
      ),
    );
    await runtime.register(
      scripted(
        "observe_block",
        [
          ...Array.from({ length: 12 }, () => cell("KNOWN_BLOCK")),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_AIR"),
        ],
        calls,
      ),
    );
    await runtime.register(scripted("goto", [], calls, "body"));
    await runtime.register(
      scripted(
        "break_block",
        [
          success({ position: head, observed_drop_entities: [] }),
          success({ position: head, observed_drop_entities: [] }),
          success({ position: origin, observed_drop_entities: [] }),
        ],
        calls,
        "body",
      ),
    );
    await runtime.register(scripted("collect_items", [], calls, "body"));
    await runtime.register(
      projectCompositeAbilities.find(
        ({ name }) => name === "suffocation_escape",
      )!,
    );

    await expect(runtime.dispatch("suffocation_escape", {})).resolves.toEqual({
      ok: true,
      message: "escaped suffocation and verified a usable Feet Cell",
      data: {
        escape_method: "fallback",
        final_feet: origin,
        adjacent_attempts: 0,
        broken_blocks: [head, head, origin],
      },
    });
    expect(calls.filter((call) => call.startsWith("break_block:"))).toEqual([
      `break_block:${JSON.stringify({ position: head })}`,
      `break_block:${JSON.stringify({ position: head })}`,
      `break_block:${JSON.stringify({ position: origin })}`,
    ]);
    expect(calls.some((call) => call.startsWith("collect_items:"))).toBe(false);
    expect(calls.slice(-3)).toEqual([
      `break_block:${JSON.stringify({ position: origin })}`,
      "observe_self:{}",
      `observe_block:${JSON.stringify(origin)}`,
    ]);
  });

  it("does not mistake ordinary goto fallback success for exact adjacent arrival", async () => {
    const calls: string[] = [];
    const head = { x: 0, y: 65, z: 0 };
    const runtime = new AbilityRuntime();
    await runtime.register(
      scripted(
        "observe_self",
        [self(origin, true), self(origin, true), self(origin, false)],
        calls,
      ),
    );
    await runtime.register(
      scripted(
        "observe_block",
        [
          cell("KNOWN_AIR"),
          cell("KNOWN_AIR"),
          cell("KNOWN_BLOCK"),
          ...Array.from({ length: 9 }, () => cell("KNOWN_BLOCK")),
          cell("KNOWN_BLOCK"),
          cell("KNOWN_AIR"),
        ],
        calls,
      ),
    );
    await runtime.register(
      scripted(
        "goto",
        [
          success({
            position: { x: 0.5, y: 64, z: 0.5 },
            ground_y: 63,
          }),
        ],
        calls,
        "body",
      ),
    );
    await runtime.register(
      scripted(
        "break_block",
        [success({ position: head, observed_drop_entities: [] })],
        calls,
        "body",
      ),
    );
    await runtime.register(
      projectCompositeAbilities.find(
        ({ name }) => name === "suffocation_escape",
      )!,
    );

    await expect(
      runtime.dispatch("suffocation_escape", {}),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        escape_method: "fallback",
        final_feet: origin,
        adjacent_attempts: 1,
        broken_blocks: [head],
      },
    });
    expect(calls).toContain(`goto:${JSON.stringify(north)}`);
  });

  it("returns truthful partial progress at the thirty-two-block bound", async () => {
    const calls: string[] = [];
    const head = { x: 0, y: 65, z: 0 };
    const runtime = new AbilityRuntime();
    await runtime.register(
      scripted(
        "observe_self",
        Array.from({ length: 33 }, () => self(origin, true)),
        calls,
      ),
    );
    await runtime.register(
      scripted(
        "observe_block",
        [
          ...Array.from({ length: 12 }, () => cell("KNOWN_BLOCK")),
          ...Array.from({ length: 33 }, () => cell("KNOWN_BLOCK")),
        ],
        calls,
      ),
    );
    await runtime.register(scripted("goto", [], calls, "body"));
    await runtime.register(
      scripted(
        "break_block",
        Array.from({ length: 32 }, () =>
          success({ position: head, observed_drop_entities: [] }),
        ),
        calls,
        "body",
      ),
    );
    await runtime.register(
      projectCompositeAbilities.find(
        ({ name }) => name === "suffocation_escape",
      )!,
    );

    await expect(runtime.dispatch("suffocation_escape", {})).resolves.toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "suffocation escape reached the thirty-two-block limit",
      data: {
        failure_type: "block_limit",
        last_observed_feet: origin,
        last_observed_suffocating: true,
        adjacent_attempts: 0,
        broken_blocks: Array.from({ length: 32 }, () => head),
      },
    });
    expect(
      calls.filter((call) => call.startsWith("break_block:")),
    ).toHaveLength(32);
  });

  it("continues clearing an intersecting feet obstruction after the head is clear", async () => {
    const calls: string[] = [];
    const head = { x: 0, y: 65, z: 0 };
    await expect(runEscapeWithScripts([
      self(origin, true, [origin, head]),
      self(origin, true, [origin]),
      self(origin, false, []),
    ], [cell("KNOWN_BLOCK"), cell("KNOWN_BLOCK"), cell("KNOWN_AIR")], calls)).resolves.toMatchObject({
      ok: true,
      data: { broken_blocks: [head, origin] },
    });
  });
});

function self(feet: typeof origin, suffocating: boolean, intersecting_blocks: readonly typeof origin[] = []) {
  return success({ feet, suffocating, intersecting_blocks });
}

function cell(state: "KNOWN_AIR" | "KNOWN_BLOCK" | "UNKNOWN") {
  return success({ operation: "block.get", cells: [{ state }] });
}

function success(data: unknown) {
  return { ok: true as const, message: "scripted success", data };
}

async function runEscapeWithScripts(selfResults: unknown[], fallbackCells: unknown[], calls: string[]) {
  const runtime = new AbilityRuntime();
  await runtime.register(scripted("observe_self", selfResults, calls));
  await runtime.register(scripted("observe_block", [
    ...Array.from({ length: 12 }, () => cell("UNKNOWN")), ...fallbackCells,
  ], calls));
  await runtime.register(scripted("goto", [], calls, "body"));
  await runtime.register(scripted("break_block", [
    success({ position: { x: 0, y: 65, z: 0 }, observed_drop_entities: [] }),
    success({ position: origin, observed_drop_entities: [] }),
  ], calls, "body"));
  await runtime.register(projectCompositeAbilities.find(({ name }) => name === "suffocation_escape")!);
  return await runtime.dispatch("suffocation_escape", {});
}

function scripted(
  name: string,
  results: unknown[],
  calls: string[],
  execution: "query" | "body" = "query",
) {
  return defineAbility({
    name,
    description: `Scripted ${name}.`,
    execution,
    concurrency: "safe",
    input: s.losslessJson(),
    output: s.losslessJson(),
    async execute(input) {
      calls.push(`${name}:${JSON.stringify(input)}`);
      const result = results.shift();
      if (result === undefined)
        throw new Error(`${name} called past scripted results`);
      return result;
    },
  });
}
