package dev.mcagent.runtime.core.pathing.moves;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.TagKey;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.item.AxeItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.MaceItem;
import net.minecraft.world.item.SwordItem;
import net.minecraft.world.item.TridentItem;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.EnchantmentEffectComponents;
import net.minecraft.world.item.enchantment.Enchantments;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.item.enchantment.effects.EnchantmentAttributeEffect;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Hotbar tool evaluation: for any block, gives the "best tool mining speed" (1/mining ticks) and the best
 * slot. Results are cached per Block and reused for the whole cost calculation.
 *
 * <p>Threading model: constructed on the main thread, which copies the nine hotbar slots one by one and
 * samples the selected slot, potion modifier and all relevant settings into final fields. After that every
 * query reads only the snapshot, so worker threads can call it safely without live reads of the player's
 * inventory or global settings.
 */
public class ToolSet {

    /** Cache of block -> best tool mining speed. */
    private final Map<Block, Double> breakStrengthCache;

    /** Computes a cache miss (the potion modifier is folded in at construction to avoid re-checking). */
    private final Function<Block, Double> backendCalculation;

    /** The nine hotbar slots, copied one by one at construction. */
    private final ItemStack[] hotbar;

    /** Held slot at construction (used for costing when autoTool is off). */
    private final int selectedSlot;

    /** When true, the functional-block protection multiplier is disabled (forced break semantics). */
    private final boolean ignoreBreakingProtection;

    // Settings sampled at construction (changing settings mid-calculation does not affect this search)
    private final boolean autoTool;
    private final boolean useSwordToMine;
    private final boolean itemSaver;
    private final int itemSaverThreshold;
    private final List<Block> blocksToAvoidBreaking;
    private final double avoidBreakingMultiplier;

    public ToolSet(ServerPlayer player) {
        this(player, false);
    }

    public ToolSet(ServerPlayer player, boolean ignoreBreakingProtection) {
        this(snapshotHotbar(player), player.getInventory().selected, ignoreBreakingProtection,
                NavSettings.get().considerPotionEffects ? potionAmplifier(player) : 1.0);
    }

    /**
     * Direct construction from a snapshot (for thread-safety smoke tests and callers with their own
     * snapshot): the caller supplies the nine hotbar slots (copies that will no longer be modified), the
     * selected slot and the potion modifier.
     */
    public ToolSet(ItemStack[] hotbarSnapshot, int selectedSlot,
                   boolean ignoreBreakingProtection, double potionAmplifier) {
        this.breakStrengthCache = new HashMap<>();
        this.hotbar = hotbarSnapshot.clone();
        this.selectedSlot = selectedSlot;
        this.ignoreBreakingProtection = ignoreBreakingProtection;

        NavSettings settings = NavSettings.get();
        this.autoTool = settings.autoTool;
        this.useSwordToMine = settings.useSwordToMine;
        this.itemSaver = settings.itemSaver;
        this.itemSaverThreshold = settings.itemSaverThreshold;
        this.blocksToAvoidBreaking = List.copyOf(settings.blocksToAvoidBreaking());
        this.avoidBreakingMultiplier = settings.avoidBreakingMultiplier;

        if (potionAmplifier != 1.0) {
            Function<Double, Double> amplify = x -> potionAmplifier * x;
            backendCalculation = amplify.compose(this::getBestDestructionTime);
        } else {
            backendCalculation = this::getBestDestructionTime;
        }
    }

    /** Copy the nine hotbar slots one by one (called on the main thread; workers then read only the copies). */
    private static ItemStack[] snapshotHotbar(ServerPlayer player) {
        ItemStack[] hotbar = new ItemStack[9];
        for (int i = 0; i < 9; i++) {
            hotbar[i] = player.getInventory().getItem(i).copy();
        }
        return hotbar;
    }

    /**
     * Speed of mining this block with the best hotbar tool (1/mining ticks).
     * Negative if unbreakable.
     */
    public double getStrVsBlock(BlockState state) {
        return breakStrengthCache.computeIfAbsent(state.getBlock(), backendCalculation);
    }

    /**
     * Material cheapness rank: material item tags (planks/cobblestone/iron ingot...) ordered from cheap to
     * expensive; returns the index of the matching tag, or -1 if none matches (tools themselves are not in
     * material tags, so this is usually -1 and on equal speed the first slot encountered keeps winning).
     */
    private static final List<TagKey<Item>> MATERIAL_TAGS_PRIORITY = List.of(
            materialTag("wooden_tool_materials"),
            materialTag("stone_tool_materials"),
            materialTag("iron_tool_materials"),
            materialTag("gold_tool_materials"),
            materialTag("diamond_tool_materials"),
            materialTag("netherite_tool_materials")
    );

    private static TagKey<Item> materialTag(String name) {
        return TagKey.create(net.minecraft.core.registries.Registries.ITEM,
                net.minecraft.resources.ResourceLocation.withDefaultNamespace(name));
    }

    private static int getMaterialCost(ItemStack itemStack) {
        for (int i = 0; i < MATERIAL_TAGS_PRIORITY.size(); i++) {
            if (itemStack.is(MATERIAL_TAGS_PRIORITY.get(i))) {
                return i;
            }
        }
        return -1;
    }

    /** Whether the item is a weapon (sword/axe/trident/mace). */
    private static boolean isWeapon(ItemStack itemStack) {
        Item item = itemStack.getItem();
        return item instanceof SwordItem || item instanceof AxeItem
                || item instanceof TridentItem || item instanceof MaceItem;
    }

    /** Whether the item has the Silk Touch enchantment. */
    public boolean hasSilkTouch(ItemStack stack) {
        ItemEnchantments enchantments = stack.getEnchantments();
        for (Holder<Enchantment> enchant : enchantments.keySet()) {
            if (enchant.is(Enchantments.SILK_TOUCH) && enchantments.getLevel(enchant) > 0) {
                return true;
            }
        }
        return false;
    }

    public int getBestSlot(Block b, boolean preferSilkTouch) {
        return getBestSlot(b, preferSilkTouch, false);
    }

    /**
     * Best of the 9 hotbar slots for mining this block (from the construction-time snapshot). Highest speed
     * wins; on equal speed prefer the cheaper material, or Silk Touch with {@code preferSilkTouch}. With
     * autoTool off and used for costing, returns the held slot from construction (so the path cost reflects
     * the tool that will actually be used).
     */
    public int getBestSlot(Block b, boolean preferSilkTouch, boolean pathingCalculation) {
        if (!autoTool && pathingCalculation) {
            return selectedSlot;
        }

        int best = 0;
        double highestSpeed = Double.NEGATIVE_INFINITY;
        int lowestCost = Integer.MIN_VALUE;
        boolean bestSilkTouch = false;
        BlockState blockState = b.defaultBlockState();
        for (int i = 0; i < 9; i++) {
            ItemStack itemStack = hotbar[i];
            if (!useSwordToMine && isWeapon(itemStack)) {
                continue;
            }
            if (itemSaver
                    && itemStack.getDamageValue() + itemSaverThreshold >= itemStack.getMaxDamage()
                    && itemStack.getMaxDamage() > 1) {
                continue;
            }
            double speed = calculateSpeedVsBlock(itemStack, blockState);
            boolean silkTouch = hasSilkTouch(itemStack);
            if (speed > highestSpeed) {
                highestSpeed = speed;
                best = i;
                lowestCost = getMaterialCost(itemStack);
                bestSilkTouch = silkTouch;
            } else if (speed == highestSpeed) {
                int cost = getMaterialCost(itemStack);
                if ((cost < lowestCost && (silkTouch || !bestSilkTouch))
                        || (preferSilkTouch && !bestSilkTouch && silkTouch)) {
                    highestSpeed = speed;
                    best = i;
                    lowestCost = cost;
                    bestSilkTouch = silkTouch;
                }
            }
        }
        return best;
    }

    /** Speed of mining this block with the best slot's tool (protected-block modifier applied). */
    private double getBestDestructionTime(Block b) {
        ItemStack stack = hotbar[getBestSlot(b, false, true)];
        return calculateSpeedVsBlock(stack, b.defaultBlockState()) * avoidanceMultiplier(b);
    }

    /**
     * Protected functional blocks (crafting table/furnace/chest etc.) have their speed multiplied by 0.1,
     * i.e. mining cost x10; disabled under forced break semantics.
     */
    private double avoidanceMultiplier(Block b) {
        if (ignoreBreakingProtection) {
            return 1;
        }
        return blocksToAvoidBreaking.contains(b) ? avoidBreakingMultiplier : 1;
    }

    /**
     * Speed of mining the given block with the given item (1/mining ticks).
     * hardness &lt; 0 (bedrock and the like) returns -1, meaning unbreakable.
     * When speed &gt; 1, the Efficiency enchantment bonus is added; after dividing by hardness, divide by 30
     * for the correct tool (or when no correct tool is needed) and by 100 for a wrong tool.
     */
    public static double calculateSpeedVsBlock(ItemStack item, BlockState state) {
        float hardness;
        try {
            hardness = state.getDestroySpeed(null, null);
        } catch (NullPointerException npe) {
            // Odd blocks whose hardness cannot be read are treated as unbreakable
            return -1;
        }
        if (hardness < 0) {
            return -1;
        }

        float speed = item.getDestroySpeed(state);
        if (speed > 1) {
            ItemEnchantments itemEnchantments = item.getEnchantments();
            OUTER:
            for (Holder<Enchantment> enchant : itemEnchantments.keySet()) {
                List<EnchantmentAttributeEffect> effects =
                        enchant.value().getEffects(EnchantmentEffectComponents.ATTRIBUTES);
                for (EnchantmentAttributeEffect e : effects) {
                    if (e.attribute().is(Attributes.MINING_EFFICIENCY.unwrapKey().orElseThrow())) {
                        speed += e.amount().calculate(itemEnchantments.getLevel(enchant));
                        break OUTER;
                    }
                }
            }
        }

        speed /= hardness;
        if (!state.requiresCorrectToolForDrops() || (!item.isEmpty() && item.isCorrectToolForDrops(state))) {
            return speed / 30;
        } else {
            return speed / 100;
        }
    }

    /** Haste / Mining Fatigue modifier on mining speed (sampled on the main thread at construction). */
    private static double potionAmplifier(ServerPlayer player) {
        double speed = 1;
        if (player.hasEffect(MobEffects.DIG_SPEED)) {
            speed *= 1 + (player.getEffect(MobEffects.DIG_SPEED).getAmplifier() + 1) * 0.2;
        }
        if (player.hasEffect(MobEffects.DIG_SLOWDOWN)) {
            switch (player.getEffect(MobEffects.DIG_SLOWDOWN).getAmplifier()) {
                case 0:
                    speed *= 0.3;
                    break;
                case 1:
                    speed *= 0.09;
                    break;
                case 2:
                    speed *= 0.0027; // vanilla uses 0.0027, not 0.027
                    break;
                default:
                    speed *= 0.00081;
                    break;
            }
        }
        return speed;
    }
}
