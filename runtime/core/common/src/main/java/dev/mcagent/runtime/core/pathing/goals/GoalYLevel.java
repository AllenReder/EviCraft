package dev.mcagent.runtime.core.pathing.goals;

import dev.mcagent.runtime.core.pathing.moves.ActionCosts;

/** Height goal: reached at the given Y level, at any horizontal position. */
public class GoalYLevel implements Goal {

    public final int level;

    public GoalYLevel(int level) {
        this.level = level;
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        return y == level;
    }

    @Override
    public double heuristic(int x, int y, int z) {
        return calculate(level, y);
    }

    /**
     * Optimistic per-block cost of vertical movement: descending is half the 2-block fall time (3.894 per
     * block); ascending is the one-block jump time (3.163 per block, deliberately without the jump penalty).
     */
    public static double calculate(int goalY, int currentY) {
        if (currentY > goalY) {
            return ActionCosts.FALL_N_BLOCKS_COST[2] / 2 * (currentY - goalY);
        }
        if (currentY < goalY) {
            return ActionCosts.JUMP_ONE_BLOCK_COST * (goalY - currentY);
        }
        return 0;
    }

    @Override
    public String toString() {
        return String.format("GoalYLevel{y=%d}", level);
    }
}
