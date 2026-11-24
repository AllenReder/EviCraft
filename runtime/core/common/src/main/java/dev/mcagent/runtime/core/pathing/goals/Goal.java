package dev.mcagent.runtime.core.pathing.goals;

import net.minecraft.core.BlockPos;

/**
 * Search goal: a membership test plus a heuristic. The heuristic uses the same unit as move costs
 * (ticks) and gives an optimistic estimate of the remaining cost from (x,y,z) to the goal.
 */
public interface Goal {

    /** Whether (x,y,z) is already inside the goal. */
    boolean isInGoal(int x, int y, int z);

    /** Optimistic remaining cost from (x,y,z) to the goal, in ticks. */
    double heuristic(int x, int y, int z);

    /** Whether equal-cost terminal cells require goal-defined deterministic ordering. */
    default boolean ordersEqualCostGoals() {
        return false;
    }

    /** Compare two equal-cost terminal cells when deterministic ordering is requested. */
    default int compareEqualCostGoals(BlockPos left, BlockPos right) {
        return 0;
    }
}
