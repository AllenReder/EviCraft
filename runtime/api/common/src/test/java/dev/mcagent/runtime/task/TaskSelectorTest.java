package dev.mcagent.runtime.task;

import dev.mcagent.runtime.entity.BotPlayer;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Which slot holds the body: the order is fixed and selection is pure. */
class TaskSelectorTest {

    /** A stub that only answers whether it can run; it never touches Minecraft. */
    private static final class Stub implements Task {
        private final String id;
        private boolean ready;

        Stub(String id, boolean ready) {
            this.id = id;
            this.ready = ready;
        }

        @Override public boolean canRun(BotPlayer bot) {
            return ready;
        }

        @Override public TaskState tick(BotPlayer bot) {
            return TaskState.RUNNING;
        }

        @Override public void stop(BotPlayer bot, StopReason why) {
        }

        @Override public String name() {
            return id;
        }
    }

    @Test
    void syncBeatsTheCurrentTask() {
        Stub sync = new Stub("sync", true);
        assertSame(sync, TaskSelector.select(sync, new Stub("current", true), null));
    }

    @Test
    void currentTaskRunsWhenNoSyncActionWaits() {
        Stub current = new Stub("current", true);
        assertSame(current, TaskSelector.select(null, current, null));
        assertSame(current, TaskSelector.select(new Stub("sync", false), current, null));
    }

    @Test
    void nobodyWantsTheBody() {
        assertNull(TaskSelector.select(null, new Stub("current", false), null));
        assertNull(TaskSelector.select(null, null, null));
    }

    @Test
    void aTaskThatCannotRunYieldsAndTakesTheBodyBack() {
        Stub current = new Stub("current", false);
        assertNull(TaskSelector.select(null, current, null));

        current.ready = true;
        assertSame(current, TaskSelector.select(null, current, null));
    }

    @Test
    void selectionIsPureAndRepeatable() {
        Stub current = new Stub("current", true);
        Task first = TaskSelector.select(null, current, null);
        assertTrue(first == TaskSelector.select(null, current, null));
        assertTrue(first == TaskSelector.select(null, current, null));
    }
}
