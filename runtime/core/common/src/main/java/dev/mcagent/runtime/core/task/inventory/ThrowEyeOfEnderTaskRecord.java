package dev.mcagent.runtime.core.task.inventory;

import dev.mcagent.runtime.task.TaskRecord;

/** Typed descriptor for one embodied, native Ender Eye throw. */
public final class ThrowEyeOfEnderTaskRecord extends TaskRecord {

    public static final String TOOL_NAME = "throw_eye_of_ender";

    public ThrowEyeOfEnderTaskRecord(String toolCallId, long deadlineGameTime) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
    }
}
