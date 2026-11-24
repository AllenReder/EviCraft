export const SUPPORTED_RUNTIME_SDK_SMOKE_SCOPES = [
  "activation",
  "collect_blocks_reselection",
  "craft",
  "eye",
  "inventory",
  "occlusion_and_reselection",
  "occurrence_and_hazards",
  "menu",
  "mine_down",
  "obsidian",
  "occluding_break",
  "profile",
  "search",
  "simulation_suspension",
] as const;

export type RuntimeSdkSmokeScope =
  (typeof SUPPORTED_RUNTIME_SDK_SMOKE_SCOPES)[number];

export type RuntimeSdkSmokeScenario =
  | "default-sdk"
  | "collect-blocks-reselection"
  | "occlusion-and-reselection"
  | "occurrence-and-hazards"
  | "mine-down"
  | "obsidian-portal"
  | "occluding-break"
  | "simulation-suspension"
  | "world-knowledge-profile";

const RUNTIME_SDK_SMOKE_SCENARIO_BY_SCOPE: Record<
  RuntimeSdkSmokeScope,
  RuntimeSdkSmokeScenario
> = {
  activation: "default-sdk",
  collect_blocks_reselection: "collect-blocks-reselection",
  craft: "default-sdk",
  eye: "default-sdk",
  inventory: "default-sdk",
  occlusion_and_reselection: "occlusion-and-reselection",
  occurrence_and_hazards: "occurrence-and-hazards",
  menu: "default-sdk",
  mine_down: "mine-down",
  obsidian: "obsidian-portal",
  occluding_break: "occluding-break",
  profile: "world-knowledge-profile",
  search: "default-sdk",
  simulation_suspension: "simulation-suspension",
};

export function parseRuntimeSdkSmokeScope(
  scope: string | undefined,
): RuntimeSdkSmokeScope | undefined {
  if (scope === undefined) return undefined;
  if (
    (SUPPORTED_RUNTIME_SDK_SMOKE_SCOPES as readonly string[]).includes(
      scope,
    )
  ) {
    return scope as RuntimeSdkSmokeScope;
  }
  throw new Error(`Unknown Runtime SDK Smoke scope ${scope}`);
}

/** Selects the fixed scenario owner before a Standard-gate process can start. */
export function selectRuntimeSdkSmokeScenario(
  scope: string | undefined,
): RuntimeSdkSmokeScenario {
  const parsedScope = parseRuntimeSdkSmokeScope(scope);
  return parsedScope === undefined
    ? "default-sdk"
    : RUNTIME_SDK_SMOKE_SCENARIO_BY_SCOPE[parsedScope];
}
