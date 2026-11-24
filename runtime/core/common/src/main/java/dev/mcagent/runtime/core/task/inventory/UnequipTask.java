package dev.mcagent.runtime.core.task.inventory;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code equip_item action=unequip} on the player body: moves the items in the given slots back into the
 * inventory.
 *
 * <p><b>The main hand is switched, not moved</b>: freeing the hand prefers selecting an empty hotbar slot
 * (what a real player does with the number keys; the hotbar layout stays unchanged), and only moves the held
 * item into the inventory when the hotbar is full. Armor and offhand go straight into the inventory.
 *
 * <p><b>A full inventory is refused before anything moves</b>: dropping equipment on the ground is far worse
 * than failing to unequip, so free space is checked before a slot is touched; an item is never taken off and
 * then thrown away for lack of room. The batch form (armor) proceeds piece by piece and stops when space runs
 * out; pieces already removed count, and pieces still worn are reported as such.
 * One-tick (all work in {@link #onStart()}).
 */
public final class UnequipTask extends AbstractBotTask<UnequipTaskRecord> {

    private String message = "";
    private TaskState result;
    private final List<String> removed = new ArrayList<>();
    private final List<String> kept = new ArrayList<>();

    public UnequipTask(BotPlayer player, UnequipTaskRecord record) {
        super(player, record);
    }

    /** No preconditions: an already empty slot is not an error and is reported as is. */
    @Override
    protected List<Precondition> preconditions() {
        return List.of();
    }

    @Override
    protected void onStart() {
        Inventory inv = player.getInventory();
        boolean anyWorn = false;

        for (EquipmentSlot slot : r.slots) {
            if (slot == EquipmentSlot.MAINHAND) {
                anyWorn |= freeMainHand(inv);
                continue;
            }
            ItemStack piece = player.getItemBySlot(slot);
            if (piece.isEmpty()) {
                continue;
            }
            anyWorn = true;
            if (inv.getFreeSlot() < 0) {
                kept.add(itemName(piece) + " (" + slot.getName() + ")");
                continue;
            }
            player.setItemSlot(slot, ItemStack.EMPTY);
            ItemStack stow = piece.copy();
            if (!inv.add(stow)) {
                player.setItemSlot(slot, piece);   // no room: put it back on, never drop it
                kept.add(itemName(piece) + " (" + slot.getName() + ")");
                continue;
            }
            removed.add(itemName(piece) + " (" + slot.getName() + ")");
        }
        inv.setChanged();

        if (!anyWorn) {
            succeed("nothing to take off — " + r.label + " already empty");
            return;
        }
        if (removed.isEmpty()) {
            fail("inventory is full — no room to stow " + r.label, FailureType.NO_SPACE);
            return;
        }
        succeed("took off " + String.join(", ", removed)
                + (kept.isEmpty() ? ""
                        : "; inventory full, still wearing " + String.join(", ", kept)));
    }

    /**
     * Frees the main hand. @return whether the hand held anything (an empty hand removes nothing).
     */
    private boolean freeMainHand(Inventory inv) {
        ItemStack held = inv.getItem(inv.selected);
        if (held.isEmpty()) {
            return false;
        }
        for (int i = 0; i < Inventory.getSelectionSize(); i++) {
            if (inv.getItem(i).isEmpty()) {
                inv.selected = i;
                removed.add("main hand freed (switched to an empty hotbar slot, still carrying "
                        + itemName(held) + ")");
                return true;
            }
        }
        int free = inv.getFreeSlot();   // hotbar is full: any free slot is in the main inventory
        if (free < 0) {
            kept.add(itemName(held) + " (mainhand)");
            return true;
        }
        inv.setItem(free, held.copy());
        inv.setItem(inv.selected, ItemStack.EMPTY);
        removed.add("main hand freed (stowed " + itemName(held) + ")");
        return true;
    }

    private static String itemName(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
    }

    @Override
    protected TaskState onTick() {
        return result != null ? result : TaskState.FAILED;   // fail() short-circuits before here
    }

    /** No nav / overlay to release. */
    @Override
    protected void cleanup() {}

    private void succeed(String msg) {
        message = msg;
        result = TaskState.SUCCESS;
        succeed();   // base: park + stamp SUCCESS so the unequip finalizes this same tick
    }

    @Override
    protected Map<String, Object> resultData() {
        Map<String, Object> data = new HashMap<>();
        if (!removed.isEmpty()) data.put("removed", List.copyOf(removed));
        if (!kept.isEmpty()) data.put("still_worn", List.copyOf(kept));
        return data;
    }

    @Override
    protected String successMessage() {
        return message;
    }

    @Override
    protected String cancelledMessage() {
        return "unequip interrupted";
    }
}
