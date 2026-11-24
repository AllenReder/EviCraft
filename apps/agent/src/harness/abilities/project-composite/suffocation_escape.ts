import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultVariants } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import { toolEmpty, blockPositionSchema } from "../shared/schemas.js";
import { interrupted } from "../shared/composites.js";

const brokenBlocks = s.array(blockPositionSchema, { maxItems: 32 });
const progress = {
  adjacent_attempts: s.field(s.integer({ minimum: 0, maximum: 4 }), {
    description: "Number of adjacent supported Feet Cells submitted to goto.",
  }),
  broken_blocks: s.field(brokenBlocks, {
    description:
      "Exact block positions whose disappearance was verified during this escape.",
  }),
};
const successData = s.object({
  escape_method: s.field(s.enumeration("adjacent", "fallback"), {
    description: "Verified escape path that cleared suffocation.",
  }),
  final_feet: s.field(blockPositionSchema, {
    description:
      "Freshly observed final Feet Cell after suffocation and feet-cell clearance were verified.",
  }),
  ...progress,
});
const failureData = s.object({
  failure_type: s.field(
    s.enumeration("no_escape_route", "block_limit", "time_limit"),
    {
      description:
        "Stable bound or physical reason the escape could not be verified.",
    },
  ),
  last_observed_feet: s.optional(blockPositionSchema, {
    description:
      "Most recent embodied Feet Cell observed before failure, when available.",
  }),
  last_observed_suffocating: s.optional(s.boolean(), {
    description:
      "Most recent embodied suffocation state observed before failure, when available.",
  }),
  ...progress,
});
const interruptionData = s.object({
  last_observed_feet: s.optional(blockPositionSchema, {
    description:
      "Most recent embodied Feet Cell observed before interruption, when available.",
  }),
  last_observed_suffocating: s.optional(s.boolean(), {
    description:
      "Most recent embodied suffocation state observed before interruption, when available.",
  }),
  ...progress,
});
const output = canonicalAbilityResultVariants(successData, [
  {
    error: "RUNTIME_FAILED",
    data: failureData,
    title: "Expected suffocation escape failure",
    description:
      "The bounded escape workflow could not verify a usable non-suffocating pose.",
  },
  {
    error: "INTERRUPTED",
    data: interruptionData,
    title: "Suffocation escape interrupted",
    description:
      "The escape workflow was interrupted after retaining verified progress.",
  },
]);

type Position = InferToolSchema<typeof blockPositionSchema>;
type SelfObservation = Readonly<{
  feet: Position;
  suffocating: boolean;
  intersecting_blocks?: readonly Position[];
}>;

const directions = Object.freeze([
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
]);

export const suffocation_escape: CompositeAbilityDefinition<
  "suffocation_escape",
  InferToolSchema<typeof toolEmpty>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "suffocation_escape",
  description:
    "Escape a currently obstructed pose by trying one verified adjacent supported Feet Cell, then clearing repeated head and feet obstructions without collecting drops. Success proves fresh non-suffocating body state.",
  concurrency: "safe",
  input: toolEmpty,
  output,
  async execute(_input, { abilities, signal }) {
    let adjacentAttempts = 0;
    const broken: Position[] = [];
    let lastSelf: SelfObservation | undefined;

    const initial = await abilities.observe_self({});
    if (!initial.ok) {
      return initial.error === "INTERRUPTED"
        ? canceled(signal, lastSelf, adjacentAttempts, broken)
        : failed(
            "could not observe the obstructed pose",
            "no_escape_route",
            lastSelf,
            adjacentAttempts,
            broken,
          );
    }
    lastSelf = initial.data;
    if (signal.aborted)
      return canceled(signal, lastSelf, adjacentAttempts, broken);

    const candidates: Position[] = [];
    if (initial.data.suffocating) {
      for (const direction of directions) {
        const feet = {
          x: initial.data.feet.x + direction.x,
          y: initial.data.feet.y,
          z: initial.data.feet.z + direction.z,
        };
        const clearFeet = await knownState(feet, abilities);
        const clearHead = await knownState(
          { ...feet, y: feet.y + 1 },
          abilities,
        );
        const support = await knownState({ ...feet, y: feet.y - 1 }, abilities);
        if (signal.aborted)
          return canceled(signal, lastSelf, adjacentAttempts, broken);
        if (
          clearFeet === "INTERRUPTED" ||
          clearHead === "INTERRUPTED" ||
          support === "INTERRUPTED"
        ) {
          return interruption(lastSelf, adjacentAttempts, broken);
        }
        if (
          clearFeet === "KNOWN_AIR" &&
          clearHead === "KNOWN_AIR" &&
          support === "KNOWN_BLOCK"
        ) {
          candidates.push(feet);
        }
      }
    }

    const candidate = candidates[0];
    if (candidate !== undefined) {
      adjacentAttempts += 1;
      const moved = await abilities.goto(candidate);
      if ((!moved.ok && moved.error === "INTERRUPTED") || signal.aborted) {
        return canceled(signal, lastSelf, adjacentAttempts, broken);
      }
      const observed = await abilities.observe_self({});
      if (!observed.ok) {
        return observed.error === "INTERRUPTED"
          ? interruption(lastSelf, adjacentAttempts, broken)
          : failed(
              "could not verify the adjacent movement",
              "no_escape_route",
              lastSelf,
              adjacentAttempts,
              broken,
            );
      }
      lastSelf = observed.data;
      if (
        samePosition(observed.data.feet, candidate) &&
        !observed.data.suffocating
      ) {
        const feetState = await knownState(observed.data.feet, abilities);
        if (feetState === "KNOWN_AIR") {
          return {
            ok: true as const,
            message:
              "escaped suffocation through an adjacent supported Feet Cell",
            data: {
              escape_method: "adjacent" as const,
              final_feet: observed.data.feet,
              adjacent_attempts: adjacentAttempts,
              broken_blocks: broken,
            },
          };
        }
      }
    }

    for (;;) {
      if (signal.aborted)
        return canceled(signal, lastSelf, adjacentAttempts, broken);
      const target = lastSelf.suffocating
        ? suffocationTarget(lastSelf)
        : lastSelf.feet;
      const state = await knownState(target, abilities);
      if (signal.aborted)
        return canceled(signal, lastSelf, adjacentAttempts, broken);
      if (state === "INTERRUPTED")
        return interruption(lastSelf, adjacentAttempts, broken);
      if (state === "KNOWN_AIR") {
        if (lastSelf.suffocating) {
          return failed("suffocation continued without a known obstruction", "no_escape_route", lastSelf, adjacentAttempts, broken);
        }
        return {
          ok: true as const,
          message: "escaped suffocation and verified a usable Feet Cell",
          data: {
            escape_method: "fallback" as const,
            final_feet: lastSelf.feet,
            adjacent_attempts: adjacentAttempts,
            broken_blocks: broken,
          },
        };
      }
      if (state !== "KNOWN_BLOCK") {
        return failed(
          "the current obstruction is not known well enough to clear",
          "no_escape_route",
          lastSelf,
          adjacentAttempts,
          broken,
        );
      }
      if (broken.length >= 32) {
        return failed(
          "suffocation escape reached the thirty-two-block limit",
          "block_limit",
          lastSelf,
          adjacentAttempts,
          broken,
        );
      }
      const cleared = await abilities.break_block({ position: target });
      if (!cleared.ok) {
        return cleared.error === "INTERRUPTED" || signal.aborted
          ? canceled(signal, lastSelf, adjacentAttempts, broken)
          : failed(
              cleared.message,
              "no_escape_route",
              lastSelf,
              adjacentAttempts,
              broken,
            );
      }
      broken.push(target);
      const observed = await abilities.observe_self({});
      if (!observed.ok) {
        return observed.error === "INTERRUPTED" || signal.aborted
          ? canceled(signal, lastSelf, adjacentAttempts, broken)
          : failed(
              "could not verify progress after clearing an obstruction",
              "no_escape_route",
              lastSelf,
              adjacentAttempts,
              broken,
            );
      }
      lastSelf = observed.data;
    }
  },
});

async function knownState(
  position: Position,
  abilities: Pick<ProjectAbilityNamespace, "observe_block">,
): Promise<"KNOWN_AIR" | "KNOWN_BLOCK" | "UNKNOWN" | "INTERRUPTED"> {
  const observed = await abilities.observe_block(position);
  if (!observed.ok)
    return observed.error === "INTERRUPTED" ? "INTERRUPTED" : "UNKNOWN";
  return observed.data.cells[0]?.state ?? "UNKNOWN";
}

function suffocationTarget(self: SelfObservation): Position {
  const head = { ...self.feet, y: self.feet.y + 1 };
  return self.intersecting_blocks?.find((position) => samePosition(position, head))
    ?? self.intersecting_blocks?.[0]
    ?? head;
}

function samePosition(left: Position, right: Position): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function failed(
  message: string,
  failure_type: "no_escape_route" | "block_limit" | "time_limit",
  lastSelf: SelfObservation | undefined,
  adjacent_attempts: number,
  broken_blocks: Position[],
) {
  return {
    ok: false as const,
    error: "RUNTIME_FAILED" as const,
    message,
    data: {
      failure_type,
      ...(lastSelf === undefined
        ? {}
        : {
            last_observed_feet: lastSelf.feet,
            last_observed_suffocating: lastSelf.suffocating,
          }),
      adjacent_attempts,
      broken_blocks,
    },
  };
}

function interruption(
  lastSelf: SelfObservation | undefined,
  adjacent_attempts: number,
  broken_blocks: Position[],
) {
  return interrupted({
    ...(lastSelf === undefined
      ? {}
      : {
          last_observed_feet: lastSelf.feet,
          last_observed_suffocating: lastSelf.suffocating,
        }),
    adjacent_attempts,
    broken_blocks,
  });
}

function canceled(
  signal: AbortSignal,
  lastSelf: SelfObservation | undefined,
  adjacent_attempts: number,
  broken_blocks: Position[],
) {
  return signal.reason instanceof Error && signal.reason.name === "CompositeExecutionTimeoutError"
    ? failed(
        "suffocation escape reached the thirty-second time limit",
        "time_limit",
        lastSelf,
        adjacent_attempts,
        broken_blocks,
      )
    : interruption(lastSelf, adjacent_attempts, broken_blocks);
}
