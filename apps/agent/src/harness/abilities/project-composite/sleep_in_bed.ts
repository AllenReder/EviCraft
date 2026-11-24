import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
  type CompositeProgramContext,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { enter_bed } from "../built-in/enter_bed.js";
import { goto_block_interaction_pose } from "../built-in/goto_block_interaction_pose.js";
import { blockPositionSchema } from "../shared/schemas.js";
import { childFailure, failure, interrupted } from "../shared/composites.js";

const attemptedCandidate = s.object({
  position: s.field(blockPositionSchema, { description: "Exact attempted bed position." }),
  enter_bed: s.field(enter_bed.output, { description: "Initial exact bed-entry result." }),
  approach: s.optional(goto_block_interaction_pose.output, { description: "Interaction-pose approach result when attempted." }),
  retry: s.optional(enter_bed.output, { description: "Bed-entry retry result when attempted." }),
});
const attemptedCandidates = s.array(attemptedCandidate, { maxItems: 32 });
const output = canonicalAbilityResultSchema(
  s.object({
    position: s.field(blockPositionSchema, { description: "Exact verified bed position." }),
    attempted_candidates: s.field(attemptedCandidates, { description: "Frozen ordered candidate attempts." }),
  }),
  s.object({ attempted_candidates: s.field(attemptedCandidates, { description: "Frozen ordered candidate attempts and partial progress." }) }),
);
type BlockPosition = InferToolSchema<typeof blockPositionSchema>;
type EnterBedResult = Awaited<ReturnType<ProjectAbilityNamespace["enter_bed"]>>;
type ApproachResult = Awaited<ReturnType<ProjectAbilityNamespace["goto_block_interaction_pose"]>>;
type Attempt = {
  position: BlockPosition;
  enter_bed: EnterBedResult;
  approach?: ApproachResult;
  retry?: EnterBedResult;
};

const BED_GLOB = "minecraft:*_bed";
const input = s.oneOf(
  s.branch(s.object({
    position: s.field(blockPositionSchema, { description: "One exact evidence-backed bed position." }),
  }), { title: "Exact bed", description: "Attempt one exact known bed." }),
  s.branch(s.object({
    distance: s.optional(s.integer({ minimum: 1, maximum: 64 }), { description: "Maximum bed-candidate distance; omission uses 32.", default: 32 }),
  }), { title: "Nearby remembered beds", description: "Freeze nearby remembered vanilla bed candidates." }),
);

export const sleep_in_bed: CompositeAbilityDefinition<
  "sleep_in_bed",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "sleep_in_bed",
  description: "Sleep in an exact bed or try nearby remembered beds. It approaches unreachable candidates, sets respawn on success, and returns without waiting for morning.",
  concurrency: "safe",
  input: input,
  output,
  async execute(input, { abilities, signal }) {
    const attempted_candidates: Attempt[] = [];
    const canceled = () => interrupted({ attempted_candidates });
    const distanceMode = !("position" in input);
    let candidates: BlockPosition[];
    if (signal.aborted) return canceled();

    if (!distanceMode) {
      candidates = [input.position];
    } else {
      const observedSelf = await abilities.observe_self({});
      if (!observedSelf.ok) return childFailure(observedSelf, { attempted_candidates });
      if (signal.aborted) return canceled();
      const found = await abilities.find_known_blocks({ block_id_glob: BED_GLOB });
      if (!found.ok) return childFailure(found, { attempted_candidates });
      if (signal.aborted) return canceled();
      candidates = frozenBedCandidates(
        found.data.matches,
        observedSelf.data.feet,
        input.distance ?? 32,
      );
    }

    if (candidates.length === 0) {
      return failure("no nearby remembered vanilla bed was selected", {
        attempted_candidates,
      });
    }

    for (const position of candidates) {
      if (signal.aborted) return canceled();
      const attempted = await attemptBed(position, { abilities, signal });
      attempted_candidates.push(attempted.attempt);
      if (isVerifiedSleep(attempted.result)) {
        return {
          ok: true as const,
          message: attempted.result.message,
          data: { position: attempted.result.data.position, attempted_candidates },
        };
      }
      if (signal.aborted) return canceled();
      if (attempted.result.ok) {
        throw new Error("sleep_in_bed candidate ended after approach without a sleep result");
      }
      if (attempted.result.error === "INTERRUPTED") {
        return childFailure(attempted.result, { attempted_candidates });
      }
      if (!distanceMode || !isLocalCandidateFailure(attempted.result)) {
        return childFailure(attempted.result, { attempted_candidates });
      }
    }
    return failure("all frozen remembered bed candidates failed", {
      attempted_candidates,
    });
  },
});

async function attemptBed(
  position: BlockPosition,
  { abilities, signal }: CompositeProgramContext<ProjectAbilityNamespace>,
): Promise<{ attempt: Attempt; result: EnterBedResult | ApproachResult }> {
  const entered = await abilities.enter_bed({ position });
  const attempt: Attempt = { position, enter_bed: entered };
  if (entered.ok || entered.error === "INTERRUPTED" || !("failure_type" in entered.data)
      || entered.data.failure_type !== "out_of_reach" || signal.aborted) {
    return { attempt, result: entered };
  }
  const approach = await abilities.goto_block_interaction_pose({ position });
  attempt.approach = approach;
  if (!approach.ok || signal.aborted) return { attempt, result: approach };
  const retry = await abilities.enter_bed({ position });
  attempt.retry = retry;
  return { attempt, result: retry };
}

function frozenBedCandidates(
  matches: readonly { position: BlockPosition; block_state: string }[],
  start: BlockPosition,
  distance: number,
) {
  const maximumDistanceSquared = distance * distance;
  const candidateIndexByHead = new Map<string, number>();
  const candidates: BlockPosition[] = [];
  for (const candidate of [...matches].sort((left, right) =>
    distanceSquared(start, left.position) - distanceSquared(start, right.position)
    || left.position.x - right.position.x
    || left.position.y - right.position.y
    || left.position.z - right.position.z)) {
    if (distanceSquared(start, candidate.position) > maximumDistanceSquared) continue;
    const head = logicalBedHead(candidate);
    if (head === undefined) continue;
    const key = `${head.x},${head.y},${head.z}`;
    const existingIndex = candidateIndexByHead.get(key);
    if (existingIndex === undefined) {
      candidateIndexByHead.set(key, candidates.length);
      candidates.push(candidate.position);
    } else if (samePosition(candidate.position, head)) {
      candidates[existingIndex] = candidate.position;
    }
  }
  return candidates;
}

function logicalBedHead(candidate: { position: BlockPosition; block_state: string }) {
  const bracket = candidate.block_state.indexOf("[");
  const blockId = bracket < 0 ? candidate.block_state : candidate.block_state.slice(0, bracket);
  if (!blockId.startsWith("minecraft:") || !blockId.endsWith("_bed") || bracket < 0
      || !candidate.block_state.endsWith("]")) return undefined;
  const properties = new Map(candidate.block_state.slice(bracket + 1, -1).split(",").map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const part = properties.get("part");
  if (part === "head") return candidate.position;
  if (part !== "foot") return undefined;
  switch (properties.get("facing")) {
    case "north": return { ...candidate.position, z: candidate.position.z - 1 };
    case "east": return { ...candidate.position, x: candidate.position.x + 1 };
    case "south": return { ...candidate.position, z: candidate.position.z + 1 };
    case "west": return { ...candidate.position, x: candidate.position.x - 1 };
    default: return undefined;
  }
}

function isLocalCandidateFailure(result: Extract<EnterBedResult | ApproachResult, { ok: false }>) {
  if (!("failure_type" in result.data)) return false;
  return [
    "occupied",
    "obstructed",
    "unsafe_nearby_monster",
    "target_changed",
    "out_of_reach",
    "no_interaction_pose",
  ].includes(result.data.failure_type);
}

function isVerifiedSleep(
  result: EnterBedResult | ApproachResult,
): result is Extract<EnterBedResult, { ok: true }> {
  return result.ok && "sleeping" in result.data && result.data.sleeping === true;
}

function distanceSquared(first: BlockPosition, second: BlockPosition) {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2 + (first.z - second.z) ** 2;
}

function samePosition(first: BlockPosition, second: BlockPosition) {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}
