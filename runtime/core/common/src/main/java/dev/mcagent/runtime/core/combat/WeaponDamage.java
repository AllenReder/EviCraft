package dev.mcagent.runtime.core.combat;

import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.ItemAttributeModifiers;
import net.minecraft.world.item.enchantment.EnchantmentHelper;

/**
 * How much damage this weapon deals <b>against this target</b>, used to rank the Bot's own weapons.
 *
 * <h2>Why the item's attack damage is not enough</h2>
 * Attack damage is a target-independent constant, so an iron sword with Smite V would lose to a plain
 * diamond sword against a zombie, while in fact it is the opposite. Enchantments are data-driven since
 * 1.21, so this class keeps no bonus table for Sharpness/Smite/Bane of Arthropods: such a table would have
 * to track vanilla values and would be blind to modded enchantments. The calculation is delegated to
 * {@link EnchantmentHelper#modifyDamage}, which knows every registered enchantment.
 *
 * <h2>What is counted and what is not</h2>
 * Counted: the weapon's own attack damage + the enchantment bonus against this target + the item's extra
 * damage ({@link Item#getAttackDamageBonus}; the mace's falling bonus goes through here).
 *
 * <p>Not counted: Strength, critical hits, and the target's armor and resistance. <b>They are not missing;
 * they do not change the ranking</b>: Strength adds the same constant, armor and resistance multiply by the
 * same factor, and a critical hit multiplies by 1.5, all the same monotonic transform for every candidate.
 * Since only "which weapon is strongest" matters, computing them would be wasted work.
 */
public final class WeaponDamage {

    private WeaponDamage() {}

    /**
     * Ranking score. <b>For comparison only</b>; not the actual damage of a hit (see the class comment).
     *
     * @return relative strength of this weapon against this target; 0 for weapons with zero attack damage
     *         such as bows and crossbows, which do not take the melee path
     */
    public static double against(Player attacker, Entity target, ItemStack weapon) {
        if (weapon.isEmpty() || !(attacker.level() instanceof ServerLevel level)) {
            return 0.0;
        }
        double base = flatAttackDamage(weapon);
        if (base <= 0.0) {
            return 0.0;   // not a melee weapon: blocks, food, and bows/crossbows whose damage is on the arrow
        }
        DamageSource source = level.damageSources().playerAttack(attacker);
        double enchanted = EnchantmentHelper.modifyDamage(level, weapon, target, source, (float) base);
        return enchanted + weapon.getItem().getAttackDamageBonus(target, (float) enchanted, source);
    }

    /**
     * The flat attack damage the item adds in the main hand. Only {@code ADD_VALUE} counts: multiplicative
     * modifiers scale the already summed total and mean nothing apart from the base value, while this
     * compares each weapon's own flat contribution.
     */
    public static double flatAttackDamage(ItemStack stack) {
        if (stack.isEmpty()) {
            return 0.0;
        }
        ItemAttributeModifiers modifiers =
                stack.getOrDefault(DataComponents.ATTRIBUTE_MODIFIERS, ItemAttributeModifiers.EMPTY);
        double damage = 0.0;
        for (ItemAttributeModifiers.Entry entry : modifiers.modifiers()) {
            if (entry.slot().test(EquipmentSlot.MAINHAND)
                    && entry.attribute().is(Attributes.ATTACK_DAMAGE)
                    && entry.modifier().operation() == AttributeModifier.Operation.ADD_VALUE) {
                damage += entry.modifier().amount();
            }
        }
        return damage;
    }
}
