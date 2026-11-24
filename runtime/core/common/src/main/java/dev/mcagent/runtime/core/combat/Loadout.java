package dev.mcagent.runtime.core.combat;

import dev.mcagent.runtime.entity.BotPlayer;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.BowItem;
import net.minecraft.world.item.CrossbowItem;
import net.minecraft.world.item.ItemStack;

/**
 * Which melee weapon and which ranged weapon to use against this target. <b>Each path picks its own
 * best; they are not ranked on one list</b>, because they are not comparable: a bow has 0 attack damage
 * (the damage is on the arrow), so on a list ranked by attack damage it always comes last and a Bot
 * carrying a bow would still close in with a stone sword. Whether a target is reachable is decided by
 * {@link AttackPlan}; this class only answers "which weapon is best on each path".
 */
public final class Loadout {

    /** A weapon and its inventory slot. {@code slot} is passed to {@code holdInHand}. */
    public record Pick(int slot, ItemStack stack, double score) {}

    private final Pick melee;
    private final Pick ranged;
    private final boolean rangedCharged;

    private Loadout(Pick melee, Pick ranged, boolean rangedCharged) {
        this.melee = melee;
        this.ranged = ranged;
        this.rangedCharged = rangedCharged;
    }

    /** The strongest melee weapon; null when bare-handed. */
    public Pick melee() {
        return melee;
    }

    /** A ranged weapon usable right now; null with no bow/crossbow, or with one but no arrows. */
    public Pick ranged() {
        return ranged;
    }

    public boolean hasMelee() {
        return melee != null;
    }

    public boolean hasRanged() {
        return ranged != null;
    }

    /** The chosen ranged weapon is a loaded crossbow: it needs no draw and can fire immediately. */
    public boolean rangedCharged() {
        return rangedCharged;
    }

    /**
     * Scans the inventory. Melee is ranked by {@link WeaponDamage#against} for <b>this target</b>; ranged
     * is picked as "loaded crossbow &gt; bow &gt; unloaded crossbow": a loaded crossbow skips the whole
     * draw cycle, and drawing a bow is faster than loading a crossbow.
     */
    public static Loadout forTarget(BotPlayer player, Entity target) {
        Inventory inventory = player.getInventory();
        Pick bestMelee = null;
        Pick chargedCrossbow = null;
        Pick bow = null;
        Pick loadableCrossbow = null;

        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (stack.isEmpty()) {
                continue;
            }
            if (stack.getItem() instanceof CrossbowItem) {
                if (CrossbowItem.isCharged(stack)) {
                    if (chargedCrossbow == null) {
                        chargedCrossbow = new Pick(slot, stack, 0.0);
                    }
                } else if (loadableCrossbow == null && !player.getProjectile(stack).isEmpty()) {
                    loadableCrossbow = new Pick(slot, stack, 0.0);
                }
                continue;
            }
            if (stack.getItem() instanceof BowItem) {
                if (bow == null && !player.getProjectile(stack).isEmpty()) {
                    bow = new Pick(slot, stack, 0.0);
                }
                continue;
            }
            double score = WeaponDamage.against(player, target, stack);
            if (score > 0.0 && (bestMelee == null || score > bestMelee.score())) {
                bestMelee = new Pick(slot, stack, score);
            }
        }

        Pick ranged = chargedCrossbow != null ? chargedCrossbow
                : bow != null ? bow
                : loadableCrossbow;
        return new Loadout(bestMelee, ranged, ranged != null && ranged == chargedCrossbow);
    }
}
