package dev.mcagent.runtime.core.tools;

import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ClickType;

/**
 * Menu click primitives. The "pick up, right-click one at a time, return the remainder" sequence for
 * moving exactly N items is shared by transfer and crafting-grid placement; keeping one copy prevents
 * their exact-count semantics from drifting apart.
 */
public final class MenuOps {

    private MenuOps() {}

    /**
     * Picks up the whole stack at {@code from}, drops one item at a time into {@code to} up to
     * {@code count} times (right-click single drop, merging/filling), then returns the remainder to
     * {@code from}. The drop count is clamped to the number actually picked up: once the cursor is empty,
     * an extra right-click would pick up half of the target stack instead.
     * Callers verify the placed count themselves: the menu may reject items (full, or slot filter).
     */
    public static void dripInto(AbstractContainerMenu menu, Player who, int from, int to, int count) {
        menu.clicked(from, 0, ClickType.PICKUP, who);            // grab the stack
        int drops = Math.min(count, menu.getCarried().getCount());
        for (int i = 0; i < drops; i++) {
            menu.clicked(to, 1, ClickType.PICKUP, who);          // drop ONE (merges / fills)
        }
        if (!menu.getCarried().isEmpty()) {
            menu.clicked(from, 0, ClickType.PICKUP, who);        // return the remainder
        }
    }
}
