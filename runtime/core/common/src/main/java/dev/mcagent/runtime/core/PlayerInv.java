package dev.mcagent.runtime.core;

import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;

/**
 * Small adapter giving the bot task layer the {@code SimpleContainer}-style
 * inventory operations it grew up on (count / remove-by-type / add-with-leftover)
 * over the player's native {@link Inventory}. The Mob used a 27-slot
 * SimpleContainer; the player body uses its full Inventory (hotbar + main +
 * armor + offhand), all reachable via {@link Inventory#getContainerSize()} /
 * {@link Inventory#getItem(int)}.
 */
public final class PlayerInv {

    private PlayerInv() {}

    /**
     * Slots available to building: hotbar + main inventory, <b>excluding armor and offhand</b>.
     *
     * <p>Every build step (quote, per-cell gate, actual deduction) must share this one number instead of
     * each counting with its own loop. If they diverge, a full stack of planks in the offhand makes the
     * 41-slot count say "enough material" while the 36-slot count reports a shortage at every cell.
     *
     * <p>Why 36 and not 41: armor is worn, and the offhand holds what the Bot is visibly carrying; neither
     * is building stock. Counting them would mean the Bot strips its own chestplate to build a wall.
     */
    public static final int BUILDABLE_SLOTS = 36;

    /** Total count of {@code item} across the whole inventory (armor + offhand included). */
    public static int count(Inventory inv, Item item) {
        int n = 0;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && s.is(item)) n += s.getCount();
        }
        return n;
    }

    /** Building stock: counts only the first {@link #BUILDABLE_SLOTS} slots. Shared by quote and deduction. */
    public static int buildableCount(Inventory inv, Item item) {
        int limit = Math.min(BUILDABLE_SLOTS, inv.items.size());
        int n = 0;
        for (int i = 0; i < limit; i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && s.is(item)) n += s.getCount();
        }
        return n;
    }

    /** First slot holding {@code item}, or -1. */
    public static int findSlot(Inventory inv, Item item) {
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && s.is(item)) return i;
        }
        return -1;
    }

    /** Remove up to {@code max} of {@code item}; returns how many were removed. */
    public static int remove(Inventory inv, Item item, int max) {
        int removed = 0;
        for (int i = 0; i < inv.getContainerSize() && removed < max; i++) {
            ItemStack s = inv.getItem(i);
            if (s.isEmpty() || !s.is(item)) continue;
            int take = Math.min(s.getCount(), max - removed);
            s.shrink(take);
            removed += take;
        }
        inv.setChanged();
        return removed;
    }

    /**
     * Add {@code stack} to the inventory; returns whatever didn't fit (empty if
     * all fit). Mirrors {@code SimpleContainer.addItem}'s leftover contract over
     * {@link Inventory#add(ItemStack)} (which mutates the stack down by what fit).
     */
    public static ItemStack add(Inventory inv, ItemStack stack) {
        inv.add(stack);
        return stack;   // Inventory.add consumed what fit; remainder stays here
    }
}
