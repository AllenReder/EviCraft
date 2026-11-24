import {
  runNeoForgeGameTest,
  runRuntimeSdkSmoke as executeRuntimeSdkSmoke,
} from "./neoforge-smoke-run.js";

export interface StandardNeoForgeSmokeDependencies {
  readonly runRouteMutationPermissionGameTests: () => Promise<void>;
  readonly runWorldKnowledgeProfileGameTests: () => Promise<void>;
  readonly runRuntimeSdkSmoke: (
    profile?: "grounded_evidence" | "loaded_world_state",
    scope?: string,
  ) => Promise<void>;
}

/** Runs the standard current-worktree real NeoForge Runtime SDK/Harness smoke gate. */
export async function runStandardNeoForgeSmoke(
  dependencies: StandardNeoForgeSmokeDependencies = defaultStandardNeoForgeSmokeDependencies(),
): Promise<void> {
  // Gradle-backed NeoForge servers share project state, so every launch is serial.
  await dependencies.runRouteMutationPermissionGameTests();
  await dependencies.runWorldKnowledgeProfileGameTests();
  await dependencies.runRuntimeSdkSmoke();
  await dependencies.runRuntimeSdkSmoke("grounded_evidence", "profile");
  await dependencies.runRuntimeSdkSmoke("loaded_world_state", "profile");
  await dependencies.runRuntimeSdkSmoke(undefined, "simulation_suspension");
}


function defaultStandardNeoForgeSmokeDependencies(): StandardNeoForgeSmokeDependencies {
  return {
    runRouteMutationPermissionGameTests,
    runWorldKnowledgeProfileGameTests,
    runRuntimeSdkSmoke,
  };
}

// Prettier range-formatting this legacy smoke module rewrites unrelated orchestration.
// prettier-ignore
async function runRuntimeSdkSmoke(
  profile?: "grounded_evidence" | "loaded_world_state", scope?: string,
): Promise<void> {
  await executeRuntimeSdkSmoke({
    ...(profile === undefined ? {} : { profile }),
    ...(scope === undefined ? {} : { scope }),
    ...(scope === "profile" && profile !== undefined
      ? { assertOutput: (output) => assertWorldKnowledgeProfileSmokeOutput(output, profile) }
      : scope === "simulation_suspension"
        ? { assertOutput: assertSimulationSuspensionSmokeOutput }
      : {}),
  });
}

export function assertWorldKnowledgeProfileSmokeOutput(
  output: string, profile: "grounded_evidence" | "loaded_world_state",
): void {
  const required = [
    '"event":"world_knowledge_profile_smoke_passed"',
    '"scope":"profile"',
    `"profile":"${profile}"`,
    "inside exact block and outside UNKNOWN",
    "bounded block.find",
    "complete and incomplete block.region",
    "block target navigation",
    "knowledge-bound exact PVA-invalid failure without side effect then legal success",
    "Entity Knowledge exact target navigation and interaction",
    "SDK reconnect",
    "death body-unavailable respawn preserves actor and Profile",
  ];
  for (const evidence of required) {
    if (!output.includes(evidence)) {
      throw new Error(`World Knowledge Profile smoke evidence is missing: ${evidence}`);
    }
  }
  if (!output.includes('"server_stopped":true')) {
    throw new Error("World Knowledge Profile smoke omitted server_stopped:true");
  }
}

export function assertSimulationSuspensionSmokeOutput(output: string): void {
  const required = [
    '"event":"simulation_suspension_smoke_passed"',
    '"scope":"simulation_suspension"',
    "idle World Run does not advance",
    "SDK RPC stays responsive while paused",
    "wait advances exactly the requested ticks",
    "World Run pauses again after the wait",
  ];
  for (const evidence of required) {
    if (!output.includes(evidence)) {
      throw new Error(`Simulation Suspension smoke evidence is missing: ${evidence}`);
    }
  }
  if (!output.includes('"server_stopped":true')) {
    throw new Error("Simulation Suspension smoke omitted server_stopped:true");
  }
}

// prettier-ignore
export async function runWorldKnowledgeProfileGameTests(): Promise<void> {
  await runNeoForgeGameTest({
    id: "world-knowledge-profile",
    namespace: "mc_agent_startup",
    assertOutput: assertWorldKnowledgeProfileGameTestOutput,
    receipt: ({ minecraftPort, runtimePort }) => {
      process.stdout.write(`${JSON.stringify({
        event: "world_knowledge_profile_gametests_passed",
        minecraft_port: minecraftPort,
        runtime_port: runtimePort,
        server_stopped: true,
      })}\n`);
    },
  });
}

// prettier-ignore
export function assertWorldKnowledgeProfileGameTestOutput(output: string): void {
  const required = ["6 tests are now running", "Running test batch 'mc_agent_loaded_block_updates:0' (1 tests)",
    "Running test batch 'mc_agent_loaded_entity:0' (1 tests)", "Running test batch 'grounded_evidence_expiry:0' (1 tests)",
    "Running test batch 'grounded_field_of_view:0' (1 tests)", "Running test batch 'counted_slot_transfer:0' (1 tests)",
    "Running test batch 'mc_agent_runtime:0' (1 tests)", "All 6 required tests passed"];
  for (const evidence of required) if (!output.includes(evidence)) throw new Error(`World Knowledge Profile GameTest evidence is missing: ${evidence}`);
  if (output.includes("No test functions were given")
      || /[1-9][0-9]* required tests failed|required tests? (?:was|were) skipped/u.test(output)) {
    throw new Error("A World Knowledge Profile GameTest failed or was skipped");
  }
}

export async function runRouteMutationPermissionGameTests(): Promise<void> {
  await runNeoForgeGameTest({
    id: "route-mutation",
    namespace: "mc_agent_route_mutation",
    assertOutput: assertRouteMutationPermissionGameTestOutput,
    receipt: ({ minecraftPort, runtimePort }) => {
      process.stdout.write(`${JSON.stringify({
        event: "route_mutation_permission_gametests_passed",
        minecraft_port: minecraftPort,
        runtime_port: runtimePort,
        server_stopped: true,
      })}\n`);
    },
  });
}

export function assertRouteMutationPermissionGameTestOutput(output: string): void {
  const required = [
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
  ];
  for (const evidence of required) {
    if (!output.includes(evidence)) {
      throw new Error(`Route Mutation Permission GameTest evidence is missing: ${evidence}`);
    }
  }
  if (output.includes("No test functions were given")
      || /[1-9][0-9]* required tests failed|required tests? (?:was|were) skipped/u.test(output)) {
    throw new Error("A Route Mutation Permission GameTest failed or was skipped");
  }
}
