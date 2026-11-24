package dev.mcagent.runtime.core.pathing.astar;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.Moves;

import net.minecraft.core.BlockPos;

/**
 * Path produced directly by the search: follow previous links back from the end node and reverse them to get
 * the position sequence. postProcess assembles the move primitives between adjacent cells once and pins the
 * reference costs used during execution.
 */
public class Path extends PathBase {

    private final BlockPos start;
    private final BlockPos end;

    /** Cells along the path; the first element always equals start and the last always equals end. */
    private final List<BlockPos> path;

    private final List<Movement> movements;

    private final List<PathNode> nodes;

    private final Goal goal;

    private final int numNodes;

    private final CalculationContext context;

    /** Whether postProcess has run (allowed once; movements are readable only afterwards). */
    private volatile boolean verified;
    private boolean speculativeFrontier;

    /**
     * @param realStart the player's real feet position. When it differs from the A* start and the path
     *                  degenerates to a single node, a fake start with cost=0 is inserted so one move can
     *                  still be assembled.
     */
    Path(BlockPos realStart, PathNode start, PathNode end, int numNodes,
         Goal goal, CalculationContext context) {
        this.end = new BlockPos(end.x, end.y, end.z);
        this.numNodes = numNodes;
        this.movements = new ArrayList<>();
        this.goal = goal;
        this.context = context;

        PathNode current = end;
        List<BlockPos> tempPath = new ArrayList<>();
        List<PathNode> tempNodes = new ArrayList<>();
        while (current != null) {
            tempNodes.add(current);
            tempPath.add(new BlockPos(current.x, current.y, current.z));
            current = current.previous;
        }

        // When the start differs from the real feet position and the path is degenerate (start==end, no
        // edges), add a fake start. Back-links run end to start, so appending it here makes it the first
        // cell after reversal.
        BlockPos startNodePos = new BlockPos(start.x, start.y, start.z);
        if (!realStart.equals(startNodePos) && start.equals(end)) {
            this.start = realStart;
            PathNode fakeNode = new PathNode(realStart.getX(), realStart.getY(), realStart.getZ(), goal);
            fakeNode.cost = 0;
            tempNodes.add(fakeNode);
            tempPath.add(realStart);
        } else {
            this.start = startNodePos;
        }

        // Back-links are in end-to-start order; reverse them into execution order
        Collections.reverse(tempPath);
        Collections.reverse(tempNodes);
        this.path = tempPath;
        this.nodes = tempNodes;
    }

    @Override
    public Goal getGoal() {
        return goal;
    }

    /**
     * Assembles a move primitive for each pair of adjacent cells.
     *
     * @return true if assembly stopped early (some pair no longer has a feasible move because the world changed
     *         during the calculation)
     */
    private boolean assembleMovements() {
        if (path.isEmpty() || !movements.isEmpty()) {
            throw new IllegalStateException("Path is empty or already assembled");
        }
        for (int i = 0; i < path.size() - 1; i++) {
            double cost = nodes.get(i + 1).cost - nodes.get(i).cost;
            Movement move = runBackwards(path.get(i), path.get(i + 1), cost);
            if (move == null) {
                return true;
            }
            movements.add(move);
        }
        return false;
    }

    /**
     * Enumerates all move primitives and finds the one that goes from src to exactly dest. The cost is pinned
     * to the smaller of the cost recomputed at assembly and the node cost difference: the node difference may
     * carry a favoring discount, and the recomputed cost may have risen because the world changed. The stricter
     * value is the baseline for cost-increase checks during execution.
     */
    private Movement runBackwards(BlockPos src, BlockPos dest, double cost) {
        for (Moves moves : Moves.values()) {
            dev.mcagent.runtime.core.pathing.cache.SpeculativeWorldView speculative =
                    context.view instanceof dev.mcagent.runtime.core.pathing.cache.SpeculativeWorldView view
                            ? view : null;
            if (speculative != null) speculative.beginDependencyCapture();
            Movement move = moves.apply0(context, src);
            if (move != null && move.getDest().equals(dest)) {
                move.override(Math.min(move.getCost(context), cost));
                if (speculative != null && speculative.dependencyWasUnknown()) {
                    speculativeFrontier = true;
                    return null;
                }
                return move;
            }
        }
        Constants.LOG.debug("Movement no longer possible during assembly {} -> {}", src, dest);
        return null;
    }

    @Override
    public NavPath postProcess() {
        if (verified) {
            throw new IllegalStateException("Path cannot be postProcessed twice");
        }
        verified = true;
        boolean failed = assembleMovements();
        movements.forEach(m -> m.checkLoadedChunk(context));

        if (failed) {
            // At least one move became infeasible during the calculation: truncate to the assembled part
            CutoffPath res = new CutoffPath(this, movements().size());
            if (res.movements().size() != movements.size()) {
                throw new IllegalStateException("Length mismatch after truncation");
            }
            return res;
        }
        sanityCheck();
        return this;
    }

    @Override
    public List<Movement> movements() {
        if (!verified) {
            throw new IllegalStateException("Path has not been postProcessed yet");
        }
        return Collections.unmodifiableList(movements);
    }

    @Override
    public List<BlockPos> positions() {
        return Collections.unmodifiableList(path);
    }

    @Override
    public boolean speculativeFrontier() {
        return speculativeFrontier;
    }

    @Override
    public int getNumNodesConsidered() {
        return numNodes;
    }

    @Override
    public BlockPos getSrc() {
        return start;
    }

    @Override
    public BlockPos getDest() {
        return end;
    }
}
