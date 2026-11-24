package dev.mcagent.runtime.core.pathing.astar;

import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.ActionCosts;

/**
 * Search node: coordinates, heuristic to the goal (computed once at construction and cached), actual cost
 * from the start and the sum of the two, plus the back-link and heap position.
 */
public final class PathNode {

    public final int x;
    public final int y;
    public final int z;

    /** Cached goal.heuristic(x,y,z); NaN is treated as a bug in the goal implementation and throws. */
    public final double estimatedCostToGoal;

    /** Actual cost from the start; initially INF and updated by relaxation in the search loop. */
    public double cost;

    /** Always cost + estimatedCostToGoal; the heap orders by it. */
    public double combinedCost;

    /** The predecessor whose relaxation produced this node's cost. */
    public PathNode previous;

    /** Index in the binary heap array; -1 means not in the open set (used by decrease-key). */
    public int heapPosition;

    public PathNode(int x, int y, int z, Goal goal) {
        this.previous = null;
        this.cost = ActionCosts.COST_INF;
        this.estimatedCostToGoal = goal.heuristic(x, y, z);
        if (Double.isNaN(estimatedCostToGoal)) {
            throw new IllegalStateException(
                    goal + " computed a NaN heuristic at (" + x + "," + y + "," + z + ")");
        }
        this.heapPosition = -1;
        this.x = x;
        this.y = y;
        this.z = z;
    }

    public boolean isOpen() {
        return heapPosition != -1;
    }

    /** Mixed coordinate hash (same source as the node table's long keys). */
    public static long longHash(int x, int y, int z) {
        long hash = 3241;
        hash = 3457689L * hash + x;
        hash = 8734625L * hash + y;
        hash = 2873465L * hash + z;
        return hash;
    }

    @Override
    public int hashCode() {
        return (int) longHash(x, y, z);
    }

    @Override
    public boolean equals(Object obj) {
        // Hot path: only ever compared with other PathNodes, so the type check is skipped
        final PathNode other = (PathNode) obj;
        return x == other.x && y == other.y && z == other.z;
    }
}
