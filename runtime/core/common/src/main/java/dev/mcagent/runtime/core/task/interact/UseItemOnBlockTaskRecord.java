package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.Item;

/** Typed descriptor for one exact verified item-on-block use. */
public final class UseItemOnBlockTaskRecord extends TaskRecord {
    public static final String TOOL_NAME = "use_item_on_block";
    public final String itemId;
    public final Item item;
    public final BlockPos position;

    public UseItemOnBlockTaskRecord(String toolCallId, long deadlineGameTime,
                                    String itemId, Item item, BlockPos position) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.itemId = itemId;
        this.item = item;
        this.position = position.immutable();
    }

    @Override
    public String describe() {
        return TOOL_NAME + " " + itemId + " @" + position.toShortString();
    }
}
