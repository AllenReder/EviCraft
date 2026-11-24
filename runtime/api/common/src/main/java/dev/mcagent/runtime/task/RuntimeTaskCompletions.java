package dev.mcagent.runtime.task;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;

/** One-shot terminal-result bridge from the task scheduler to the Runtime SDK. */
public final class RuntimeTaskCompletions {

    private static final Map<String, Consumer<String>> WAITERS = new HashMap<>();

    private RuntimeTaskCompletions() {}

    public static synchronized void register(String toolCallId, Consumer<String> completion) {
        Objects.requireNonNull(toolCallId, "toolCallId");
        Objects.requireNonNull(completion, "completion");
        if (WAITERS.putIfAbsent(toolCallId, completion) != null) {
            throw new IllegalStateException("duplicate Runtime task id: " + toolCallId);
        }
    }

    public static synchronized void forget(String toolCallId) {
        WAITERS.remove(toolCallId);
    }

    static void complete(TaskRecord record) {
        Consumer<String> completion;
        synchronized (RuntimeTaskCompletions.class) {
            completion = WAITERS.remove(record.getToolCallId());
        }
        if (completion != null) {
            TaskResult result = record.getResult();
            completion.accept((result == null
                    ? TaskResult.fail("no result produced") : result).toJson());
        }
    }
}
