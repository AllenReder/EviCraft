package dev.mcagent.runtime.task;

import dev.mcagent.runtime.entity.BotPlayer;
import org.junit.jupiter.api.Test;
import java.util.ArrayList;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class TaskSlotSettlementTest {
    @Test
    void cancellationStopFailureSettlesOnceAndRetainsPartialEffects() throws Exception {
        List<TaskRecord> replies = new ArrayList<>();
        TaskSlot slot = new TaskSlot(replies::add);
        TaskRecord record = new TaskRecord("placing", "runtime-test", 10) {};
        record.setState(TaskState.RUNNING);
        int[] stops = {0};
        int[] results = {0};
        install(slot, record, new Task() {
            public TaskState tick(BotPlayer body) { return TaskState.RUNNING; }
            public void stop(BotPlayer body, StopReason reason) {
                stops[0]++;
                assertTrue(slot.isEmpty());
                slot.cancelAndSettle(null);
                throw new IllegalStateException("native release failed");
            }
            public String name() { return "placing"; }
            public TaskResult result(TaskState terminal) {
                results[0]++;
                assertEquals(TaskState.CANCELLED, terminal);
                return new TaskResult(false, "placement interrupted", false, true,
                        java.util.Map.of("consumed_count", 1));
            }
        });

        assertDoesNotThrow(() -> slot.cancelAndSettle(null));
        slot.cancelAndSettle(null);
        slot.settleIfTerminal();
        slot.finalizeInline();

        assertTrue(slot.isEmpty());
        assertEquals(1, stops[0]);
        assertEquals(1, results[0]);
        assertEquals(1, replies.size());
        TaskResult result = replies.getFirst().getResult();
        assertFalse(result.success());
        assertTrue(result.interrupted());
        assertEquals("internal", result.data().get("failure_type"));
        assertEquals(1, result.data().get("consumed_count"));
        assertTrue(result.message().contains("native release failed"));
    }

    @Test
    void resultFailureReleasesSlotAndRepliesExactlyOnce() throws Exception {
        List<TaskRecord> replies = new ArrayList<>();
        TaskSlot slot = new TaskSlot(replies::add);
        TaskRecord record = new TaskRecord("failing", "runtime-test", 10) {};
        record.setState(TaskState.CANCELLED);
        install(slot, record, new Task() {
            public TaskState tick(BotPlayer body) { return TaskState.RUNNING; }
            public void stop(BotPlayer body, StopReason reason) {}
            public String name() { return "failing"; }
            public TaskResult result(TaskState terminal) { throw new IllegalStateException("cleanup"); }
        });
        slot.settleIfTerminal();
        slot.settleIfTerminal();
        slot.finalizeInline();
        assertTrue(slot.isEmpty());
        assertEquals(1, replies.size());
        assertTrue(replies.getFirst().getResult().interrupted());
        assertEquals("internal", replies.getFirst().getResult().data().get("failure_type"));
    }

    @Test
    void outboxReentrancySeesReleasedSlot() throws Exception {
        TaskSlot[] owner = new TaskSlot[1];
        int[] replies = {0};
        owner[0] = new TaskSlot(record -> {
            assertTrue(owner[0].isEmpty());
            owner[0].settleIfTerminal();
            replies[0]++;
        });
        TaskRecord record = new TaskRecord("done", "runtime-test", 10) {};
        record.setState(TaskState.SUCCESS);
        install(owner[0], record, new Task() {
            public TaskState tick(BotPlayer body) { return TaskState.SUCCESS; }
            public void stop(BotPlayer body, StopReason reason) {}
            public String name() { return "done"; }
            public TaskResult result(TaskState terminal) { return TaskResult.ok("done"); }
        });
        owner[0].settleIfTerminal();
        assertEquals(1, replies[0]);
    }

    // Install a terminal task without booting a Minecraft level or bypassing production settlement.
    private static void install(TaskSlot slot, TaskRecord record, Task task) throws Exception {
        var recordField = TaskSlot.class.getDeclaredField("record");
        recordField.setAccessible(true);
        recordField.set(slot, record);
        var taskField = TaskSlot.class.getDeclaredField("task");
        taskField.setAccessible(true);
        taskField.set(slot, task);
    }
}
