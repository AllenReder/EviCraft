package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.core.BlockPos;

/** One exact {@code KNOWN_BLOCK} to break from where the body stands. */
public final class BreakBlockTaskRecord extends TaskRecord {
    public static final String TOOL_NAME = "break_block";

    public final BlockPos position;

    public BreakBlockTaskRecord(String toolCallId, long deadlineGameTime, BlockPos position) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.position = position.immutable();
    }

    @Override
    public String describe() {
        return TOOL_NAME + " @" + position.getX() + "," + position.getY() + "," + position.getZ();
    }
}
