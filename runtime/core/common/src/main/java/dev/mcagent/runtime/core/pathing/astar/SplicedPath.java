package dev.mcagent.runtime.core.pathing.astar;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.Movement;

import net.minecraft.core.BlockPos;

/** Spliced path: two end-to-start segments joined into one so the executor continues across segments. */
public class SplicedPath extends PathBase {

    private final List<BlockPos> path;

    private final List<Movement> movements;

    private final int numNodes;

    private final Goal goal;

    private SplicedPath(List<BlockPos> path, List<Movement> movements, int numNodesConsidered, Goal goal) {
        this.path = path;
        this.movements = movements;
        this.numNodes = numNodesConsidered;
        this.goal = goal;
        sanityCheck();
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
    public int length() {
        return path.size();
    }

    /**
     * Tries to splice first and second into one path. Requires first's end to equal second's start. If any cell
     * of first other than its last also appears in second (the segments overlap) and overlap cutoff is not
     * allowed, splicing fails: the executor's path must join strictly end to start.
     */
    public static Optional<SplicedPath> trySplice(NavPath first, NavPath second, boolean allowOverlapCutoff) {
        if (second == null || first == null) {
            return Optional.empty();
        }
        if (!first.getDest().equals(second.getSrc())) {
            return Optional.empty();
        }
        Set<BlockPos> secondPos = new HashSet<>(second.positions());
        int firstPositionInSecond = -1;
        // The last element coinciding with second's start is the precondition, so only check [0, length-1)
        for (int i = 0; i < first.length() - 1; i++) {
            if (secondPos.contains(first.positions().get(i))) {
                firstPositionInSecond = i;
                break;
            }
        }
        if (firstPositionInSecond != -1) {
            if (!allowOverlapCutoff) {
                return Optional.empty();
            }
        } else {
            firstPositionInSecond = first.length() - 1;
        }
        int positionInSecond = second.positions().indexOf(first.positions().get(firstPositionInSecond));
        if (!allowOverlapCutoff && positionInSecond != 0) {
            throw new IllegalStateException("The two segments to splice overlap in an invalid way");
        }
        List<BlockPos> positions = new ArrayList<>();
        List<Movement> movements = new ArrayList<>();
        positions.addAll(first.positions().subList(0, firstPositionInSecond + 1));
        movements.addAll(first.movements().subList(0, firstPositionInSecond));
        positions.addAll(second.positions().subList(positionInSecond + 1, second.length()));
        movements.addAll(second.movements().subList(positionInSecond, second.length() - 1));
        return Optional.of(new SplicedPath(positions, movements,
                first.getNumNodesConsidered() + second.getNumNodesConsidered(), first.getGoal()));
    }
}
