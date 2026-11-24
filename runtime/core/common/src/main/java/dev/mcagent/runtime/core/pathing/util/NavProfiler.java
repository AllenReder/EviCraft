package dev.mcagent.runtime.core.pathing.util;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.pathing.calc.PathPlannerPool;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Lightweight pathing profiler for finding out whether server lag comes from pathing work on the main thread.
 *
 * <p>Records only when {@link NavSettings#profile} is on; when off, {@link #begin()} returns 0 and every
 * record point is near zero cost. The execution chain ({@code PlayerNav.tick} -> {@code PathingCore.tick} ->
 * {@code PathExecutor.onTick}) runs single-threaded on the server main thread, so the static state here
 * needs no locking.
 *
 * <p>Every ~5 s window, per-phase {count / total time / peak} plus the concurrent navigation count are
 * aggregated into one INFO line. Total time as a share of the window shows how much main-thread time pathing
 * uses; the peak catches single-tick stalls. Toggle at runtime with {@code NavSettings.get().profile = true}
 * (default false).
 */
public final class NavProfiler {

    private NavProfiler() {}

    private static final long WINDOW_MS = 5_000L;

    private static long windowStartMs = 0L;
    /** Total PlayerNav.tick() calls in this window (about concurrent navigations x elapsed ticks). */
    private static long navTicks = 0L;
    /** Phase name -> [count, totalNanos, maxNanos]. Main thread only, so no locking. */
    private static final Map<String, long[]> phases = new LinkedHashMap<>();

    // Background A* searches record on pool threads, hence atomics; the main thread resets them with
    // getAndSet on flush.
    private static final AtomicLong searchCount = new AtomicLong();
    private static final AtomicLong searchTotalNanos = new AtomicLong();
    private static final AtomicLong searchMaxNanos = new AtomicLong();
    /** Cumulative completed-task count at the end of the previous window, for window throughput. */
    private static long lastCompletedTasks = 0L;
    /** JVM cumulative GC count / pause ms at the end of the previous window, for this window's GC. */
    private static long lastGcCount = 0L;
    private static long lastGcTimeMs = 0L;

    /** Timing start; returns 0 when profiling is off, which makes {@link #end} a no-op. */
    public static long begin() {
        return NavSettings.get().profile ? System.nanoTime() : 0L;
    }

    /** Record one phase's elapsed time. No-op when {@code start == 0} (profiling off). */
    public static void end(String phase, long start) {
        if (start == 0L) {
            return;
        }
        long elapsed = System.nanoTime() - start;
        long[] a = phases.get(phase);
        if (a == null) {
            a = new long[3];
            phases.put(phase, a);
        }
        a[0]++;
        a[1] += elapsed;
        if (elapsed > a[2]) {
            a[2] = elapsed;
        }
    }

    /**
     * Record one background A* search's elapsed time (called on pool threads, thread-safe).
     * No-op when {@code start == 0}.
     */
    public static void recordSearch(long start) {
        if (start == 0L) {
            return;
        }
        long elapsed = System.nanoTime() - start;
        searchCount.incrementAndGet();
        searchTotalNanos.addAndGet(elapsed);
        long prev;
        do {
            prev = searchMaxNanos.get();
        } while (elapsed > prev && !searchMaxNanos.compareAndSet(prev, elapsed));
    }

    // Server tick-gap pulse: an active task pulses once per tick, so the gap between pulses is about the wall
    // time of one full server tick. It catches main-thread spikes outside the profiled phases (lighting,
    // block updates, untimed task work) and separates server lag from client lag: if gaps stay ~50 ms while
    // the picture still stutters, the cause is on the client.
    private static long lastPulseMs = 0L;
    private static long pulseGapMax = 0L;
    private static long pulseOver60 = 0L;
    private static long pulseOver100 = 0L;

    /**
     * Called once per tick by an active task; no-op when profiling is off. Gaps over 2 s are task idle time
     * and are not counted.
     */
    public static void serverTickPulse() {
        if (!NavSettings.get().profile) {
            return;
        }
        serverThread = Thread.currentThread();
        ensureSampler();
        long now = System.currentTimeMillis();
        if (lastPulseMs != 0L) {
            long gap = now - lastPulseMs;
            if (gap < 2000L) {
                if (gap > pulseGapMax) {
                    pulseGapMax = gap;
                }
                if (gap > 60L) {
                    pulseOver60++;
                }
                if (gap > 100L) {
                    dumpStallStacks(lastPulseMs, now, gap);
                    pulseOver100++;
                }
            }
        }
        lastPulseMs = now;
    }

    // ==================== Stall stack capture ====================
    // A background sampler captures the server main thread's stack every 25 ms into a ring buffer. When a tick
    // gap exceeds 100 ms, the stacks sampled during the stall are logged as [nav-stall], showing which method
    // the main thread was blocked in. This covers blind spots outside the timed phases (lighting, chunk I/O,
    // other mods). The sampler thread exits when profiling is turned off.

    private static volatile Thread serverThread;
    private static volatile boolean samplerRunning;
    private static final int STALL_SAMPLES = 64;   // 25 ms x 64 = about 1.6 s capture window
    private static final long[] sampleTimes = new long[STALL_SAMPLES];
    private static final String[] sampleStacks = new String[STALL_SAMPLES];
    private static final AtomicLong sampleWrites = new AtomicLong();

    private static synchronized void ensureSampler() {
        if (samplerRunning) {
            return;
        }
        samplerRunning = true;
        Thread sampler = new Thread(() -> {
            while (NavSettings.get().profile) {
                Thread target = serverThread;
                if (target != null && target.isAlive()) {
                    StackTraceElement[] st = target.getStackTrace();
                    if (st.length > 0) {
                        int slot = (int) (sampleWrites.get() % STALL_SAMPLES);
                        sampleStacks[slot] = condense(st);
                        sampleTimes[slot] = System.currentTimeMillis();
                        sampleWrites.incrementAndGet();
                    }
                }
                try {
                    Thread.sleep(25L);
                } catch (InterruptedException e) {
                    break;
                }
            }
            samplerRunning = false;
        }, "mc_agent-stall-sampler");
        sampler.setDaemon(true);
        sampler.setPriority(Thread.MIN_PRIORITY);
        sampler.start();
    }

    /**
     * Compress the top of a stack into one line: at most 10 frames, class names reduced to their last two
     * segments.
     */
    private static String condense(StackTraceElement[] st) {
        StringBuilder sb = new StringBuilder(240);
        int frames = Math.min(st.length, 10);
        for (int i = 0; i < frames; i++) {
            StackTraceElement e = st[i];
            String cls = e.getClassName();
            int cut = cls.lastIndexOf('.');
            cut = cut <= 0 ? 0 : cls.lastIndexOf('.', cut - 1) + 1;
            if (i > 0) {
                sb.append(" < ");
            }
            sb.append(cls, cut, cls.length()).append('.').append(e.getMethodName())
                    .append(':').append(e.getLineNumber());
        }
        return sb.toString();
    }

    /** Log the deduplicated stack samples taken in (from, to] (at most 3, to avoid flooding). */
    private static void dumpStallStacks(long from, long to, long gap) {
        java.util.LinkedHashSet<String> distinct = new java.util.LinkedHashSet<>();
        for (int i = 0; i < STALL_SAMPLES; i++) {
            long t = sampleTimes[i];
            String s = sampleStacks[i];
            if (s != null && t > from && t <= to) {
                distinct.add(s);
            }
        }
        int logged = 0;
        for (String s : distinct) {
            Constants.LOG.info("[nav-stall] gap={}ms stack: {}", gap, s);
            if (++logged >= 3) {
                break;
            }
        }
        if (distinct.isEmpty()) {
            Constants.LOG.info("[nav-stall] gap={}ms (no samples captured in window)", gap);
        }
    }

    /**
     * Called on every PlayerNav.tick(): counts concurrent navigations and emits the summary line per window.
     */
    public static void tickFrame() {
        if (!NavSettings.get().profile) {
            return;
        }
        navTicks++;
        long now = System.currentTimeMillis();
        if (windowStartMs == 0L) {
            windowStartMs = now;
            // Snapshot the running-total baselines so the FIRST window reports window deltas, not the
            // JVM's lifetime GC / completed-task totals (which would make the first line read absurd).
            lastCompletedTasks = PathPlannerPool.completedTasks();
            long[] gc = gcTotals();
            lastGcCount = gc[0];
            lastGcTimeMs = gc[1];
        } else if (now - windowStartMs >= WINDOW_MS) {
            flush(now);
        }
    }

    private static void flush(long now) {
        long windowMs = Math.max(1L, now - windowStartMs);
        StringBuilder sb = new StringBuilder(256);
        sb.append("[nav-profile] window ").append(windowMs).append("ms  navTicks=").append(navTicks)
                .append(" (~").append(navTicks * 1000L / windowMs).append("/s)");
        for (Map.Entry<String, long[]> e : phases.entrySet()) {
            long[] a = e.getValue();
            double totalMs = a[1] / 1_000_000.0;
            double avgUs = a[0] == 0 ? 0.0 : (a[1] / 1_000.0) / a[0];
            double maxMs = a[2] / 1_000_000.0;
            sb.append(String.format("  | %s: n=%d total=%.1fms avg=%.1fus max=%.2fms",
                    e.getKey(), a[0], totalMs, avgUs, maxMs));
        }

        // Background searches (pool threads): total is CPU time and can far exceed window wall time (parallel
        // on multiple cores).
        long sc = searchCount.getAndSet(0L);
        long st = searchTotalNanos.getAndSet(0L);
        long sm = searchMaxNanos.getAndSet(0L);
        if (sc > 0) {
            sb.append(String.format("  | search(background): n=%d total=%.1fms max=%.1fms",
                    sc, st / 1_000_000.0, sm / 1_000_000.0));
        }

        // Pool snapshot: with a bounded pool the peak thread count is capped at POOL_SIZE; a peak pinned at
        // the cap means searches are queuing (high load), not threads starving the main thread.
        long completed = PathPlannerPool.completedTasks();
        sb.append(String.format("  | pool: threads=%d active=%d peak=%d completed+%d",
                PathPlannerPool.liveThreads(), PathPlannerPool.activeThreads(),
                PathPlannerPool.peakThreads(), completed - lastCompletedTasks));
        lastCompletedTasks = completed;

        // GC: JVM-wide stop-the-world pauses. A high GC share of the window directly explains all entities
        // stuttering together; it falls outside pathing timings, so clean goal.compile/core.tick numbers do
        // not rule it out.
        long[] gc = gcTotals();
        long gcCount = gc[0];
        long gcTimeMs = gc[1];
        sb.append(String.format("  | GC: count+%d pause+%dms (%.1f%% of window)",
                gcCount - lastGcCount, gcTimeMs - lastGcTimeMs,
                (gcTimeMs - lastGcTimeMs) * 100.0 / windowMs));
        lastGcCount = gcCount;
        lastGcTimeMs = gcTimeMs;

        // Server tick gap: gapMax near 50 ms means the server is smooth; frequent >60/>100 means main-thread
        // spikes outside the profiled phases.
        if (pulseGapMax > 0L) {
            sb.append(String.format("  | tick: gapMax=%dms over60=%d over100=%d",
                    pulseGapMax, pulseOver60, pulseOver100));
            pulseGapMax = 0L;
            pulseOver60 = 0L;
            pulseOver100 = 0L;
        }

        Constants.LOG.info(sb.toString());

        windowStartMs = now;
        navTicks = 0L;
        phases.clear();
    }

    /** JVM cumulative GC {count, pause ms}, summed over all collectors. */
    private static long[] gcTotals() {
        long count = 0L;
        long timeMs = 0L;
        for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            long c = gc.getCollectionCount();
            long t = gc.getCollectionTime();
            if (c > 0) {
                count += c;
            }
            if (t > 0) {
                timeMs += t;
            }
        }
        return new long[]{count, timeMs};
    }

    /**
     * Called when profiling is toggled: drops the current window so the next {@link #tickFrame} restarts from
     * a clean baseline instead of a skewed window spanning the toggle.
     */
    public static void reset() {
        windowStartMs = 0L;
        navTicks = 0L;
        phases.clear();
        searchCount.set(0L);
        searchTotalNanos.set(0L);
        searchMaxNanos.set(0L);
        lastPulseMs = 0L;
        pulseGapMax = 0L;
        pulseOver60 = 0L;
        pulseOver100 = 0L;
    }
}
