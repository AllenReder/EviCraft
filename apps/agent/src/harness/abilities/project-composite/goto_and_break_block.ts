import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { failure, failureTypeOf, interrupted } from "../shared/composites.js";
import { blockPositionSchema, observedDropEntitySchema } from "../shared/schemas.js";

const clearedOccludingBlock = s.object({
  position: s.field(blockPositionSchema, { description: "Exact verified removed Pose-local Occluding Block position." }),
  block_state: s.field(s.string(), { description: "Canonical BlockState of the removed Occluding Block." }),
  observed_drop_entities: s.field(s.array(observedDropEntitySchema), { description: "Best-effort ordinary ItemEntity evidence observed for this clearing break." }),
});
const successData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact target position whose original block was verified absent." }),
  observed_drop_entities: s.field(s.array(observedDropEntitySchema), { description: "Best-effort ordinary ItemEntity evidence observed for the target break." }),
  cleared_occluding_blocks: s.field(s.array(clearedOccludingBlock), { description: "Committed exact Pose-local Occluding Block removals in verified removal order." }),
});
const failureData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact frozen target position." }),
  cleared_occluding_blocks: s.field(s.array(clearedOccludingBlock), { description: "Committed exact Pose-local Occluding Block removals before failure." }),
  failure_type: s.field(s.enumeration(
    "menu_open", "target_not_known_block", "target_changed", "target_not_breakable",
    "no_interaction_pose", "occluding_block_not_cleared",
  ), { description: "Stable reason the frozen target break workflow did not complete." }),
});
const interruptionData = s.object({
  position: s.field(blockPositionSchema, { description: "Exact frozen target position retained after interruption." }),
  cleared_occluding_blocks: s.field(s.array(clearedOccludingBlock), { description: "Committed exact Pose-local Occluding Block removals before interruption." }),
});
const input = s.object({ position: s.field(blockPositionSchema, { description: "Exact known block position." }) });
const output = canonicalAbilityResultVariants(successData, [
  { error: "RUNTIME_FAILED", data: failureData, title: "Expected break workflow failure", description: "The frozen target break workflow reached a stable terminal failure." },
  { error: "INTERRUPTED", data: interruptionData, title: "Break workflow interrupted", description: "The workflow was interrupted before the frozen target disappeared." },
]);

export const goto_and_break_block: CompositeAbilityDefinition<
  "goto_and_break_block",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "goto_and_break_block",
  description: "Break an exact known block, approaching it when needed and clearing direct blockers when necessary.",
  concurrency: "safe", input: input, output: output,
  async execute(value, { abilities, signal }) {
    const target = value.position;
    const cleared_occluding_blocks: Array<InferToolSchema<typeof clearedOccludingBlock>> = [];
    let recovery: TargetRecoveryState = "pose_search_available";
    let failedOccludingBlock: Position | undefined;

    for (;;) {
      if (signal.aborted) return interruption(target, cleared_occluding_blocks);
      const targetResult = await abilities.break_block({ position: target });
      if (targetResult.ok) {
        return {
          ok: true as const,
          message: targetResult.message,
          data: {
            position: target,
            observed_drop_entities: targetResult.data.observed_drop_entities,
            cleared_occluding_blocks,
          },
        };
      }
      if (targetResult.error === "INTERRUPTED") {
        return interruption(target, cleared_occluding_blocks);
      }
      if (signal.aborted) {
        return interruption(target, cleared_occluding_blocks);
      }

      const targetFailureData = targetResult.data as BreakBlockFailureData;
      const targetFailure = targetFailureData.failure_type;
      const occluder = targetFailure === "occluded"
        ? targetFailureData.occluding_block
        : undefined;
      if (occluder !== undefined) {
        if (recovery === "final_probe_after_failed_clear"
          && samePosition(occluder.position, failedOccludingBlock)) {
          return workflowFailure(targetResult.message, target, cleared_occluding_blocks, "occluding_block_not_cleared");
        }
        const clearing = await abilities.break_block({ position: occluder.position });
        if (clearing.ok) {
          cleared_occluding_blocks.push({
            position: occluder.position,
            block_state: occluder.block_state,
            observed_drop_entities: clearing.data.observed_drop_entities,
          });
          failedOccludingBlock = undefined;
          recovery = "pose_search_available";
          continue;
        }
        if (clearing.error === "INTERRUPTED" || signal.aborted) {
          return interruption(target, cleared_occluding_blocks);
        }
        if (recovery !== "pose_search_available") {
          return workflowFailure(clearing.message, target, cleared_occluding_blocks, "occluding_block_not_cleared");
        }
        failedOccludingBlock = occluder.position;
        const pose = await runPoseSearch(target, abilities, signal);
        if (pose.kind === "interrupted") return interruption(target, cleared_occluding_blocks);
        if (pose.kind === "failure") {
          return workflowFailure(pose.message, target, cleared_occluding_blocks, pose.failure_type);
        }
        recovery = pose.kind === "success"
          ? "pose_search_exhausted_after_failed_clear"
          : "final_probe_after_failed_clear";
        continue;
      }

      if (targetFailure === "out_of_reach" || targetFailure === "occluded") {
        if (recovery !== "pose_search_available") {
          return workflowFailure(
            targetResult.message,
            target,
            cleared_occluding_blocks,
            recovery === "pose_search_exhausted_after_failed_clear" || recovery === "final_probe_after_failed_clear"
              ? "occluding_block_not_cleared" : targetFailure === "out_of_reach"
              ? "no_interaction_pose" : "target_not_breakable",
          );
        }
        const pose = await runPoseSearch(target, abilities, signal);
        if (pose.kind === "interrupted") return interruption(target, cleared_occluding_blocks);
        if (pose.kind === "failure") {
          return workflowFailure(pose.message, target, cleared_occluding_blocks, pose.failure_type);
        }
        recovery = "pose_search_exhausted";
        continue;
      }

      return workflowFailure(
        targetResult.message,
        target,
        cleared_occluding_blocks,
        normalizedTargetFailure(targetFailure),
      );
    }
  },
});

type Position = InferToolSchema<typeof blockPositionSchema>;
type ClearedOccludingBlock = InferToolSchema<typeof clearedOccludingBlock>;
type BreakBlockFailureData = Extract<
  Awaited<ReturnType<ProjectAbilityNamespace["break_block"]>>["data"],
  { failure_type: string }
>;
type TargetRecoveryState =
  | "pose_search_available"
  | "pose_search_exhausted"
  | "pose_search_exhausted_after_failed_clear"
  | "final_probe_after_failed_clear";

async function runPoseSearch(
  position: Position,
  abilities: Pick<ProjectAbilityNamespace, "goto_block_interaction_pose">,
  signal: AbortSignal,
): Promise<
  | { kind: "success" }
  | { kind: "no_interaction_pose" }
  | { kind: "interrupted" }
  | { kind: "failure"; message: string; failure_type: "target_not_known_block" | "target_changed" }
> {
  const pose = await abilities.goto_block_interaction_pose({ position });
  if (pose.ok) return signal.aborted ? { kind: "interrupted" } : { kind: "success" };
  if (pose.error === "INTERRUPTED" || signal.aborted) return { kind: "interrupted" };
  switch (failureTypeOf(pose.data)) {
    case "no_interaction_pose": return { kind: "no_interaction_pose" };
    case "target_not_known_block": return { kind: "failure", message: pose.message, failure_type: "target_not_known_block" };
    case "target_changed": return { kind: "failure", message: pose.message, failure_type: "target_changed" };
    default: throw new Error("goto_block_interaction_pose returned an unsupported failure type");
  }
}

function samePosition(left: Position, right: Position | undefined): boolean {
  return right !== undefined && left.x === right.x && left.y === right.y && left.z === right.z;
}

function normalizedTargetFailure(failureType: string | undefined) {
  switch (failureType) {
    case "menu_open":
    case "target_not_known_block":
    case "target_changed": return failureType;
    case "unbreakable":
    case "unsupported_shape":
    case "no_effect": return "target_not_breakable" as const;
    default: return "target_not_breakable" as const;
  }
}

function workflowFailure(
  message: string,
  position: Position,
  cleared_occluding_blocks: ClearedOccludingBlock[],
  failure_type: "menu_open" | "target_not_known_block" | "target_changed" | "target_not_breakable" | "no_interaction_pose" | "occluding_block_not_cleared",
) {
  return failure(message, { position, cleared_occluding_blocks, failure_type });
}

function interruption(position: Position, cleared_occluding_blocks: ClearedOccludingBlock[]) {
  return interrupted({ position, cleared_occluding_blocks });
}
