package dev.mcagent.runtime.core.task;

import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.task.TaskState;
import org.junit.jupiter.api.Test;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class TaskCleanupResultTest {
    @Test
    void cleanupFailurePreservesVerifiedOutcomeAndProgress() {
        TaskRecord record = new TaskRecord("verified", "runtime-test", 10) {};
        var task = new AbstractBotTask<TaskRecord>(null, record) {
            protected TaskState onTick() { return TaskState.SUCCESS; }
            protected String successMessage() { return "verified"; }
            protected Map<String, Object> resultData() { return Map.of("collected", 3); }
            protected void cleanup() { throw new IllegalStateException("release failed"); }
        };
        var result = task.result(TaskState.SUCCESS);
        assertTrue(result.success());
        assertEquals(3, result.data().get("collected"));
        assertEquals(Map.of("collected", 3), result.data());
    }
}
