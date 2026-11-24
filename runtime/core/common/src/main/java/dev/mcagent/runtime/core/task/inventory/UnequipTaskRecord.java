package dev.mcagent.runtime.core.task.inventory;

import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.world.entity.EquipmentSlot;

import java.util.List;

/**
 * Task descriptor for {@code equip_item action=unequip}: move the items in these slots back into the
 * inventory. It and {@link EquipTaskRecord} are two forms of one tool: both act on the Bot's own equipment,
 * so the verb is an argument rather than a separate tool. Completes in one tick with no pathfinding.
 *
 * <p>{@link #slots} is a single slot, or the four armor pieces that {@code slot=armor} expands to.
 */
public final class UnequipTaskRecord extends TaskRecord {

    /** Human-readable label for messages / debug overlay: "armor" or a single slot name. */
    public final String label;
    public final List<EquipmentSlot> slots;

    public UnequipTaskRecord(String toolCallId, long deadlineGameTime,
                             List<EquipmentSlot> slots, String label) {
        super(EquipTaskRecord.TOOL_NAME, toolCallId, deadlineGameTime);
        this.slots = List.copyOf(slots);
        this.label = label;
    }

    @Override
    public String describe() {
        return EquipTaskRecord.TOOL_NAME + " unequip " + label;
    }
}
