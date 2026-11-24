package dev.mcagent.runtime.core.pathing.calc;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * The shared worker pool that runs A* searches off the server tick thread.
 * One pool for ALL bots — 100 bots don't spawn 100 threads. Each
 * {@link dev.mcagent.runtime.core.pathing.execute.PlayerNav} submits its search here and polls the returned
 * future each tick.
 *
 * <h2>Sizing: bounded, CPU-friendly</h2>
 * A* is pure CPU work. The pool is a <b>fixed</b> {@link #POOL_SIZE} = {@code max(2, cores - 2)}
 * threads with an <b>unbounded queue</b>: excess searches wait their turn instead of each spawning a
 * thread. This is the standard shape for compute-bound work at scale (Goetz, <i>JCiP</i> §8.2) — it
 * caps CPU threads no matter how many bots submit at once, leaving cores for the (integrated or
 * dedicated) server tick and the client render thread. A cached shape
 * ({@code max=Integer.MAX_VALUE} + {@code SynchronousQueue}) would spawn a new thread per submission and,
 * with many bots, could grow unbounded and starve the game thread. Backlog stays small in
 * practice: a bot holds at most one in-flight search (it polls before re-dispatching), so the
 * queue is bounded by bot count.
 *
 * <p>Workers are <b>daemon</b> (never hold up JVM shutdown) and run at {@link Thread#MIN_PRIORITY} so
 * the OS scheduler prefers the latency-sensitive game / render threads whenever both are runnable —
 * a cheap best-effort assist on top of the hard thread cap. Idle core threads time out
 * ({@link ThreadPoolExecutor#allowCoreThreadTimeOut}) so the pool holds no threads when nothing navigates.
 */
public final class PathPlannerPool {

    private PathPlannerPool() {}

    private static final AtomicInteger COUNTER = new AtomicInteger();

    /** Bounded worker count: leave two cores for the server tick + client render threads. */
    private static final int POOL_SIZE = Math.max(2, Runtime.getRuntime().availableProcessors() - 2);

    private static final ThreadPoolExecutor POOL = createPool();

    private static ThreadPoolExecutor createPool() {
        ThreadPoolExecutor pool = new ThreadPoolExecutor(
                POOL_SIZE, POOL_SIZE, 60L, TimeUnit.SECONDS, new LinkedBlockingQueue<>(),
                runnable -> {
                    Thread thread = new Thread(runnable, "mc_agent-path-" + COUNTER.incrementAndGet());
                    thread.setDaemon(true);
                    thread.setPriority(Thread.MIN_PRIORITY);
                    return thread;
                });
        pool.allowCoreThreadTimeOut(true);
        return pool;
    }

    /** Run {@code task} on the planner pool; the result lands in the returned future. */
    public static <T> CompletableFuture<T> submit(Supplier<T> task) {
        long queuedAt = System.nanoTime();
        return CompletableFuture.supplyAsync(() -> {
            PlannerSearchEvent event = new PlannerSearchEvent();
            event.queueWaitNanos = System.nanoTime() - queuedAt;
            event.queuedSearches = POOL.getQueue().size();
            event.begin();
            try {
                return task.get();
            } finally {
                event.end();
                event.commit();
            }
        }, POOL);
    }

    @jdk.jfr.Name("mcagent.PlannerSearch")
    @jdk.jfr.Label("Runtime planner search")
    @jdk.jfr.Category("EviCraft Runtime")
    @jdk.jfr.StackTrace(false)
    static final class PlannerSearchEvent extends jdk.jfr.Event {
        @jdk.jfr.Timespan(jdk.jfr.Timespan.NANOSECONDS)
        public long queueWaitNanos;
        public int queuedSearches;
    }

    // ==================== Pool snapshots for the profiler (see NavProfiler) ====================

    /** Live thread count (bounded by {@link #POOL_SIZE}; idle threads time out). */
    public static int liveThreads() {
        return POOL.getPoolSize();
    }

    /** Threads currently running a search. */
    public static int activeThreads() {
        return POOL.getActiveCount();
    }

    /** Peak thread count so far (the JDK cannot reset it; shows the worst-case thread growth). */
    public static int peakThreads() {
        return POOL.getLargestPoolSize();
    }

    /** Cumulative completed search tasks (the difference across a window is that window's throughput). */
    public static long completedTasks() {
        return POOL.getCompletedTaskCount();
    }
}
