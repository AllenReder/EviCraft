package dev.mcagent.runtime.core.pathing.moves;

import dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials;
import dev.mcagent.runtime.core.pathing.execute.RouteMutation;
import dev.mcagent.runtime.core.pathing.execute.RouteMutationPolicy;
import java.util.List;

import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.core.pathing.util.BlockHelper;

import it.unimi.dsi.fastutil.longs.LongSet;
import it.unimi.dsi.fastutil.longs.LongSets;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.EnchantmentEffectComponents;
import net.minecraft.world.item.enchantment.Enchantments;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.item.enchantment.effects.EnchantmentAttributeEffect;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.border.WorldBorder;
import net.minecraft.world.phys.Vec3;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;

/**
 * World view and capability snapshot for one cost calculation/search. The constructor samples settings,
 * inventory and enchantment state into final fields, so every edge in one search is measured by the same
 * yardstick and a mid-search settings change cannot produce a self-contradictory path.
 *
 * <p>World reads go through the injected {@link BlockGetter} view + {@link ChunkLoadedTest} predicate.
 * Two semantic switches: {@code sacred} (the task's own target cells; never mined, never buried, cannot be
 * overridden) and {@code deniedPlace} (cells the execution layer proved cannot be placed on).
 */
public class CalculationContext {

    private static final ItemStack STACK_BUCKET_WATER = new ItemStack(Items.WATER_BUCKET);

    /** Whether the view is safe to read on a worker thread (true for a frozen snapshot, false for the live world). */
    public final boolean safeForThreadedUse;
    /**
     * Main-thread use only (execution-time state machine; stored into a Movement when it is assembled).
     * Thread-safety invariant: the cost path (cost/apply/assembly) must not dereference it to read live
     * state. Inventory/enchantments/hunger/potions are folded into final fields of this class and
     * {@link ToolSet} at construction, and the searcher samples the world border at its own construction.
     */
    public final ServerPlayer player;
    public final BlockGetter view;
    public final ChunkLoadedTest loadedTest;
    public final ToolSet toolSet;
    /** Whether the inventory holds scaffolding blocks (dirt/cobblestone/netherrack/stone). */
    public final boolean hasThrowaway;
    /** Hotbar has a water bucket and the dimension is not the Nether. */
    public final boolean hasWaterBucket;
    public final boolean canSprint;
    /** Cost of placing one block; read it through {@link #costOfPlacingAt}, not directly. */
    protected final double placeBlockCost;
    public final boolean allowBreak;
    public final List<Block> allowBreakAnyway;
    public final boolean allowParkour;
    public final boolean allowParkourPlace;
    public final boolean allowJumpAtBuildLimit;
    public final boolean allowParkourAscend;
    public final boolean assumeWalkOnWater;
    /** Always false; kept as a placeholder (falling into lava is never acceptable). */
    public final boolean allowFallIntoLava;
    /** Frost Walker level of the equipment; 0 if none. */
    public final int frostWalker;
    public final boolean allowDiagonalDescend;
    public final boolean allowDiagonalAscend;
    public final boolean allowDownward;
    /** Minimum fall height for fall movements. */
    public int minFallHeight;
    public int maxFallHeightNoWater;
    public final int maxFallHeightBucket;
    public final double fallDamageCostPerPoint;
    /** Cost per block walking in water (Depth Strider scales it towards the walking speed). */
    public final double waterWalkSpeed;
    public final double breakBlockAdditionalCost;
    public double backtrackCostFavoringCoefficient;
    public double jumpPenalty;
    public final double walkOnWaterOnePenalty;
    public final boolean allowPlaceInFluidsSource;
    public final boolean allowPlaceInFluidsFlow;

    /** Immutable task-scoped Route Mutation permission. */
    public final RouteMutationPolicy routeMutations;

    /** The task's own target cells (BlockPos.asLong keys): never mined or buried; cannot be overridden. */
    public final LongSet sacred;
    /** Cells the execution layer proved cannot be placed on (no support): placement cost is INF. */
    public final LongSet deniedPlace;

    /** World build height lower bound (inclusive) and upper bound (exclusive). */
    public final int worldBottom;
    public final int worldHeight;

    /**
     * World border snapshot (sampled on the main thread at construction). avoidBreaking uses its
     * {@code canPlaceAt(x,z)} to refuse mining outside the border.
     */
    public final WorldBorder worldBorder;
    /** Spawner avoidance centers captured with this immutable planning view. */
    public final List<BlockPos> spawnerAvoidanceCenters;
    /** Hostile entity centers captured with the same immutable World Knowledge Snapshot. */
    public final List<Vec3> entityAvoidanceCenters;

    /** Convenience constructor: live-world context without semantic switches. */
    public CalculationContext(ServerPlayer player, BlockGetter view, ChunkLoadedTest loadedTest,
                              boolean safeForThreadedUse) {
        this(player, view, loadedTest, safeForThreadedUse,
                LongSets.emptySet(), LongSets.emptySet(), RouteMutationPolicy.fullTraversal());
    }

    public CalculationContext(ServerPlayer player, BlockGetter view, ChunkLoadedTest loadedTest,
                              boolean safeForThreadedUse,
                              LongSet sacred, LongSet deniedPlace) {
        this(player, view, loadedTest, safeForThreadedUse, sacred, deniedPlace,
                RouteMutationPolicy.fullTraversal());
    }

    public CalculationContext(ServerPlayer player, BlockGetter view, ChunkLoadedTest loadedTest,
                              boolean safeForThreadedUse,
                              LongSet sacred, LongSet deniedPlace,
                              RouteMutationPolicy routeMutations) {
        this(player, view, loadedTest, safeForThreadedUse, sacred, deniedPlace,
                routeMutations, List.of(), List.of());
    }

    public CalculationContext(ServerPlayer player, BlockGetter view, ChunkLoadedTest loadedTest,
                              boolean safeForThreadedUse,
                              LongSet sacred, LongSet deniedPlace,
                              RouteMutationPolicy routeMutations,
                              List<BlockPos> spawnerAvoidanceCenters) {
        this(player, view, loadedTest, safeForThreadedUse, sacred, deniedPlace,
                routeMutations, spawnerAvoidanceCenters, List.of());
    }

    public CalculationContext(ServerPlayer player, BlockGetter view, ChunkLoadedTest loadedTest,
                              boolean safeForThreadedUse,
                              LongSet sacred, LongSet deniedPlace,
                              RouteMutationPolicy routeMutations,
                              List<BlockPos> spawnerAvoidanceCenters,
                              List<Vec3> entityAvoidanceCenters) {
        NavSettings settings = NavSettings.get();
        this.safeForThreadedUse = safeForThreadedUse;
        this.player = player;
        this.view = view;
        this.loadedTest = loadedTest;
        this.sacred = sacred;
        this.deniedPlace = deniedPlace;
        this.routeMutations = java.util.Objects.requireNonNull(routeMutations, "routeMutations");
        this.spawnerAvoidanceCenters = List.copyOf(
                java.util.Objects.requireNonNull(
                        spawnerAvoidanceCenters, "spawnerAvoidanceCenters"));
        this.entityAvoidanceCenters = List.copyOf(
                java.util.Objects.requireNonNull(
                        entityAvoidanceCenters, "entityAvoidanceCenters"));
        this.toolSet = new ToolSet(player);
        // A free-materials profile (creative) always has scaffolding: the execution layer supplies a stack
        // when selecting material (the code equivalent of taking it from the creative inventory), so the
        // planner may consider every route that needs placed blocks. Otherwise an empty-handed creative
        // Bot can dig into a pit it cannot climb out of (NO-PATH two blocks from the goal).
        this.hasThrowaway = settings.allowPlace
                && routeMutations.permits(RouteMutation.Kind.PLACE)
                && (hasGenericThrowaway(player, settings)
                || dev.mcagent.runtime.core.WorkProfile.of(player).freeMaterials());
        this.hasWaterBucket = settings.allowWaterBucketFall
                && hotbarHasWaterBucket(player)
                && player.level().dimension() != Level.NETHER;
        // A no-hunger profile (creative) ignores the food threshold; otherwise switching to creative at
        // food <= 6 would lock sprinting off permanently
        this.canSprint = settings.allowSprint
                && (!dev.mcagent.runtime.core.WorkProfile.of(player).hasHunger()
                        || player.getFoodData().getFoodLevel() > 6);
        this.placeBlockCost = settings.blockPlacementPenalty;
        this.allowBreak = settings.allowBreak;
        this.allowBreakAnyway = List.copyOf(settings.allowBreakAnyway());
        this.allowParkour = settings.allowParkour;
        this.allowParkourPlace = settings.allowParkourPlace
                && routeMutations.permits(RouteMutation.Kind.PLACE);
        this.allowJumpAtBuildLimit = settings.allowJumpAtBuildLimit;
        this.allowParkourAscend = settings.allowParkourAscend;
        this.assumeWalkOnWater = settings.assumeWalkOnWater;
        this.allowFallIntoLava = false;
        this.frostWalker = equipmentEnchantLevel(player);
        this.allowDiagonalDescend = settings.allowDiagonalDescend;
        this.allowDiagonalAscend = settings.allowDiagonalAscend;
        this.allowDownward = settings.allowDownward;
        this.minFallHeight = 3;
        // The fall limit is not fixed: any non-lethal height is a valid route, just a painful one. Vanilla
        // fall damage = height - 3 (half a heart per block); derive the survivable height from current
        // health with a 3-heart (6 point) safety margin. The setting acts as the lower bound.
        int survivableFall = 3 + Math.max(0, (int) ((player.getHealth() - 6.0f) / 1.0f));
        this.maxFallHeightNoWater = Math.min(12,
                Math.max(settings.maxFallHeightNoWater, survivableFall));
        this.maxFallHeightBucket = settings.maxFallHeightBucket;
        this.fallDamageCostPerPoint = settings.fallDamageCostPerPoint;
        this.waterWalkSpeed = computeWaterWalkSpeed(player);
        this.breakBlockAdditionalCost = settings.blockBreakAdditionalPenalty;
        this.backtrackCostFavoringCoefficient = settings.backtrackCostFavoringCoefficient;
        this.jumpPenalty = settings.jumpPenalty;
        this.walkOnWaterOnePenalty = settings.walkOnWaterOnePenalty;
        this.allowPlaceInFluidsSource = settings.allowPlaceInFluidsSource;
        this.allowPlaceInFluidsFlow = settings.allowPlaceInFluidsFlow;
        this.worldBottom = view.getMinBuildHeight();
        this.worldHeight = view.getMaxBuildHeight();
        WorldBorder border = null;
        if (player != null) {
            try {
                border = player.level() != null ? player.level().getWorldBorder() : null;
            } catch (NullPointerException ignored) {
                // Test stub players have no level field: no world border, treated as unrestricted
            }
        }
        this.worldBorder = border;
    }

    /**
     * Whether the player holds scaffolding blocks. Checks the hotbar (0-8) and the offhand; the main
     * inventory (9-35) is checked only when {@code allowInventory} is enabled.
     */
    private static boolean hasGenericThrowaway(ServerPlayer player, NavSettings settings) {
        List<net.minecraft.world.item.Item> acceptable = ScaffoldMaterials.of(player);
        var inv = player.getInventory();
        for (int i = 0; i < 9; i++) {
            ItemStack stack = inv.getItem(i);
            if (!stack.isEmpty() && acceptable.contains(stack.getItem())) {
                return true;
            }
        }
        ItemStack offhand = player.getItemBySlot(EquipmentSlot.OFFHAND);
        if (!offhand.isEmpty() && acceptable.contains(offhand.getItem())) {
            // Offhand scaffolding is only usable if the main hand can switch to a slot with no right-click
            // use (empty, or a mining tool with the TOOL component); otherwise right-click goes to the main
            // hand and the offhand block is never placed
            for (int i = 0; i < 9; i++) {
                ItemStack stack = inv.getItem(i);
                if (stack.isEmpty() || stack.getItem().components()
                        .has(net.minecraft.core.component.DataComponents.TOOL)) {
                    return true;
                }
            }
        }
        if (settings.allowInventory) {
            for (int i = 9; i < 36; i++) {
                ItemStack stack = inv.getItem(i);
                if (!stack.isEmpty() && acceptable.contains(stack.getItem())) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Whether the hotbar holds a water bucket (same item and components). */
    private static boolean hotbarHasWaterBucket(ServerPlayer player) {
        return net.minecraft.world.entity.player.Inventory.isHotbarSlot(
                player.getInventory().findSlotMatchingItem(STACK_BUCKET_WATER));
    }

    /** Frost Walker level of the last enchanted item in equipment-slot iteration order. */
    private static int equipmentEnchantLevel(ServerPlayer player) {
        int level = 0;
        for (EquipmentSlot slot : EquipmentSlot.values()) {
            ItemEnchantments itemEnchantments = player.getItemBySlot(slot).getEnchantments();
            for (Holder<Enchantment> enchant : itemEnchantments.keySet()) {
                if (enchant.is(Enchantments.FROST_WALKER)) {
                    level = itemEnchantments.getLevel(enchant);
                }
            }
        }
        return level;
    }

    /** Interpolate the in-water walking speed between water and land speed by the Depth Strider level. */
    private static double computeWaterWalkSpeed(ServerPlayer player) {
        float waterSpeedMultiplier = 1.0f;
        OUTER:
        for (EquipmentSlot slot : EquipmentSlot.values()) {
            ItemEnchantments itemEnchantments = player.getItemBySlot(slot).getEnchantments();
            for (Holder<Enchantment> enchant : itemEnchantments.keySet()) {
                List<EnchantmentAttributeEffect> effects =
                        enchant.value().getEffects(EnchantmentEffectComponents.ATTRIBUTES);
                for (EnchantmentAttributeEffect effect : effects) {
                    if (effect.attribute().is(Attributes.WATER_MOVEMENT_EFFICIENCY.unwrapKey().orElseThrow())) {
                        waterSpeedMultiplier = effect.amount().calculate(itemEnchantments.getLevel(enchant));
                        break OUTER;
                    }
                }
            }
        }
        return ActionCosts.WALK_ONE_IN_WATER_COST * (1 - waterSpeedMultiplier)
                + ActionCosts.WALK_ONE_BLOCK_COST * waterSpeedMultiplier;
    }

    // ==================== World reads ====================

    /** Single-threaded cursor avoiding a BlockPos allocation per read (domain callbacks run on one thread). */
    private final BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();

    public BlockState get(int x, int y, int z) {
        return view.getBlockState(cursor.set(x, y, z));
    }

    public BlockState get(BlockPos pos) {
        return view.getBlockState(pos);
    }

    public Block getBlock(int x, int y, int z) {
        return get(x, y, z).getBlock();
    }

    public boolean isLoaded(int x, int z) {
        return loadedTest.isLoaded(x, z);
    }

    // ==================== Cost functions ====================

    /**
     * Cost of placing a block at (x,y,z). INF when there is no scaffolding, the cell is sacred/denied, it
     * touches the world border (border cells cannot be placed against), or fluid rules forbid it;
     * otherwise the placement penalty.
     */
    public double costOfPlacingAt(int x, int y, int z, BlockState current) {
        if (!permitsPlaceAt(x, y, z)) {
            return COST_INF;
        }
        if (!hasThrowaway) { // already includes the allowPlace check from construction
            return COST_INF;
        }
        long key = BlockPos.asLong(x, y, z);
        if (sacred.contains(key) || deniedPlace.contains(key)) {
            return COST_INF;
        }
        if (!MovementHelper.placeableWithinBorder(worldBorder, x, z)) {
            return COST_INF;
        }
        if (!allowPlaceInFluidsSource && current.getFluidState().isSource()) {
            return COST_INF;
        }
        if (!allowPlaceInFluidsFlow && !current.getFluidState().isEmpty()
                && !current.getFluidState().isSource()) {
            return COST_INF;
        }
        return placeBlockCost;
    }

    /** Dedicated cursor for the mining protection check (separate from {@link #cursor} so they never clash). */
    private final BlockPos.MutableBlockPos protectionCursor = new BlockPos.MutableBlockPos();

    /**
     * Cost multiplier for mining (x,y,z). Bans, from strictest to loosest:
     * <ol>
     *   <li>sacred (the task's own target cells) is always INF; no switch can override it;</li>
     *   <li>members of the do_not_break tag (by default facilities: beds/doors/trapdoors/fence gates;
     *       data packs may add more) are INF; no switch can lift it;</li>
     *   <li>master switch {@code allowBreak} off and the block not on the exception list: INF.</li>
     * </ol>
     * The x10 soft penalty for functional blocks (crafting table/furnace/chest etc.) is implemented by
     * {@link ToolSet}'s {@code avoidanceMultiplier} (NavSettings.blocksToAvoidBreaking) in
     * {@code getStrVsBlock}, not here.
     */
    public double breakCostMultiplierAt(int x, int y, int z, BlockState current) {
        if (!permitsBreakAt(x, y, z)) {
            return COST_INF;
        }
        if (sacred.contains(BlockPos.asLong(x, y, z))) {
            return COST_INF;
        }
        if (BlockHelper.shouldAvoidBreaking(view, protectionCursor.set(x, y, z))) {
            return COST_INF;
        }
        if (!allowBreak && !allowBreakAnyway.contains(current.getBlock())) {
            return COST_INF;
        }
        return 1;
    }

    protected final boolean permitsPlaceAt(int x, int y, int z) {
        return routeMutations.permits(new RouteMutation.Place(new BlockPos(x, y, z)));
    }

    protected final boolean permitsBreakAt(int x, int y, int z) {
        return routeMutations.permits(new RouteMutation.Break(new BlockPos(x, y, z)));
    }

    /** Cost of placing a water bucket mid-fall (same as the placement penalty). */
    public double placeBucketCost() {
        return placeBlockCost;
    }
}
