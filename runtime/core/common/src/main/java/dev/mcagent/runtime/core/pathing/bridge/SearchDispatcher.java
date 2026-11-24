package dev.mcagent.runtime.core.pathing.bridge;

import dev.mcagent.runtime.core.pathing.astar.Favoring;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;

import net.minecraft.core.BlockPos;

/**
 * Async search dispatch: the tick thread submits a search and polls the returned {@link SearchHandle} every
 * tick. Implementations handle threading (see {@link PoolSearchDispatcher}); callers consume results and
 * cancel on the tick thread.
 */
public interface SearchDispatcher {

    /**
     * Submits a search. Must be called on the tick thread (the search samples the world border at
     * construction, and frozen contexts are built on the main thread by convention).
     *
     * @param realStart the player's real feet position (used by path assembly to add a fake start when it
     *                  differs from the A* start and the path degenerates to a single node)
     * @param start     A* expansion start
     * @param goal      engine goal (task-layer vocabulary mapped through {@link GoalAdapter})
     * @param context   frozen context ({@link ContextFactory#forSearch}); for a non-frozen context the
     *                  implementation must run synchronously on the calling thread
     * @param favoring  cost discount table from the previous path ({@link Favoring#empty()} if none)
     * @param primaryMs budget once a usable partial path exists (milliseconds)
     * @param failureMs budget used in full while there is no usable result at all (milliseconds)
     */
    SearchHandle submit(BlockPos realStart, BlockPos start, Goal goal,
                        CalculationContext context, Favoring favoring,
                        long primaryMs, long failureMs);

    /** Common form where the start is the real feet position. */
    default SearchHandle submit(BlockPos start, Goal goal, CalculationContext context,
                                Favoring favoring, long primaryMs, long failureMs) {
        return submit(start, start, goal, context, favoring, primaryMs, failureMs);
    }
}
