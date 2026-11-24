package dev.mcagent.runtime.core.task.interact;
import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.Item;

import java.util.UUID;

/**
 * Typed descriptor for evidence-bound {@code interact_entity}. Identity is one UUID from an
 * Entity Track and the only supported action is native USE (right-click); attack is a separate
 * Runtime Ability. {@code holdTicks}: 0 = tap, &gt;0 = hold N ticks, -1 = bounded by task timeout.
 */
public final class InteractEntityTaskRecord extends TaskRecord {

    public static final String TOOL_NAME = "interact_entity";

    public final UUID entityUuid;
    public final int holdTicks;
    public final Item item; // null → use current hand; otherwise equip this interaction item

    public InteractEntityTaskRecord(String toolCallId, long deadlineGameTime,
                                    UUID entityUuid, int holdTicks, Item item) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.entityUuid = entityUuid;
        this.holdTicks = holdTicks;
        this.item = item;
    }

    @Override
    public String describe() {
        return TOOL_NAME
                + (item != null ? " " + BuiltInRegistries.ITEM.getKey(item).getPath() : "")
                + " " + entityUuid + (holdTicks != 0 ? " hold=" + holdTicks : "");
    }
}
