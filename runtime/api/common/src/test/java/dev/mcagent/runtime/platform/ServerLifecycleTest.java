package dev.mcagent.runtime.platform;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The server-stop cleanup contract.
 *
 * <p>It guards against a deadlock: leaving a single-player save does not end the process, so in-process
 * world-scoped state survives into the next save, and a task bound to an old body can park the new Server
 * thread forever. If each loader kept its own list of what to drop, the list would live apart from the
 * state and eventually miss something. So this tests only two things: <b>every registered cleanup
 * runs</b>, and <b>one failing cleanup does not stop the rest</b>.
 */
class ServerLifecycleTest {

    @Test
    void everyRegisteredDropRuns() {
        List<String> ran = new ArrayList<>();
        ServerLifecycle.onStopped(() -> ran.add("a"));
        ServerLifecycle.onStopped(() -> ran.add("b"));

        ServerLifecycle.fireStopped();

        assertTrue(ran.contains("a"));
        assertTrue(ran.contains("b"));
    }

    @Test
    void oneFailingDropDoesNotStopTheRest() {
        // One cleanup throwing on the stop path must not cut off every cleanup after it; a single
        // exception would otherwise skip all later cleanups.
        List<String> ran = new ArrayList<>();
        ServerLifecycle.onStopped(() -> {
            throw new IllegalStateException("cleanup blew up");
        });
        ServerLifecycle.onStopped(() -> ran.add("after"));

        ServerLifecycle.fireStopped();

        assertTrue(ran.contains("after"), "after an earlier step threw, the later cleanup did not run");
    }

    @Test
    void firingTwiceIsSafe() {
        // Switching saves twice = two stops in a row; cleanup must be idempotent.
        List<String> ran = new ArrayList<>();
        ServerLifecycle.onStopped(() -> ran.add("x"));

        ServerLifecycle.fireStopped();
        ServerLifecycle.fireStopped();

        assertEquals(2, ran.stream().filter("x"::equals).count());
    }
}
