package dev.mcagent.runtime.core.pathing.bridge;

import java.util.Optional;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;

import dev.mcagent.runtime.core.pathing.astar.AStarPathFinder;
import dev.mcagent.runtime.core.pathing.astar.Favoring;
import dev.mcagent.runtime.core.pathing.astar.NavPath;
import dev.mcagent.runtime.core.pathing.astar.PathCalcResult;
import dev.mcagent.runtime.core.pathing.calc.PathPlannerPool;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;

import net.minecraft.core.BlockPos;

/**
 * Shared-pool implementation of {@link SearchDispatcher}: the search is constructed on the submitting (tick)
 * thread (the four world-border doubles are sampled at construction), and the whole {@code calculate} runs
 * on a {@link PathPlannerPool} worker. The handle polls the future; cancelling sets both the search's
 * cooperative cancel flag and cancels the future.
 *
 * <p>When the context is not frozen ({@code safeForThreadedUse=false}, the no-snapshot fallback) the pool is
 * not used: the search runs synchronously on the submitting thread and the handle is complete on return.
 */
public final class PoolSearchDispatcher implements SearchDispatcher {

    /** Stateless, so a shared singleton suffices. */
    public static final PoolSearchDispatcher INSTANCE = new PoolSearchDispatcher();

    public PoolSearchDispatcher() {}

    @Override
    public SearchHandle submit(BlockPos realStart, BlockPos start, Goal goal,
                               CalculationContext context, Favoring favoring,
                               long primaryMs, long failureMs) {
        AStarPathFinder finder = new AStarPathFinder(
                realStart, start.getX(), start.getY(), start.getZ(), goal, favoring, context);
        if (!context.safeForThreadedUse) {
            // A live-world context may only be read on this (main) thread: compute in place and return a
            // completed handle
            return new PoolHandle(finder,
                    CompletableFuture.completedFuture(finder.calculate(primaryMs, failureMs)));
        }
        CompletableFuture<PathCalcResult> future =
                PathPlannerPool.submit(() -> finder.calculate(primaryMs, failureMs));
        return new PoolHandle(finder, future);
    }

    /** Handle combining the future and the search. */
    private static final class PoolHandle implements SearchHandle {

        private final AStarPathFinder finder;
        private final CompletableFuture<PathCalcResult> future;
        /** Result pinned on the first poll that consumes it (returned idempotently). */
        private PathCalcResult settled;

        PoolHandle(AStarPathFinder finder, CompletableFuture<PathCalcResult> future) {
            this.finder = finder;
            this.future = future;
        }

        @Override
        public PathCalcResult poll() {
            if (settled != null) {
                return settled;
            }
            if (!future.isDone()) {
                return null;
            }
            try {
                settled = future.join();
            } catch (CancellationException cancelled) {
                settled = new PathCalcResult(PathCalcResult.Type.CANCELLATION);
            } catch (RuntimeException e) {
                // calculate already catches its own exceptions; this only covers the future's execution
                settled = new PathCalcResult(PathCalcResult.Type.EXCEPTION);
            }
            return settled;
        }

        @Override
        public boolean isDone() {
            return settled != null || future.isDone();
        }

        @Override
        public void cancel() {
            finder.cancel();
            future.cancel(false);
        }

        @Override
        public Optional<NavPath> bestPathSoFar() {
            return finder.bestPathSoFar();
        }

        @Override
        public Optional<NavPath> mostRecentConsidered() {
            return finder.pathToMostRecentNodeConsidered();
        }
    }
}
