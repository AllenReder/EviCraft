package dev.mcagent.runtime.core.pathing.astar;

import java.util.Collections;
import java.util.List;

import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.Movement;

import net.minecraft.core.BlockPos;

/** Truncated path: a copy of an index range of the original path (used to drop a poor-quality tail). */
public class CutoffPath extends PathBase {

    private final List<BlockPos> path;

    private final List<Movement> movements;

    private final int numNodes;

    private final Goal goal;
    private final boolean speculativeFrontier;

    /**
     * Takes the positions in the closed range [firstPositionToInclude, lastPositionToInclude] and the moves
     * between them.
     */
    public CutoffPath(NavPath prev, int firstPositionToInclude, int lastPositionToInclude) {
        path = List.copyOf(prev.positions().subList(firstPositionToInclude, lastPositionToInclude + 1));
        movements = List.copyOf(prev.movements().subList(firstPositionToInclude, lastPositionToInclude));
        numNodes = prev.getNumNodesConsidered();
        goal = prev.getGoal();
        speculativeFrontier = prev.speculativeFrontier();
        sanityCheck();
    }

    /** Truncates from the start through lastPositionToInclude (inclusive). */
    public CutoffPath(NavPath prev, int lastPositionToInclude) {
        this(prev, 0, lastPositionToInclude);
    }

    @Override
    public Goal getGoal() {
        return goal;
    }

    @Override
    public List<Movement> movements() {
        return Collections.unmodifiableList(movements);
    }

    @Override
    public List<BlockPos> positions() {
        return Collections.unmodifiableList(path);
    }

    @Override
    public int getNumNodesConsidered() {
        return numNodes;
    }

    @Override
    public boolean speculativeFrontier() {
        return speculativeFrontier;
    }
}
