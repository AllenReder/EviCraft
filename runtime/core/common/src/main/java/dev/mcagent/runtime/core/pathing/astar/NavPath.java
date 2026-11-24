package dev.mcagent.runtime.core.pathing.astar;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.ChunkLoadedTest;
import dev.mcagent.runtime.core.pathing.moves.Movement;

import net.minecraft.core.BlockPos;

/**
 * Read-only contract of an executable path. Invariants:
 * movements().get(i).getSrc() == positions().get(i),
 * movements().get(i).getDest() == positions().get(i+1),
 * so there is always one fewer movement than positions.
 */
public interface NavPath {

    /** Move primitives, in execution order. */
    List<Movement> movements();

    /** All cells along the path; the first element is the start and the last is the end. */
    List<BlockPos> positions();

    /**
     * One-time post-processing before execution (assembling move primitives, pinning reference costs, etc.).
     * Only a {@link Path} produced directly by the search supports it.
     */
    default NavPath postProcess() {
        throw new UnsupportedOperationException();
    }

    /** Number of cells in the path, equal to positions().size(). */
    default int length() {
        return positions().size();
    }

    /** True when execution was intentionally cut before an UNKNOWN dependency. */
    default boolean speculativeFrontier() {
        return false;
    }

    /** The goal this path was computed toward. */
    Goal getGoal();

    /** Number of nodes the search considered before finding this path. */
    int getNumNodesConsidered();

    default BlockPos getSrc() {
        return positions().get(0);
    }

    default BlockPos getDest() {
        List<BlockPos> pos = positions();
        return pos.get(pos.size() - 1);
    }

    /**
     * Estimated ticks to finish the rest of the path from index pathPosition. Reads cached costs only and
     * does not trigger recalculation.
     */
    default double ticksRemainingFrom(int pathPosition) {
        double sum = 0;
        List<Movement> movements = movements();
        for (int i = pathPosition; i < movements.size(); i++) {
            sum += movements.get(i).getCost();
        }
        return sum;
    }

    /** Truncates at the loaded-chunk boundary (switch off by default); unsupported by default. */
    default NavPath cutoffAtLoadedChunks(ChunkLoadedTest loadedTest) {
        throw new UnsupportedOperationException();
    }

    /** Trims the tail of a partial path (poor-quality segment end); unsupported by default. */
    default NavPath staticCutoff(Goal destination) {
        throw new UnsupportedOperationException();
    }

    /**
     * Assembly integrity check: start and end match, positions and movements have the right length relation,
     * each movement joins its neighboring cells, and the path has no cycles. Throws on any violation.
     */
    default void sanityCheck() {
        List<BlockPos> path = positions();
        List<Movement> movements = movements();
        if (!getSrc().equals(path.get(0))) {
            throw new IllegalStateException("Start does not match the first position");
        }
        if (!getDest().equals(path.get(path.size() - 1))) {
            throw new IllegalStateException("End does not match the last position");
        }
        if (path.size() != movements.size() + 1) {
            throw new IllegalStateException(
                    "Position count (" + path.size() + ") and movement count (" + movements.size() + ") lengths are inconsistent");
        }
        Set<BlockPos> seenSoFar = new HashSet<>();
        for (int i = 0; i < path.size() - 1; i++) {
            BlockPos src = path.get(i);
            BlockPos dest = path.get(i + 1);
            Movement movement = movements.get(i);
            if (!src.equals(movement.getSrc())) {
                throw new IllegalStateException("Movement " + i + " src does not match its position");
            }
            if (!dest.equals(movement.getDest())) {
                throw new IllegalStateException("Movement " + i + " dest does not match its position");
            }
            if (seenSoFar.contains(src)) {
                throw new IllegalStateException("Path has a cycle: revisits " + src);
            }
            seenSoFar.add(src);
        }
    }
}
