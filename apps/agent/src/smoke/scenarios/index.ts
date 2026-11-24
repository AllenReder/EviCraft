import type { ScenarioRunContext } from "./shared.js";
import { interactionAndCollectionScenario } from "./interaction-and-collection.js";
import { furnaceProcessingScenario } from "./furnace-processing.js";
import { sleepingAndScaffoldPolicyScenario } from "./sleeping-and-scaffold-policy.js";
import { combatAndTargetEliminationScenario } from "./combat-and-target-elimination.js";
import { foodConsumptionAndRecoveryScenario } from "./food-consumption-and-recovery.js";
import { exploreAndReturnSurfaceScenario } from "./explore-and-return-surface.js";
import { exploreAndReturnBranchingCaveScenario } from "./explore-and-return-branching-cave.js";
import { suffocationEscapeScenario } from "./suffocation-escape.js";
import { placementApproachAndRetryScenario } from "./placement-approach-and-retry.js";
import { staleTargetRecoveryScenario } from "./stale-target-recovery.js";
import { limitedScaffoldBridgeScenario } from "./limited-scaffold-bridge.js";
import {
  tunnelBoundedNotFoundScenario, tunnelFrontierEarlyStopScenario,
} from "./tunnel-bounded-branches.js";
import { runExplorationExcursionScenario } from "./explore-and-return-surface.js";
import { dropObserveAndRecollectScenario } from "./drop-observe-and-recollect.js";
import { staircaseDescentAndReturnScenario } from "./staircase-descent-and-return.js";
import { underwaterSurfaceColumnScenario } from "./underwater-surface-column.js";
import { exactTargetCombatInterferenceScenario } from "./exact-target-combat-interference.js";
import { multiRoomFurnaceWorkflowScenario } from "./multi-room-furnace-workflow.js";
import { crossDimensionTaskSwitchScenario } from "./cross-dimension-task-switch.js";
import { chunkTrackingReacquisitionScenario } from "./chunk-tracking-reacquisition.js";

export interface AbilityConformanceScenarioRegistration {
  readonly id: string;
  readonly run: (context: ScenarioRunContext) => Promise<void>;
}

export const ABILITY_CONFORMANCE_SCENARIOS = Object.freeze([
  interactionAndCollectionScenario,
  furnaceProcessingScenario,
  sleepingAndScaffoldPolicyScenario,
  combatAndTargetEliminationScenario,
  foodConsumptionAndRecoveryScenario,
  exploreAndReturnSurfaceScenario,
  exploreAndReturnBranchingCaveScenario,
  suffocationEscapeScenario,
  placementApproachAndRetryScenario,
  staleTargetRecoveryScenario,
  limitedScaffoldBridgeScenario,
  tunnelFrontierEarlyStopScenario,
  tunnelBoundedNotFoundScenario,
  {
    id: "visible-ring-and-return" as const,
    run: (context: ScenarioRunContext) => runExplorationExcursionScenario(context, {
      maxOutboundDisplacement: 12,
      requireBranchRecovery: false,
    }),
  },
  dropObserveAndRecollectScenario,
  staircaseDescentAndReturnScenario,
  underwaterSurfaceColumnScenario,
  exactTargetCombatInterferenceScenario,
  multiRoomFurnaceWorkflowScenario,
  crossDimensionTaskSwitchScenario,
  chunkTrackingReacquisitionScenario,
] as const satisfies readonly AbilityConformanceScenarioRegistration[]);

export type AbilityConformanceScenarioId = typeof ABILITY_CONFORMANCE_SCENARIOS[number]["id"];
