package dev.mcagent.runtime.core.pathing.bridge;

import java.util.Optional;

import dev.mcagent.runtime.core.pathing.astar.NavPath;
import dev.mcagent.runtime.core.pathing.astar.PathCalcResult;

/**
 * Polling handle for one in-flight search. The tick thread calls {@link #poll} every tick to consume the
 * result; while the search runs, {@link #bestPathSoFar}/{@link #mostRecentConsidered} give approximate
 * progress (the worker writes nodes concurrently, so reads are approximate snapshots).
 */
public interface SearchHandle {

    /**
     * Returns null until done; afterwards returns the final result, and every later call returns the same
     * object (idempotent, so the tick poller need not remember that it consumed it).
     */
    PathCalcResult poll();

    /** Whether the calculation has a result (same as {@code poll() != null}). */
    boolean isDone();

    /** Cooperative cancel: sets the search's cancel flag and cancels the future; result becomes CANCELLATION. */
    void cancel();

    /** Current best partial path while running (used by the execution layer's backtrack-pause check). */
    Optional<NavPath> bestPathSoFar();

    /** Path to the most recently popped node (for rendering/diagnostics). */
    Optional<NavPath> mostRecentConsidered();
}
