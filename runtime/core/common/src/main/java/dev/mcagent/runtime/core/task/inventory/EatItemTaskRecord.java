package dev.mcagent.runtime.core.task.inventory;

import dev.mcagent.runtime.task.TaskRecord;
import net.minecraft.world.item.Item;

/**
 * Typed task descriptor for {@code eat}: consume a food / drink from the
 * bot's inventory. {@link EatTask} eats it natively (the player
 * body's own held-use path), so hunger + saturation + consume effects apply
 * exactly as they do for a real player when the chew completes.
 */
public final class EatItemTaskRecord extends TaskRecord {

    public static final String TOOL_NAME = "eat";

    /** The food item to eat (one is consumed on completion). */
    public final Item item;
    /** Exact Inventory slot, mutually exclusive with item. */
    public final Integer slot;
    /** Human-readable label for messages / debug overlay (e.g. "golden_apple"). */
    public final String label;

    public EatItemTaskRecord(String toolCallId, long deadlineGameTime, Item item, Integer slot, String label) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.item = item;
        this.slot = slot;
        this.label = label;
    }

    @Override
    public String describe() {
        return TOOL_NAME + " " + label;
    }
}
