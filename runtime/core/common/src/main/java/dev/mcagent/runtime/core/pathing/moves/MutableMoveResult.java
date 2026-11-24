package dev.mcagent.runtime.core.pathing.moves;

/**
 * Mutable result of one movement cost calculation: destination coordinates and cost.
 * The search loop reuses one instance to avoid an allocation per edge.
 */
public final class MutableMoveResult {

    public int x;
    public int y;
    public int z;
    public double cost;
    public boolean requiresWaterBucket;

    public MutableMoveResult() {
        reset();
    }

    /** Reset to "infeasible": zero the coordinates and set the cost to INF. */
    public void reset() {
        x = 0;
        y = 0;
        z = 0;
        cost = ActionCosts.COST_INF;
        requiresWaterBucket = false;
    }
}
