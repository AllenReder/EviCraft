import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { place_block } from "../built-in/place_block.js";
import { blockPositionSchema, canonicalIdValue } from "../shared/schemas.js";
import {
  childFailure,
  failure,
  failureTypeOf,
  interrupted,
  samePosition,
} from "../shared/composites.js";

type BlockPosition = InferToolSchema<typeof blockPositionSchema>;
type PlacementResult = Awaited<ReturnType<ProjectAbilityNamespace["place_block"]>>;

const input = s.object({
  item_id: s.field(canonicalIdValue, {
    description: "Exact canonical carried BlockItem id to try nearby.",
    examples: ["minecraft:cobblestone"],
  }),
});
const attempt = s.object({
  position: s.field(blockPositionSchema, { description: "Exact nearby candidate position passed to place_block." }),
  result: s.field(place_block.output, { description: "Complete place_block result for the attempted position." }),
});
const successData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical BlockItem id requested for placement." }),
  origin: s.field(blockPositionSchema, { description: "Frozen Ability Start Feet Snapshot." }),
  attempted_count: s.field(s.integer({ minimum: 1, maximum: 73 }), {
    description: "Number of actual place_block calls made through the successful attempt.",
  }),
  successful_position: s.field(blockPositionSchema, {
    description: "Exact candidate position where place_block verified placement.",
  }),
  placement: s.field(place_block.output, {
    description: "Complete successful place_block result at successful_position.",
  }),
});
const incompleteData = s.object({
  item_id: s.field(canonicalIdValue, { description: "Canonical BlockItem id requested for placement." }),
  origin: s.optional(blockPositionSchema, {
    description: "Frozen Ability Start Feet Snapshot when observe_self succeeded.",
  }),
  attempted_count: s.field(s.integer({ minimum: 0, maximum: 73 }), {
    description: "Number of actual place_block calls made before this result.",
  }),
  last_attempt: s.optional(attempt, {
    description: "Complete result for the most recent actual place_block call.",
  }),
  failure_counts: s.optional(s.record(s.integer({ minimum: 1 })), {
    description: "How many candidates failed with each place_block failure_type, e.g. "
      + "{\"target_occupied\": 60, \"no_support\": 11}: the overall reason nothing nearby worked.",
  }),
});
const output = canonicalAbilityResultSchema(successData, incompleteData);

const LOCAL_FAILURE_TYPES = new Set([
  "target_unknown",
  "target_occupied",
  "second_cell_not_free",
  "target_changed",
  "no_support",
  "body_in_target",
  "entity_blocked",
  "out_of_reach",
  "occluded",
  "unsupported_shape",
]);

export const place_block_nearby: CompositeAbilityDefinition<
  "place_block_nearby",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "place_block_nearby",
  description: "Try one carried BlockItem in a frozen nearest-first 5x5 set around the current feet: the feet layer, then one above, then one below. Candidates may be known air or known replaceable blocks (water, grass). It skips the Bot's feet and head, never navigates, stops at the first verified placement, and when no candidate succeeds returns the last attempt plus failure_counts per failure_type.",
  concurrency: "safe",
  input: input,
  output,
  async execute({ item_id }, { abilities, signal }) {
    const emptyProgress = { item_id, attempted_count: 0 };
    if (signal.aborted) return interrupted(emptyProgress);

    const observed = await abilities.observe_self({});
    if (!observed.ok) return childFailure(observed, emptyProgress);

    const origin = { ...observed.data.feet };
    const progress: {
      item_id: string;
      origin: BlockPosition;
      attempted_count: number;
      last_attempt?: { position: BlockPosition; result: PlacementResult };
      failure_counts?: Record<string, number>;
    } = { item_id, origin, attempted_count: 0 };
    const candidates = nearbyCandidates(origin);
    for (const position of candidates) {
      if (signal.aborted) return interrupted(progress);

      const result = await abilities.place_block({ item_id, position });
      progress.attempted_count += 1;
      progress.last_attempt = { position, result };

      if (!result.ok && result.error === "INTERRUPTED") return childFailure(result, progress);
      if (signal.aborted) return interrupted(progress);
      if (result.ok) {
        return {
          ok: true as const,
          message: result.message,
          data: {
            item_id,
            origin,
            attempted_count: progress.attempted_count,
            successful_position: position,
            placement: result,
          },
        };
      }
      const failureType = failureTypeOf(result.data);
      if (failureType !== undefined) {
        progress.failure_counts = {
          ...progress.failure_counts,
          [failureType]: (progress.failure_counts?.[failureType] ?? 0) + 1,
        };
      }
      if (continuesToNextCandidate(result)) continue;
      return childFailure(result, progress);
    }
    return failure("no nearby placement candidate was verified", progress);
  },
});

function nearbyCandidates(origin: BlockPosition): readonly BlockPosition[] {
  const offsets = Array.from({ length: 5 }, (_, index) => index - 2)
    .flatMap((x) => Array.from({ length: 5 }, (_, index) => index - 2)
      .map((z) => ({ x, z })))
    .sort((left, right) => (
      left.x * left.x + left.z * left.z - right.x * right.x - right.z * right.z
      || left.x - right.x
      || left.z - right.z
    ));
  const candidates = [0, 1, -1].flatMap((yOffset) => offsets.map(({ x, z }) => ({
    x: origin.x + x,
    y: origin.y + yOffset,
    z: origin.z + z,
  }))).filter((candidate) => !samePosition(candidate, origin)
    && !samePosition(candidate, { ...origin, y: origin.y + 1 }));
  if (candidates.length !== 73) throw new Error("Nearby Block Placement candidate geometry is invalid");
  return candidates;
}

function continuesToNextCandidate(result: Extract<PlacementResult, { ok: false }>): boolean {
  const failureType = failureTypeOf(result.data);
  return failureType !== undefined && (
    LOCAL_FAILURE_TYPES.has(failureType)
    || failureType === "no_effect" && hasVerifiedNoEffect(result.data)
  );
}

function hasVerifiedNoEffect(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const partial = data as { consumed_count?: unknown; block_state?: unknown };
  return partial.consumed_count === 0 && partial.block_state === undefined;
}
