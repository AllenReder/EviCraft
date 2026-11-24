package dev.mcagent.runtime.core.pathing.astar;

import java.util.Optional;

import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Moves;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;
import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.border.WorldBorder;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;

/**
 * A* main loop: generates edges from the 22 move primitives, applies the favoring discount to action costs,
 * relaxes with a minimum-improvement threshold, counts chunk-border hits, and enforces a two-tier wall-clock
 * timeout.
 */
public final class AStarPathFinder extends AbstractNodeCostSearch {

    private final Favoring favoring;
    private final CalculationContext calcContext;

    /** World border snapshot (sampled at construction, read-only on the worker thread). */
    private final double borderMinX;
    private final double borderMaxX;
    private final double borderMinZ;
    private final double borderMaxZ;

    public AStarPathFinder(BlockPos realStart, int startX, int startY, int startZ,
                           Goal goal, Favoring favoring, CalculationContext context) {
        super(realStart, startX, startY, startZ, goal, context);
        this.favoring = favoring;
        this.calcContext = context;
        WorldBorder border = context.player.level().getWorldBorder();
        this.borderMinX = border.getMinX();
        this.borderMaxX = border.getMaxX();
        this.borderMinZ = border.getMinZ();
        this.borderMaxZ = border.getMaxZ();
    }

    /** Whether the whole (x,z) cell lies inside the world border. */
    private boolean borderEntirelyContains(int x, int z) {
        return x + 1 > borderMinX && x < borderMaxX && z + 1 > borderMinZ && z < borderMaxZ;
    }

    @Override
    protected Optional<NavPath> calculate0(long primaryTimeout, long failureTimeout) {
        startNode = getNodeAtPosition(startX, startY, startZ, PathNode.longHash(startX, startY, startZ));
        startNode.cost = 0;
        startNode.combinedCost = startNode.estimatedCostToGoal;
        BinaryHeapOpenSet openSet = new BinaryHeapOpenSet();
        openSet.insert(startNode);
        // Each of the seven tiers tracks the minimum of estimatedCostToGoal + cost/COEFFICIENTS[i]
        double[] bestHeuristicSoFar = new double[COEFFICIENTS.length];
        for (int i = 0; i < bestHeuristicSoFar.length; i++) {
            bestHeuristicSoFar[i] = startNode.estimatedCostToGoal;
            bestSoFar[i] = startNode;
        }
        MutableMoveResult res = new MutableMoveResult();
        long startTime = System.currentTimeMillis();
        long primaryTimeoutTime = startTime + primaryTimeout;
        long failureTimeoutTime = startTime + failureTimeout;
        // failing: no usable partial path more than 5 blocks from the start yet. Until one is found the
        // search may use the full failureTimeout; afterwards it runs only until primaryTimeout.
        boolean failing = true;
        int numNodes = 0;
        int numEmptyChunk = 0;
        boolean isFavoring = !favoring.isEmpty();
        int timeCheckInterval = 1 << 6;
        // Sample all settings before the loop so changing them mid-search does not affect this search
        int pathingMaxChunkBorderFetch = NavSettings.get().pathingMaxChunkBorderFetch;
        double minimumImprovement = NavSettings.get().minimumImprovementRepropagation ? MIN_IMPROVEMENT : 0;
        // Hard node cap: a loop exit alongside the time budget, whichever comes first. Hitting it falls
        // through to bestSoFar(...) below, exactly like a timeout (SEGMENT if a usable partial exists,
        // otherwise FAILURE). See NavSettings#maxNodesPerSearch.
        int maxNodes = NavSettings.get().maxNodesPerSearch;
        Moves[] allMoves = Moves.values();
        PathNode bestGoal = null;
        while (!openSet.isEmpty() && numNodes < maxNodes && numEmptyChunk < pathingMaxChunkBorderFetch && !cancelRequested) {
            if ((numNodes & (timeCheckInterval - 1)) == 0) { // check the wall clock every 64 nodes (about 0.5 ms)
                long now = System.currentTimeMillis();
                if (now - failureTimeoutTime >= 0 || (!failing && now - primaryTimeoutTime >= 0)) {
                    break;
                }
            }
            PathNode currentNode = openSet.removeLowest();
            mostRecentConsidered = currentNode;
            numNodes++;
            if (bestGoal != null && currentNode.combinedCost - bestGoal.cost > MIN_IMPROVEMENT) {
                return Optional.of(new Path(realStart, startNode, bestGoal, numNodes, goal, calcContext));
            }
            if (goal.isInGoal(currentNode.x, currentNode.y, currentNode.z)) {
                if (!goal.ordersEqualCostGoals()) {
                    return Optional.of(new Path(realStart, startNode, currentNode, numNodes, goal, calcContext));
                }
                if (bestGoal == null
                        || currentNode.cost < bestGoal.cost - MIN_IMPROVEMENT
                        || (Math.abs(currentNode.cost - bestGoal.cost) <= MIN_IMPROVEMENT
                        && goal.compareEqualCostGoals(
                        new BlockPos(currentNode.x, currentNode.y, currentNode.z),
                        new BlockPos(bestGoal.x, bestGoal.y, bestGoal.z)) < 0)) {
                    bestGoal = currentNode;
                }
                continue;
            }
            for (Moves moves : allMoves) {
                int newX = currentNode.x + moves.xOffset;
                int newZ = currentNode.z + moves.zOffset;
                if ((newX >> 4 != currentNode.x >> 4 || newZ >> 4 != currentNode.z >> 4)
                        && !calcContext.isLoaded(newX, newZ)) {
                    // Crosses into an unloaded chunk: skip. Not counted for dynamicXZ moves, whose
                    // landing cell may not actually be there.
                    if (!moves.dynamicXZ) {
                        numEmptyChunk++;
                    }
                    continue;
                }
                if (!moves.dynamicXZ && !borderEntirelyContains(newX, newZ)) {
                    continue;
                }
                if (currentNode.y + moves.yOffset > calcContext.worldHeight
                        || currentNode.y + moves.yOffset < calcContext.worldBottom) {
                    continue;
                }
                res.reset();
                moves.apply(calcContext, currentNode.x, currentNode.y, currentNode.z, res);
                double actionCost = res.cost;
                if (actionCost >= COST_INF) {
                    continue;
                }
                if (actionCost <= 0 || Double.isNaN(actionCost)) {
                    throw new IllegalStateException(String.format(
                            "%s computed an invalid cost from (%d,%d,%d): %s",
                            moves, currentNode.x, currentNode.y, currentNode.z, actionCost));
                }
                // A dynamic landing cell can only be checked once the cost is valid (unset when INF)
                if (moves.dynamicXZ && !borderEntirelyContains(res.x, res.z)) {
                    continue;
                }
                if (!moves.dynamicXZ && (res.x != newX || res.z != newZ)) {
                    throw new IllegalStateException(String.format(
                            "%s from (%d,%d,%d) landed at (%d,·,%d) instead of (%d,·,%d)",
                            moves, currentNode.x, currentNode.y, currentNode.z, res.x, res.z, newX, newZ));
                }
                if (!moves.dynamicY && res.y != currentNode.y + moves.yOffset) {
                    throw new IllegalStateException(String.format(
                            "%s from (%d,%d,%d) landed at y=%d instead of y=%d",
                            moves, currentNode.x, currentNode.y, currentNode.z, res.y,
                            currentNode.y + moves.yOffset));
                }
                long hashCode = PathNode.longHash(res.x, res.y, res.z);
                if (isFavoring) {
                    // The discount multiplies the action cost, keyed by the destination cell hash
                    actionCost *= favoring.calculate(hashCode);
                }
                PathNode neighbor = getNodeAtPosition(res.x, res.y, res.z, hashCode);
                double tentativeCost = currentNode.cost + actionCost;
                if (neighbor.cost - tentativeCost > minimumImprovement) {
                    neighbor.previous = currentNode;
                    neighbor.cost = tentativeCost;
                    neighbor.combinedCost = tentativeCost + neighbor.estimatedCostToGoal;
                    if (neighbor.isOpen()) {
                        openSet.update(neighbor);
                    } else {
                        openSet.insert(neighbor);
                    }
                    for (int i = 0; i < COEFFICIENTS.length; i++) {
                        double heuristic = neighbor.estimatedCostToGoal + neighbor.cost / COEFFICIENTS[i];
                        if (bestHeuristicSoFar[i] - heuristic > minimumImprovement) {
                            bestHeuristicSoFar[i] = heuristic;
                            bestSoFar[i] = neighbor;
                            if (failing && getDistFromStartSq(neighbor) > MIN_DIST_PATH * MIN_DIST_PATH) {
                                failing = false;
                            }
                        }
                    }
                }
            }
        }
        if (cancelRequested) {
            return Optional.empty();
        }
        if (bestGoal != null) {
            return Optional.of(new Path(realStart, startNode, bestGoal, numNodes, goal, calcContext));
        }
        if (NavSettings.get().profile) {
            // Why did the loop stop? nodeCap = hit maxNodesPerSearch (gave up early — cap may be too low
            // for this terrain); exhausted = openSet emptied (genuinely no reachable path); timeout = time
            // budget; chunkBorder = ran into unloaded chunks. failing=true means no usable partial found
            // (this returns a FAILURE); failing=false means a best partial segment is returned.
            String reason = numNodes >= maxNodes ? "nodeCap"
                    : numEmptyChunk >= pathingMaxChunkBorderFetch ? "chunkBorder"
                    : openSet.isEmpty() ? "exhausted"
                    : "timeout";
            Constants.LOG.info("[nav-search] stop reason={} nodes={}/{} failing={} goal={}",
                    reason, numNodes, maxNodes, failing, goal);
        }
        return bestSoFar(true, numNodes);
    }
}
