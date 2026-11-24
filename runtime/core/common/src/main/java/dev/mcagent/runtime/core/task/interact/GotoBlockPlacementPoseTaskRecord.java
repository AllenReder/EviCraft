package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;

/** Typed descriptor for one item-specific approach to an exact placement target. */
public final class GotoBlockPlacementPoseTaskRecord extends TaskRecord {
    public static final String TOOL_NAME = "goto_block_placement_pose";
    public final String itemId;
    public final Item item;
    public final BlockItem blockItem;
    public final BlockPos position;

    public GotoBlockPlacementPoseTaskRecord(String toolCallId, long deadlineGameTime, String itemId,
                                            Item item, BlockItem blockItem, BlockPos position) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.itemId = itemId;
        this.item = item;
        this.blockItem = blockItem;
        this.position = position.immutable();
    }

    @Override
    public String describe() {
        return TOOL_NAME + " " + itemId + " @" + position.toShortString();
    }
}
