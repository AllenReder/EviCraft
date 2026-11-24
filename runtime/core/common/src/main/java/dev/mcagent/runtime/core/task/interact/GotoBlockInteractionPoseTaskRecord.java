package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.Item;

/** One bounded navigation intent for an exact evidence-bound block hit. */
public final class GotoBlockInteractionPoseTaskRecord extends TaskRecord {
    public static final String TOOL_NAME = "goto_block_interaction_pose";
    public final BlockPos position;
    /** Item the pose must be able to use on the target, or null for a bare block hit. */
    public final Item item;

    public GotoBlockInteractionPoseTaskRecord(
            String toolCallId, long deadlineGameTime, BlockPos position) {
        this(toolCallId, deadlineGameTime, position, null);
    }

    public GotoBlockInteractionPoseTaskRecord(
            String toolCallId, long deadlineGameTime, BlockPos position, Item item) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.position = position.immutable();
        this.item = item;
    }

    @Override
    public String describe() {
        return TOOL_NAME + " " + position.toShortString();
    }
}
