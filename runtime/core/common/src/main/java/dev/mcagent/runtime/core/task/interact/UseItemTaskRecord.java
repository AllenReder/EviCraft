package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;

/**
 * One use of a carried item toward open air. {@code aim} is the {@code KNOWN_AIR} cell to face;
 * {@code null} means the cell at reach distance along the current facing. {@code holdTicks}: 0 is one
 * click, a positive value holds the use that long and then releases it, -1 holds until the use ends on
 * its own or the task times out.
 */
public final class UseItemTaskRecord extends TaskRecord {
    public static final String TOOL_NAME = "use_item";

    public final BlockPos aim;
    public final int holdTicks;
    /** {@code null} uses whatever is in hand. */
    public final Item item;

    public UseItemTaskRecord(String toolCallId, long deadlineGameTime,
                             BlockPos aim, int holdTicks, Item item) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.aim = aim != null ? aim.immutable() : null;
        this.holdTicks = holdTicks;
        this.item = item;
    }

    /**
     * Why a generic use must not handle {@code item}, or {@code null} if it may. Food and Ender Eyes
     * have dedicated tools that verify their own outcome; an Ender Pearl would teleport the body
     * outside navigation.
     */
    public static String unsupportedReason(Item item) {
        if (item == null) {
            return null;
        }
        if (item.components().has(DataComponents.FOOD)) {
            return BuiltInRegistries.ITEM.getKey(item) + " is food; the eat tool consumes it.";
        }
        if (item == Items.ENDER_EYE) {
            return "minecraft:ender_eye is thrown with throw_eye_of_ender.";
        }
        if (item == Items.ENDER_PEARL) {
            return "minecraft:ender_pearl teleportation is not supported.";
        }
        return null;
    }

    @Override
    public String describe() {
        return TOOL_NAME
                + (item != null ? " " + BuiltInRegistries.ITEM.getKey(item).getPath() : "")
                + (aim != null ? " @" + aim.getX() + "," + aim.getY() + "," + aim.getZ() : " (forward)")
                + (holdTicks != 0 ? " hold=" + holdTicks : "");
    }
}
