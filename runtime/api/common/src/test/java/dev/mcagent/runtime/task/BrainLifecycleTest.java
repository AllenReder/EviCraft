package dev.mcagent.runtime.task;

import dev.mcagent.runtime.platform.ServerLifecycle;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * Brains belong to the world, not to the process.
 *
 * <h2>Why</h2>
 * Leaving a single-player save does not end the process, so a static brain table would survive into the
 * next save. A RUNNING task in it stays bound to <b>the previous world's body</b>. The new world's first
 * tick runs it, and it reads blocks from the old {@code ServerLevel}, whose recorded main thread has
 * already ended. {@code ServerChunkCache.getChunk} then takes its asynchronous branch, submits work to a
 * queue that nothing drains any more, and calls {@code join()}. The new Server thread parks forever and
 * the world never loads.
 *
 * <p>Quitting the game and relaunching destroys the process and is safe; leaving and re-entering a save
 * does not, which is why this invariant is needed.
 */
class BrainLifecycleTest {

    @Test
    void brainsAreDroppedWhenTheServerStops() {
        UUID her = UUID.randomUUID();

        TaskSlot before = BotTickDispatcher.syncSlotFor(her);
        assertSame(before, BotTickDispatcher.syncSlotFor(her),
                "in the same world, the same Bot should get the same brain every time");

        ServerLifecycle.fireStopped();   // = leaving the save / server stop

        assertNotSame(before, BotTickDispatcher.syncSlotFor(her),
                "still got the old brain after server shutdown; it holds tasks bound to a body in the old world");
    }

    @Test
    void theDispatcherRegistersItselfWithoutAnyLoaderHelp() {
        // The test above checks behavior; this one checks <b>why nothing is missed</b>: the cleanup sits
        // in a static block next to the state, so loading the class registers it and no loader code is needed.
        UUID her = UUID.randomUUID();
        TaskSlot fresh = BotTickDispatcher.currentSlotFor(her);

        ServerLifecycle.fireStopped();

        assertNotSame(fresh, BotTickDispatcher.currentSlotFor(her));
    }
}
