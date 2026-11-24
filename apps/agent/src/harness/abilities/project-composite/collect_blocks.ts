import {
  defineCompositeAbility,
  type CompositeAbilityDefinition,
} from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s, type InferToolSchema } from "../../tool-schema.js";
import type { ProjectAbilityNamespace } from "../index.js";
import {
  blockPositionSchema, canonicalIdGlobValue, observedDropEntitySchema, type ObservedDropEntity,
} from "../shared/schemas.js";
import { canonicalBlockId, canonicalIdGlobPattern, withOreVariantGlobNote } from "../../canonical-registry-id.js";
import {
  childFailure, failure, failureTypeOf, interrupted,
} from "../shared/composites.js";

const progress = s.object({
  requested_blocks: s.field(s.integer({ minimum: 1, maximum: 32 }), { description: "Requested bounded block target count." }),
  completed_blocks: s.field(s.integer({ minimum: 0, maximum: 32 }), { description: "Verified completed block targets." }),
  broken_blocks: s.field(s.integer({ minimum: 0, maximum: 32 }), { description: "Verified broken block targets." }),
  collected_items: s.field(s.record(s.integer({ minimum: 0 })), { description: "Verified collected item units by canonical id." }),
  completed_positions: s.field(s.array(blockPositionSchema, { maxItems: 32 }), { description: "Exact completed block positions." }),
  skipped_positions: s.field(s.array(s.object({
    position: s.field(blockPositionSchema, { description: "Exact skipped block position." }),
    failure_type: s.field(s.enumeration("target_not_known", "changed", "mismatched", "unreachable", "non_interactable"), { description: "Stable local skip reason." }),
  }), { maxItems: 32 }), { description: "Target-local skipped positions." }),
  unresolved_observed_drops: s.field(s.array(observedDropEntitySchema), { description: "Observed drops that could not be fully reconciled." }),
});
const input = s.oneOf(
  s.branch(s.object({
    block_id_glob: s.field(canonicalIdGlobValue, { description: "Required full-match Canonical ID Glob selecting remembered matching blocks; minecraft:*iron_ore matches both iron_ore and deepslate_iron_ore." }),
    count: s.optional(s.integer({ minimum: 1, maximum: 32 }), { description: "Optional requested number of completed block targets; omission collects the nearest one.", default: 1 }),
  }), { title: "ID mode", description: "Requery and select the nearest unattempted remembered match by block_id_glob after every completed or skipped target." }),
  s.branch(s.object({
    positions: s.field(s.array(blockPositionSchema, { minItems: 1, maxItems: 32, uniqueItems: true }), { description: "One to thirty-two exact unique block positions to break without block-id matching." }),
  }), { title: "Coordinate mode", description: "Directly break supplied positions in dynamic nearest-first order without a block-id selector." }),
);
const output = canonicalAbilityResultSchema(progress, progress);

export const collect_blocks: CompositeAbilityDefinition<
  "collect_blocks",
  InferToolSchema<typeof input>,
  InferToolSchema<typeof output>
> = defineCompositeAbility<ProjectAbilityNamespace>()({
  name: "collect_blocks",
  description: "Break up to 32 blocks by remembered ID glob or supplied coordinates. It approaches targets, skips unavailable ones, and counts blocks rather than item drops.",
  concurrency: "safe",
  input: input,
  output,
  async execute(input, { abilities, signal }) {
    const requestedBlocks = "positions" in input ? input.positions.length : input.count ?? 1;
    const state = {
      requested_blocks: requestedBlocks,
      completed_blocks: 0,
      broken_blocks: 0,
      collected_items: {} as Record<string, number>,
      completed_positions: [] as Array<{ x: number; y: number; z: number }>,
      skipped_positions: [] as Array<{
        position: { x: number; y: number; z: number };
        failure_type: "target_not_known" | "changed" | "mismatched" | "unreachable" | "non_interactable";
      }>,
      unresolved_observed_drops: [] as ObservedDropEntity[],
    };
    const unresolvedDropUuids = new Set<string>();
    const recordUnresolved = (drop: ObservedDropEntity, count = drop.count) => {
      if (unresolvedDropUuids.has(drop.uuid)) return;
      unresolvedDropUuids.add(drop.uuid);
      state.unresolved_observed_drops.push({ ...drop, count });
    };
    const recordUnresolvedReceipts = (receipts: readonly DropReceipt[]) => {
      for (const { drop } of receipts) recordUnresolved(drop);
    };
    const blockIdGlob = "block_id_glob" in input ? input.block_id_glob : undefined;
    const blockIdPattern = blockIdGlob === undefined ? undefined : canonicalIdGlobPattern(blockIdGlob);
    let remainingPositions: { x: number; y: number; z: number }[] | undefined;
    const attemptedPositions = new Set<string>();
    if ("positions" in input) {
      remainingPositions = [...input.positions];
    }
    for (;;) {
      if (state.completed_blocks === requestedBlocks) break;
      if (remainingPositions !== undefined && remainingPositions.length === 0) break;
      if (remainingPositions === undefined && attemptedPositions.size >= 32) break;
      if (signal.aborted) return interrupted(state);
      let position: { x: number; y: number; z: number };
      if (remainingPositions !== undefined) {
        const observedSelf = await abilities.observe_self({});
        if (!observedSelf.ok) return childFailure(observedSelf, state);
        if (signal.aborted) return interrupted(state);
        const nearestIndex = nearestPositionIndex(remainingPositions, observedSelf.data.feet);
        position = remainingPositions.splice(nearestIndex, 1)[0]!;
      } else {
        if (blockIdGlob === undefined) throw new Error("ID mode requires block_id_glob");
        const found = await abilities.find_known_blocks({ block_id_glob: blockIdGlob });
        if (!found.ok) return childFailure(found, state);
        if (signal.aborted) return interrupted(state);
        const candidate = found.data.matches.find(({ position }) => !attemptedPositions.has(positionKey(position)));
        if (candidate === undefined) break;
        position = candidate.position;
        attemptedPositions.add(positionKey(position));
      }
      let cell: Extract<Awaited<ReturnType<ProjectAbilityNamespace["observe_block"]>>, { ok: true }>["data"]["cells"][number]
        | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const observed = await abilities.observe_block(position);
        if (!observed.ok) return childFailure(observed, state);
        if (signal.aborted) return interrupted(state);
        cell = observed.data.cells[0];
        if (cell === undefined) throw new Error("observe_block returned no exact cell");
        if (cell.state !== "UNKNOWN" || attempt === 2) break;
        const waited = await abilities.wait({ seconds: 0.1 });
        if (!waited.ok) return childFailure(waited, state);
        if (signal.aborted) return interrupted(state);
      }
      if (cell === undefined) throw new Error("observe_block returned no exact cell");
      if (cell.state === "UNKNOWN") {
        state.skipped_positions.push({ position, failure_type: "target_not_known" });
        continue;
      }
      if (cell.state === "KNOWN_AIR") {
        state.skipped_positions.push({ position, failure_type: "changed" });
        continue;
      }
      if (blockIdPattern !== undefined && !blockIdPattern.test(canonicalBlockId(cell.block_state))) {
        state.skipped_positions.push({ position, failure_type: "mismatched" });
        continue;
      }
      const inventory = await abilities.observe_inventory({});
      if (!inventory.ok) {
        return childFailure(inventory, state);
      }
      if (signal.aborted) return interrupted(state);
      const broken = await abilities.goto_and_break_block({ position });
      const drops: DropReceipt[] = [
        ...broken.data.cleared_occluding_blocks.flatMap((clearing) =>
          clearing.observed_drop_entities.map((drop) => ({ drop, kind: "occluding" as const }))),
        ...(broken.ok
          ? broken.data.observed_drop_entities.map((drop) => ({ drop, kind: "target" as const }))
          : []),
      ];
      if (!broken.ok && broken.error === "INTERRUPTED") {
        recordUnresolvedReceipts(drops);
        return childFailure(broken, state);
      }
      if (broken.ok) state.broken_blocks += 1;
      let targetDropsComplete = true;
      if (drops.length > 0) {
        if (signal.aborted) {
          recordUnresolvedReceipts(drops);
          return interrupted(state);
        }
        const afterBreak = await abilities.observe_inventory({});
        if (!afterBreak.ok) {
          recordUnresolvedReceipts(drops);
          return childFailure(afterBreak, state);
        }
        if (signal.aborted) {
          recordUnresolvedReceipts(drops);
          return interrupted(state);
        }
        const unassignedGains = new Map<string, number>();
        let inventorySnapshot = inventory.data.items;
        addInventoryGains(unassignedGains, inventorySnapshot, afterBreak.data.items);
        inventorySnapshot = afterBreak.data.items;
        const recordCancelledCollection = (
          receipt: DropReceipt, data: unknown,
        ) => {
          const { drop } = receipt;
          const verified = reportedCollectedCount(data, drop.count);
          if (verified > 0) addCollected(state.collected_items, drop.item_id, verified);
          if (verified < drop.count) {
            recordUnresolved(drop, drop.count - verified);
            if (receipt.kind === "target") targetDropsComplete = false;
          }
        };
        for (const [dropIndex, receipt] of drops.entries()) {
          const { drop } = receipt;
          if (unresolvedDropUuids.has(drop.uuid)) {
            if (receipt.kind === "target") targetDropsComplete = false;
            continue;
          }
          if (signal.aborted) {
            recordUnresolvedReceipts(drops.slice(dropIndex));
            return interrupted(state);
          }
          const collected = await abilities.collect_items({ uuids: [drop.uuid] });
          if (!collected.ok && collected.error === "INTERRUPTED") {
            recordUnresolvedReceipts(drops.slice(dropIndex));
            return childFailure(collected, state);
          }
          if (signal.aborted) {
            recordCancelledCollection(receipt, collected.data);
            recordUnresolvedReceipts(drops.slice(dropIndex + 1));
            return interrupted(state);
          }
          const afterCollection = await abilities.observe_inventory({});
          if (!afterCollection.ok) {
            recordUnresolvedReceipts(drops.slice(dropIndex));
            return childFailure(afterCollection, state);
          }
          if (signal.aborted) {
            recordCancelledCollection(receipt, collected.data);
            recordUnresolvedReceipts(drops.slice(dropIndex + 1));
            return interrupted(state);
          }
          addInventoryGains(unassignedGains, inventorySnapshot, afterCollection.data.items);
          inventorySnapshot = afterCollection.data.items;
          const reported = reportedCollectedCount(collected.data, drop.count);
          if (reported > 0) {
            addCollected(state.collected_items, drop.item_id, reported);
            consumeUnassignedGain(unassignedGains, drop.item_id, reported);
          }
          const immediate = consumeUnassignedGain(
            unassignedGains, drop.item_id, drop.count - reported,
          );
          const verified = reported + immediate;
          if (immediate > 0) addCollected(state.collected_items, drop.item_id, immediate);
          if (!collected.ok
              && failureTypeOf(collected.data) !== "target_lost"
              && failureTypeOf(collected.data) !== "unreachable") {
            if (verified < drop.count) {
              recordUnresolved(drop, drop.count - verified);
              if (receipt.kind === "target") targetDropsComplete = false;
            }
            recordUnresolvedReceipts(drops.slice(dropIndex + 1));
            return childFailure(collected, state);
          }
          if (verified < drop.count) {
            recordUnresolved(drop, drop.count - verified);
            if (receipt.kind === "target") targetDropsComplete = false;
          }
          if (signal.aborted) {
            recordUnresolvedReceipts(drops.slice(dropIndex + 1));
            return interrupted(state);
          }
        }
      }
      if (!broken.ok) {
        state.skipped_positions.push({ position, failure_type: breakSkipReason(broken.data) });
        continue;
      }
      if (targetDropsComplete) {
        state.completed_blocks += 1;
        state.completed_positions.push(position);
      }
    }
    if (state.completed_blocks < requestedBlocks) {
      return failure(withOreVariantGlobNote(
        `completed ${state.completed_blocks} of ${requestedBlocks} requested block targets`, blockIdGlob,
      ), state);
    }
    return {
      ok: true as const,
      message: state.unresolved_observed_drops.length > 0
        ? "completed requested block collection with unresolved observed drops"
        : "completed requested block collection",
      data: state,
    };
  },
});

function nearestPositionIndex(
  positions: readonly { x: number; y: number; z: number }[],
  origin: { x: number; y: number; z: number },
) {
  let nearestIndex = 0;
  let nearestDistance = distance(positions[0]!, origin);
  for (let index = 1; index < positions.length; index += 1) {
    const candidateDistance = distance(positions[index]!, origin);
    if (candidateDistance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = candidateDistance;
    }
  }
  return nearestIndex;
}

function distance(
  first: { x: number; y: number; z: number },
  second: { x: number; y: number; z: number },
) {
  return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function positionKey(position: { x: number; y: number; z: number }) {
  return `${position.x},${position.y},${position.z}`;
}

function addInventoryGains(
  unassignedGains: Map<string, number>,
  beforeItems: readonly { item_id: string; count: number }[],
  afterItems: readonly { item_id: string; count: number }[],
) {
  const before = inventoryCounts(beforeItems);
  const after = inventoryCounts(afterItems);
  for (const [itemId, afterCount] of after) {
    const gain = Math.max(0, afterCount - (before.get(itemId) ?? 0));
    if (gain > 0) {
      unassignedGains.set(itemId, (unassignedGains.get(itemId) ?? 0) + gain);
    }
  }
}

function consumeUnassignedGain(
  unassignedGains: Map<string, number>, itemId: string, maximum: number,
) {
  const available = unassignedGains.get(itemId) ?? 0;
  const consumed = Math.min(available, maximum);
  unassignedGains.set(itemId, available - consumed);
  return consumed;
}

function inventoryCounts(items: readonly { item_id: string; count: number }[]) {
  return new Map(items.map(({ item_id, count }) => [item_id, count]));
}

function addCollected(collectedItems: Record<string, number>, itemId: string, count: number) {
  collectedItems[itemId] = (collectedItems[itemId] ?? 0) + count;
}

function breakSkipReason(data: unknown) {
  const failureType = failureTypeOf(data);
  if (failureType === "target_not_known_block" || failureType === "target_changed") {
    return "changed" as const;
  }
  if (failureType === "out_of_reach" || failureType === "no_interaction_pose") {
    return "unreachable" as const;
  }
  return "non_interactable" as const;
}

type DropReceipt = {
  readonly drop: ObservedDropEntity;
  readonly kind: "target" | "occluding";
};

function reportedCollectedCount(data: unknown, maximum: number) {
  if (data === null || typeof data !== "object"
      || !("collected_items" in data) || typeof data.collected_items !== "number") {
    return 0;
  }
  return Math.min(maximum, Math.max(0, data.collected_items));
}
