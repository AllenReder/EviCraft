package dev.mcagent.runtime.core.pathing.astar;

import java.util.Optional;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;

/**
 * Common skeleton for searches that record nodes with back-links by cost: node table, seven-tier bestSoFar
 * partial-path candidates, cooperative cancellation, and the result post-processing pipeline. Instances are
 * single-use.
 *
 * <p>Threading: calculate runs on a worker thread and reads only the frozen {@link CalculationContext}; the
 * cancel flag is volatile and may be set from any thread. {@link #bestPathSoFar()} and
 * {@link #pathToMostRecentNodeConsidered()} let the execution layer peek while the search is running (for
 * the backtrack-pause check); they return approximate snapshots.
 */
public abstract class AbstractNodeCostSearch {

    /**
     * Seven heuristic tightness coefficients. Each tracks the minimum of estimatedCostToGoal + cost/coefficient:
     * smaller coefficients stay closer to the true A* optimum, larger ones push toward the goal more
     * aggressively at the expense of path quality.
     */
    protected static final double[] COEFFICIENTS = {1.5, 2, 2.5, 3, 4, 5, 10};

    /** A partial path must reach at least this many blocks from the start to be worth using. */
    protected static final double MIN_DIST_PATH = 5;

    /**
     * Minimum improvement threshold for relaxation and bestSoFar updates: combinations of diagonal and
     * straight moves on flat ground produce floating-point differences around 1e-16, which are not worth a
     * cost update, heap adjustment or repropagation.
     */
    protected static final double MIN_IMPROVEMENT = 0.01;

    /** The player's real feet position (may differ from the A* start; see the fake-start rule in Path). */
    protected final BlockPos realStart;
    protected final int startX;
    protected final int startY;
    protected final int startZ;

    protected final Goal goal;

    private final CalculationContext context;

    /** Mixed coordinate hash → node, created lazily. */
    private final Long2ObjectOpenHashMap<PathNode> map;

    protected PathNode startNode;

    /** The node most recently popped for consideration (used by the execution layer's backtrack-pause check). */
    protected volatile PathNode mostRecentConsidered;

    /** Best candidate node for each of the seven tiers. */
    protected final PathNode[] bestSoFar = new PathNode[COEFFICIENTS.length];

    private volatile boolean isFinished;

    /** Cooperative cancel flag; the main loop exits on it. */
    protected volatile boolean cancelRequested;

    protected AbstractNodeCostSearch(BlockPos realStart, int startX, int startY, int startZ,
                                     Goal goal, CalculationContext context) {
        this.realStart = realStart;
        this.startX = startX;
        this.startY = startY;
        this.startZ = startZ;
        this.goal = goal;
        this.context = context;
        NavSettings settings = NavSettings.get();
        this.map = new Long2ObjectOpenHashMap<>(settings.pathingMapDefaultSize, settings.pathingMapLoadFactor);
    }

    /** Requests cancellation; the main loop exits cooperatively on its next iteration. */
    public void cancel() {
        cancelRequested = true;
    }

    /**
     * Calculation template: run {@link #calculate0} → postProcess assembly → loaded-chunk cutoff (off by
     * default) → partial-path trimming → classify by whether the end point is in the goal.
     *
     * @param primaryTimeout budget once a usable partial path exists (milliseconds)
     * @param failureTimeout budget used in full while there is no usable result at all (milliseconds)
     */
    public synchronized PathCalcResult calculate(long primaryTimeout, long failureTimeout) {
        if (isFinished) {
            throw new IllegalStateException("Searcher is single-use and cannot be reused");
        }
        cancelRequested = false;
        long tSearch = dev.mcagent.runtime.core.pathing.util.NavProfiler.begin();
        try {
            NavPath path = calculate0(primaryTimeout, failureTimeout)
                    .map(NavPath::postProcess).orElse(null);
            if (cancelRequested) {
                return new PathCalcResult(PathCalcResult.Type.CANCELLATION);
            }
            if (path == null) {
                return new PathCalcResult(PathCalcResult.Type.FAILURE);
            }
            path = path.cutoffAtLoadedChunks(context.loadedTest);
            path = path.staticCutoff(goal);
            BlockPos dest = path.getDest();
            if (goal.isInGoal(dest.getX(), dest.getY(), dest.getZ())) {
                return new PathCalcResult(PathCalcResult.Type.SUCCESS_TO_GOAL, path);
            }
            return new PathCalcResult(PathCalcResult.Type.SUCCESS_SEGMENT, path);
        } catch (Exception e) {
            Constants.LOG.error("Path calculation failed with an exception", e);
            return new PathCalcResult(PathCalcResult.Type.EXCEPTION);
        } finally {
            // Seal this instance whether or not calculate0 threw
            isFinished = true;
            dev.mcagent.runtime.core.pathing.util.NavProfiler.recordSearch(tSearch);
        }
    }

    protected abstract Optional<NavPath> calculate0(long primaryTimeout, long failureTimeout);

    /** Squared distance from the node to the start (for comparison only, no square root). */
    protected double getDistFromStartSq(PathNode n) {
        int xDiff = n.x - startX;
        int yDiff = n.y - startY;
        int zDiff = n.z - startZ;
        return xDiff * xDiff + yDiff * yDiff + zDiff * zDiff;
    }

    /**
     * Looks up a node by hash, creating and inserting it if absent (the heuristic is computed at construction;
     * NaN throws).
     *
     * @param hashCode provided by {@link PathNode#longHash(int, int, int)}
     */
    protected PathNode getNodeAtPosition(int x, int y, int z, long hashCode) {
        PathNode node = map.get(hashCode);
        if (node == null) {
            node = new PathNode(x, y, z, goal);
            map.put(hashCode, node);
        }
        return node;
    }

    /** Path to the most recently considered node (for rendering/diagnostics). */
    public Optional<NavPath> pathToMostRecentNodeConsidered() {
        PathNode node = mostRecentConsidered;
        if (node == null || startNode == null) {
            return Optional.empty();
        }
        return Optional.of(new Path(realStart, startNode, node, 0, goal, context));
    }

    /** Current best partial path (used by the execution layer's backtrack-pause check). */
    public Optional<NavPath> bestPathSoFar() {
        return bestSoFar(false, 0);
    }

    /**
     * Seven-tier selection: going from the tightest coefficient to the loosest, build a path from the first
     * non-null tier that is more than {@link #MIN_DIST_PATH} blocks from the start. If no tier is far enough
     * there is genuinely no way forward, and the result is empty.
     */
    protected Optional<NavPath> bestSoFar(boolean logInfo, int numNodes) {
        if (startNode == null) {
            return Optional.empty();
        }
        double bestDist = 0;
        for (int i = 0; i < COEFFICIENTS.length; i++) {
            if (bestSoFar[i] == null) {
                continue;
            }
            double dist = getDistFromStartSq(bestSoFar[i]);
            if (dist > bestDist) {
                bestDist = dist;
            }
            if (dist > MIN_DIST_PATH * MIN_DIST_PATH) { // squared distance vs squared threshold
                if (logInfo && COEFFICIENTS[i] >= 3) {
                    Constants.LOG.debug("bestSoFar uses coefficient {}, path quality may be poor", COEFFICIENTS[i]);
                }
                return Optional.of(new Path(realStart, startNode, bestSoFar[i], numNodes, goal, context));
            }
        }
        if (logInfo) {
            Constants.LOG.debug("Even the loosest tier only reached {} blocks, no path", Math.sqrt(bestDist));
        }
        return Optional.empty();
    }

    public final boolean isFinished() {
        return isFinished;
    }

    public final Goal getGoal() {
        return goal;
    }

    /** The start used for A* expansion (may differ from realStart). */
    public BlockPos getStart() {
        return new BlockPos(startX, startY, startZ);
    }

    protected int mapSize() {
        return map.size();
    }
}
