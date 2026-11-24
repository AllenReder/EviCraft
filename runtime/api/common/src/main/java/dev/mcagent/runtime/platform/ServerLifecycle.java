package dev.mcagent.runtime.platform;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Server stopped: all in-process state that belongs to that world is discarded here.
 *
 * <h2>Why it is needed</h2>
 * Leaving a single-player save does not end the process. The integrated server shuts down, but static
 * tables survive unchanged into the next save, so the previous world's caches, brains and ledgers would
 * be used as if they were valid in the new one.
 *
 * <p>The worst case is a deadlock. A surviving brain table can hold a RUNNING task bound to <b>the
 * previous world's body</b>. The new world's first tick runs it, and it reads blocks from the old
 * {@code ServerLevel}, whose recorded main thread is a Server thread that has already ended. So
 * {@code ServerChunkCache.getChunk} takes its asynchronous branch, submits work to a queue that nothing
 * drains any more, and calls {@code join()}. The new Server thread parks forever and the world never loads.
 *
 * <h2>Why registration, not a list</h2>
 * A list in the loader ("on stop, drop A, drop B") lives apart from the state itself: adding C is easy
 * to forget, and the forgotten entry is exactly what causes the deadlock above.
 *
 * <p>So it is inverted: <b>whoever holds world-scoped state registers it in its own static block</b>.
 * The cleanup sits next to the state; new state means one new line, and the loader never changes, so
 * nothing can be left unregistered. A class that was never loaded never registers, which is correct:
 * it holds no state to clear.
 *
 * <p>Each loader calls {@link #fireStopped()} once on its server-stopped event. Leaving a single-player
 * save, stopping a dedicated server, and switching saves all go through it.
 */
public final class ServerLifecycle {

    private static final List<Runnable> ON_STOPPED = new CopyOnWriteArrayList<>();

    private ServerLifecycle() {}

    /**
     * Registers {@code drop}, called on every server stop to clear this piece of world-scoped state.
     *
     * <p>Call it from the holder's own static block. It must be idempotent: two stops in a row (switching
     * saves) call it twice.
     */
    public static void onStopped(Runnable drop) {
        ON_STOPPED.add(drop);
    }

    /** Called by each loader on its server-stopped event. One failing cleanup does not stop the rest. */
    public static void fireStopped() {
        for (Runnable drop : ON_STOPPED) {
            try {
                drop.run();
            } catch (RuntimeException e) {
                dev.mcagent.runtime.Constants.LOG.warn("[mc_agent] A server-shutdown cleanup step failed; continuing with the rest", e);
            }
        }
    }
}
