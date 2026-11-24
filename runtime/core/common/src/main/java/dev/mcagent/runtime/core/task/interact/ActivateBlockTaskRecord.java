package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.core.BlockPos;

/** Typed descriptor for one exact verified block activation. */
public final class ActivateBlockTaskRecord extends TaskRecord {
    public static final String TOOL_NAME = "activate_block";
    public final BlockPos position;

    public ActivateBlockTaskRecord(String toolCallId, long deadlineGameTime, BlockPos position) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.position = position.immutable();
    }

    @Override
    public String describe() {
        return TOOL_NAME + " " + position.toShortString();
    }
}
