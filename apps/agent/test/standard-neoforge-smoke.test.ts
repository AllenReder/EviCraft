import { describe, expect, it, vi } from "vitest";

import {
  assertRouteMutationPermissionGameTestOutput,
  assertSimulationSuspensionSmokeOutput,
  assertWorldKnowledgeProfileSmokeOutput,
  assertWorldKnowledgeProfileGameTestOutput,
  runStandardNeoForgeSmoke,
} from "../src/smoke/matrix.js";
import { observedBlockPositions } from "../src/smoke/scenarios/shared.js";

describe("standard NeoForge smoke matrix", () => {
  it("runs exactly the standard GameTest and Runtime SDK phases in order", async () => {
    const calls: string[] = [];
    const runRuntimeSdkSmoke = vi.fn(async (profile?: string, scope?: string) => {
      calls.push(`sdk:${profile ?? "default"}:${scope ?? "default"}`);
    });

    await runStandardNeoForgeSmoke({
      runRouteMutationPermissionGameTests: async () => { calls.push("gametest:route-mutation"); },
      runWorldKnowledgeProfileGameTests: async () => { calls.push("gametest:world-knowledge"); },
      runRuntimeSdkSmoke,
    });

    expect(calls).toEqual([
      "gametest:route-mutation",
      "gametest:world-knowledge",
      "sdk:default:default",
      "sdk:grounded_evidence:profile",
      "sdk:loaded_world_state:profile",
      "sdk:default:simulation_suspension",
    ]);
  });

  it("matches canonical block ids when Turn Observation lines include BlockState properties", () => {
    const observation = [
      "minecraft:chest[facing=north,type=single,waterlogged=false] count=1 positions=4,104,4",
      "minecraft:red_bed[facing=east,occupied=false,part=foot] count=1 positions=1026,101,0",
    ].join("\n");

    expect(observedBlockPositions(observation, "minecraft:chest")).toEqual([
      { x: 4, y: 104, z: 4 },
    ]);
    expect(observedBlockPositions(observation, "minecraft:red_bed")).toEqual([
      { x: 1026, y: 101, z: 0 },
    ]);
  });

  it("requires the complete Route Mutation Permission GameTest suite", () => {
    const complete = [
      "14 tests are now running",
      "Running test batch 'route_mutation_break_interruption:0' (1 tests)",
      "Running test batch 'route_mutation_empty_door:0' (1 tests)",
      "Running test batch 'route_mutation_open_door:0' (1 tests)",
      "Running test batch 'route_mutation_open_wall:0' (1 tests)",
      "Running test batch 'route_mutation_break_wall:0' (1 tests)",
      "Running test batch 'route_mutation_open_gap:0' (1 tests)",
      "Running test batch 'route_mutation_place_gap:0' (1 tests)",
      "Running test batch 'route_pillar_feasible:0' (1 tests)",
      "Running test batch 'route_pillar_infeasible:0' (1 tests)",
      "Running test batch 'route_pillar_transient:0' (1 tests)",
      "Running test batch 'route_mutation_break_creative_hand:0' (1 tests)",
      "Running test batch 'route_mutation_break_implement:0' (1 tests)",
      "Running test batch 'route_mutation_break_validation_hand:0' (1 tests)",
      "Running test batch 'route_mutation_break_without_correct_implement:0' (1 tests)",
      "All 14 required tests passed",
    ].join("\n");

    expect(() =>
      assertRouteMutationPermissionGameTestOutput(complete),
    ).not.toThrow();
    expect(() =>
      assertRouteMutationPermissionGameTestOutput(
        complete.replace(
          "All 14 required tests passed",
          "1 required test failed",
        ),
      ),
    ).toThrow(/evidence is missing/u);
    expect(() =>
      assertRouteMutationPermissionGameTestOutput(
        `${complete}\n1 required test was skipped`,
      ),
    ).toThrow(/failed or was skipped/u);
  });

  it("requires loaded, lifecycle, and grounded-expiry GameTest evidence", () => {
    const complete = [
      "6 tests are now running",
      "Running test batch 'mc_agent_loaded_block_updates:0' (1 tests)",
      "Running test batch 'mc_agent_loaded_entity:0' (1 tests)",
      "Running test batch 'grounded_evidence_expiry:0' (1 tests)",
      "Running test batch 'grounded_field_of_view:0' (1 tests)",
      "Running test batch 'counted_slot_transfer:0' (1 tests)",
      "Running test batch 'mc_agent_runtime:0' (1 tests)",
      "All 6 required tests passed",
    ].join("\n");
    expect(() =>
      assertWorldKnowledgeProfileGameTestOutput(complete),
    ).not.toThrow();
    expect(() =>
      assertWorldKnowledgeProfileGameTestOutput(
        complete.replace(
          "All 6 required tests passed",
          "1 required test failed",
        ),
      ),
    ).toThrow(/evidence is missing/u);
    expect(() =>
      assertWorldKnowledgeProfileGameTestOutput(
        `${complete}\n1 required test was skipped`,
      ),
    ).toThrow(/failed or was skipped/u);
  });

  it.each(["grounded_evidence", "loaded_world_state"] as const)(
    "requires complete %s real profile smoke evidence and cleanup",
    (profile) => {
      const complete = JSON.stringify({
        event: "world_knowledge_profile_smoke_passed",
        scope: "profile",
        profile,
        server_stopped: true,
        checks: [
          "inside exact block and outside UNKNOWN",
          "bounded block.find",
          "complete and incomplete block.region",
          "block target navigation",
          "knowledge-bound exact PVA-invalid failure without side effect then legal success",
          "Entity Knowledge exact target navigation and interaction",
          "SDK reconnect",
          "death body-unavailable respawn preserves actor and Profile",
        ],
      });

      expect(() => assertWorldKnowledgeProfileSmokeOutput(complete, profile)).not.toThrow();
      expect(() => assertWorldKnowledgeProfileSmokeOutput(
        complete.replace("bounded block.find", "missing block.find"), profile,
      )).toThrow(/evidence is missing/u);
      expect(() => assertWorldKnowledgeProfileSmokeOutput(
        complete.replace('"server_stopped":true', '"server_stopped":false'), profile,
      )).toThrow(/server_stopped/u);
    },
  );

  it("requires Simulation Suspension receipt and cleanup evidence", () => {
    const complete = JSON.stringify({
      event: "simulation_suspension_smoke_passed",
      scope: "simulation_suspension",
      server_stopped: true,
      game_time: { idleGameTime: 2, frozenGameTime: 2, afterWait: 42, pausedAgain: 42 },
      checks: [
        "idle World Run does not advance",
        "SDK RPC stays responsive while paused",
        "wait advances exactly the requested ticks",
        "World Run pauses again after the wait",
      ],
    });

    expect(() => assertSimulationSuspensionSmokeOutput(complete)).not.toThrow();
    expect(() => assertSimulationSuspensionSmokeOutput(
      complete.replace("idle World Run does not advance", "missing idle window"),
    )).toThrow(/evidence is missing/u);
    expect(() => assertSimulationSuspensionSmokeOutput(
      complete.replace('"server_stopped":true', '"server_stopped":false'),
    )).toThrow(/server_stopped/u);
  });
});
