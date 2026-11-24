package dev.mcagent.runtime.core.pathing.moves;

import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import it.unimi.dsi.fastutil.longs.LongSet;
import it.unimi.dsi.fastutil.longs.LongSets;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Regression pins for the mining/placement protection rules, on the real cost functions:
 * <ul>
 *   <li>Functional block soft penalty: a chest (in the default NavSettings.blocksToAvoidBreaking list)
 *       costs x10 (a finite price; it is still broken when there is no other way);</li>
 *   <li>do_not_break tag members cost INF under any switch: the single source of truth for hard mining bans.
 *       This pins the <b>mechanism</b> (a block declared by the test is bound into the tag manually);
 *       the default members (beds/doors/trapdoors/fence gates) live in ModBlockTagData and are pinned
 *       separately by ModBlockTagDataTest;</li>
 *   <li>sacred (the navigation's own target cells) is always INF;</li>
 *   <li>an ordinary block (dirt) on the same terrain has a finite price, proving that the protection, not
 *       something else, raises the edge cost;</li>
 *   <li>placement on a deniedPlace cell costs INF; stone can be a placement face (the predicate shared by
 *       plan and execute).</li>
 * </ul>
 * Requires the MC registries; skipped rather than failed when headless bootstrap fails.
 */
@Tag("mc")
class ProtectionPinsTest {

    private static final BlockPos SRC = new BlockPos(0, 64, 0);

    private static boolean booted;
    private static ServerPlayer player;

    private boolean savedConsiderPotions;
    private boolean savedAllowWaterBucketFall;

    @BeforeAll
    static void boot() {
        try {
            net.minecraft.SharedConstants.tryDetectVersion();
            net.minecraft.server.Bootstrap.bootStrap();
            player = allocatePlayer();
            booted = true;
        } catch (Throwable t) {
            booted = false; // environment cannot bootstrap: skip, do not fail
        }
    }

    /** Allocate a ServerPlayer without a constructor; inject real inventory and food data (as MovementCostsTest). */
    private static ServerPlayer allocatePlayer() throws Exception {
        Field theUnsafe = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
        theUnsafe.setAccessible(true);
        sun.misc.Unsafe unsafe = (sun.misc.Unsafe) theUnsafe.get(null);
        ServerPlayer p = (ServerPlayer) unsafe.allocateInstance(ServerPlayer.class);
        Field inventory = Player.class.getDeclaredField("inventory");
        inventory.setAccessible(true);
        inventory.set(p, new Inventory(p));
        Field foodData = Player.class.getDeclaredField("foodData");
        foodData.setAccessible(true);
        foodData.set(p, new FoodData());
        // Abilities and health: the cost functions read both (a free-materials profile always has
        // scaffolding, a no-hunger profile ignores the food threshold, the fall limit is derived from
        // health), and both are null in the bare shell. Inject real objects, as for inventory and food data.
        Field abilities = Player.class.getDeclaredField("abilities");
        abilities.setAccessible(true);
        abilities.set(p, new net.minecraft.world.entity.player.Abilities());   // default survival profile
        Field entityData = net.minecraft.world.entity.Entity.class.getDeclaredField("entityData");
        entityData.setAccessible(true);
        // In 1.21.x SynchedEntityData is assembled by a Builder, and build() checks that every id is
        // defined, so defining only health throws immediately. Complete the definition table exactly as the
        // Entity constructor does: the eight base entries are hard-coded in the constructor (not in
        // defineSynchedData), and the rest come from each level's defineSynchedData (those implementations
        // only call builder.define and do not touch instance state). The result is the real definition table.
        net.minecraft.network.syncher.SynchedEntityData.Builder builder =
                new net.minecraft.network.syncher.SynchedEntityData.Builder(p);
        builder.define(dataKey(net.minecraft.world.entity.Entity.class, "DATA_SHARED_FLAGS_ID"),
                (byte) 0);
        builder.define(dataKey(net.minecraft.world.entity.Entity.class, "DATA_AIR_SUPPLY_ID"),
                net.minecraft.world.entity.Entity.TOTAL_AIR_SUPPLY);
        builder.define(dataKey(net.minecraft.world.entity.Entity.class, "DATA_CUSTOM_NAME_VISIBLE"),
                false);
        builder.define(dataKey(net.minecraft.world.entity.Entity.class, "DATA_CUSTOM_NAME"),
                java.util.Optional.<net.minecraft.network.chat.Component>empty());
        builder.define(dataKey(net.minecraft.world.entity.Entity.class, "DATA_SILENT"), false);
        builder.define(dataKey(net.minecraft.world.entity.Entity.class, "DATA_NO_GRAVITY"), false);
        builder.define(dataKey(net.minecraft.world.entity.Entity.class, "DATA_POSE"),
                net.minecraft.world.entity.Pose.STANDING);
        builder.define(dataKey(net.minecraft.world.entity.Entity.class, "DATA_TICKS_FROZEN"), 0);
        java.lang.reflect.Method defineSynched = net.minecraft.world.entity.Entity.class
                .getDeclaredMethod("defineSynchedData",
                        net.minecraft.network.syncher.SynchedEntityData.Builder.class);
        defineSynched.setAccessible(true);
        defineSynched.invoke(p, builder);
        net.minecraft.network.syncher.SynchedEntityData synched = builder.build();
        entityData.set(p, synched);
        synched.set(dataKey(net.minecraft.world.entity.LivingEntity.class, "DATA_HEALTH_ID"),
                20.0f);   // full health
        p.getInventory().items.set(0, new ItemStack(Items.DIRT));
        return p;
    }

    /** Read a vanilla synched data key (all are private static fields). */
    @SuppressWarnings("unchecked")
    private static <T> net.minecraft.network.syncher.EntityDataAccessor<T> dataKey(
            Class<?> owner, String field) throws Exception {
        Field f = owner.getDeclaredField(field);
        f.setAccessible(true);
        return (net.minecraft.network.syncher.EntityDataAccessor<T>) f.get(null);
    }

    @BeforeEach
    void setUp() {
        assumeTrue(booted, "Minecraft bootstrap unavailable, skipping protection pins");
        NavSettings s = NavSettings.get();
        savedConsiderPotions = s.considerPotionEffects;
        savedAllowWaterBucketFall = s.allowWaterBucketFall;
        // The bare shell player has no effect map or dimension; avoid the sampling paths that touch them
        s.considerPotionEffects = false;
        s.allowWaterBucketFall = false;
    }

    @AfterEach
    void tearDown() {
        NavSettings s = NavSettings.get();
        s.considerPotionEffects = savedConsiderPotions;
        s.allowWaterBucketFall = savedAllowWaterBucketFall;
    }

    // ==================== Fake world ====================

    /** Map-backed world view. */
    private static final class FakeView implements BlockGetter {
        final Map<BlockPos, BlockState> blocks = new HashMap<>();

        void set(BlockPos p, BlockState s) {
            blocks.put(p.immutable(), s);
        }

        void setChest(BlockPos p) {
            set(p, Blocks.CHEST.defaultBlockState());
        }

        @Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
        @Override public BlockState getBlockState(BlockPos pos) {
            return blocks.getOrDefault(pos, Blocks.AIR.defaultBlockState());
        }
        @Override public FluidState getFluidState(BlockPos pos) {
            return getBlockState(pos).getFluidState();
        }
        @Override public int getHeight() { return 384; }
        @Override public int getMinBuildHeight() { return -64; }
    }

    /** 5x5 stone floor around SRC, so every horizontal movement has footing. */
    private static FakeView floored() {
        FakeView v = new FakeView();
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                v.set(new BlockPos(SRC.getX() + dx, 63, SRC.getZ() + dz),
                        Blocks.STONE.defaultBlockState());
            }
        }
        return v;
    }

    private static CalculationContext context(FakeView view, LongSet sacred) {
        return new CalculationContext(player, view, ChunkLoadedTest.ALWAYS, false,
                sacred, LongSets.emptySet());
    }

    private static LongSet sacredOf(BlockPos pos) {
        LongSet set = new LongOpenHashSet();
        set.add(pos.asLong());
        return set;
    }

    // ==================== Mining protection ====================

    @Test
    void chestBreakIsSoftPenaltyButFinite() {
        BlockPos chest = SRC.north();
        FakeView v = floored();
        v.setChest(chest);
        // The chest is in the default NavSettings.blocksToAvoidBreaking list: x10 soft cost (finite)
        double soft = MovementHelper.getMiningDurationTicks(
                context(v, LongSets.emptySet()),
                chest.getX(), chest.getY(), chest.getZ(), false);
        assertTrue(soft > 0 && soft < COST_INF, "soft-penalized chest should have a finite cost, got " + soft);
        // Control: plain dirt has no soft penalty and must be clearly cheaper (the penalty really applies)
        BlockPos dirt = SRC.south();
        v.set(dirt, Blocks.DIRT.defaultBlockState());
        double plain = MovementHelper.getMiningDurationTicks(
                context(v, LongSets.emptySet()),
                dirt.getX(), dirt.getY(), dirt.getZ(), false);
        assertTrue(plain < soft, "soft penalty should cost more than a plain block, soft=" + soft + " plain=" + plain);
        // End to end: a north traverse (mining through the chest) yields a finite edge (not INF)
        double cost = Moves.TRAVERSE_NORTH.cost(context(v, LongSets.emptySet()),
                SRC.getX(), SRC.getY(), SRC.getZ());
        assertTrue(cost > 0 && cost < COST_INF, "traversing through a chest should have a finite cost, got " + cost);
    }

    @Test
    void doNotBreakTagHoldsInfinite() {
        // do_not_break hard ban. Tag contents come from data packs at runtime, and headless bootstrap loads
        // none, so bind a block declared by the test (stone, distinct from the chest soft list) manually,
        // as ScaffoldTagTestSupport does. This pins the mechanism; default members: see ModBlockTagDataTest.
        BlockPos stone = SRC.north();
        FakeView v = floored();
        v.set(stone, Blocks.STONE.defaultBlockState());
        bindBlockTags(java.util.Map.of(dev.mcagent.runtime.core.init.InitTag.DO_NOT_BREAK,
                java.util.List.of(net.minecraft.core.registries.BuiltInRegistries.BLOCK
                        .wrapAsHolder(Blocks.STONE))));
        try {
            assertTrue(MovementHelper.getMiningDurationTicks(
                    context(v, LongSets.emptySet()),
                    stone.getX(), stone.getY(), stone.getZ(), false) >= COST_INF,
                    "tag member should cost INF");
        } finally {
            bindBlockTags(java.util.Map.of());   // back to the headless bootstrap state: all block tags empty
        }
    }

    /** The same bindTags path vanilla data pack loading uses; production code has no test-only hook. */
    @SuppressWarnings("unchecked")
    private static void bindBlockTags(java.util.Map<net.minecraft.tags.TagKey<net.minecraft.world.level.block.Block>,
            java.util.List<net.minecraft.core.Holder<net.minecraft.world.level.block.Block>>> tags) {
        ((net.minecraft.core.MappedRegistry<net.minecraft.world.level.block.Block>)
                net.minecraft.core.registries.BuiltInRegistries.BLOCK).bindTags(tags);
    }

    @Test
    void sacredCellTurnsARoutableBreakInfinite() {
        BlockPos dirt = SRC.north();
        FakeView v = floored();
        v.set(dirt, Blocks.DIRT.defaultBlockState());
        // Unprotected: a dirt obstacle on the same terrain is finite (proving that sacred causes the INF below)
        double open = MovementHelper.getMiningDurationTicks(
                context(v, LongSets.emptySet()),
                dirt.getX(), dirt.getY(), dirt.getZ(), false);
        assertTrue(open > 0 && open < COST_INF, "unprotected dirt should have a finite cost, got " + open);
        // sacred: identical terrain, but the cell is the navigation's own target, so INF
        assertTrue(MovementHelper.getMiningDurationTicks(
                context(v, sacredOf(dirt)),
                dirt.getX(), dirt.getY(), dirt.getZ(), false) >= COST_INF);
    }

    // ==================== Placement protection / shared placement-face predicate ====================

    @Test
    void deniedAndSacredCellsRefusePlacement() {
        FakeView v = floored();
        BlockPos cell = SRC.north();
        // sacred cells cannot be buried
        CalculationContext sacredCtx = context(v, sacredOf(cell));
        assertEquals(COST_INF, sacredCtx.costOfPlacingAt(
                cell.getX(), cell.getY(), cell.getZ(), v.getBlockState(cell)));
        // deniedPlace cells (proved unsupported by the execution layer) cannot be planned for placement again
        LongSet denied = new LongOpenHashSet();
        denied.add(cell.asLong());
        CalculationContext deniedCtx = new CalculationContext(player, v, ChunkLoadedTest.ALWAYS,
                false, LongSets.emptySet(), denied);
        assertEquals(COST_INF, deniedCtx.costOfPlacingAt(
                cell.getX(), cell.getY(), cell.getZ(), v.getBlockState(cell)));
    }

    @Test
    void interactionPoseProtectionCompilesIntoImpossibleScaffoldCosts() {
        FakeView v = floored();
        BlockPos target = SRC.north();
        BlockPos support = target.east();
        BlockPos ordinary = SRC.south();
        GoalCompiler.Compiled compiled = GoalCompiler.interactionPoses(
                List.of(SRC.east()), List.of(target, support));
        CalculationContext ctx = context(v, compiled.sacred());

        assertEquals(COST_INF, ctx.costOfPlacingAt(
                target.getX(), target.getY(), target.getZ(), v.getBlockState(target)));
        assertEquals(COST_INF, ctx.costOfPlacingAt(
                support.getX(), support.getY(), support.getZ(), v.getBlockState(support)));
        assertTrue(ctx.costOfPlacingAt(
                        ordinary.getX(), ordinary.getY(), ordinary.getZ(),
                        v.getBlockState(ordinary)) < COST_INF,
                "an ordinary scaffold cell must remain placeable");
    }

    @Test
    void placementFacePredicateSharedRuler() {
        // A chest cannot be a placement face, nor can a fluid; a full solid block can
        assertFalse(MovementHelper.canPlaceAgainst(Blocks.CHEST.defaultBlockState()));
        assertFalse(MovementHelper.canPlaceAgainst(Blocks.WATER.defaultBlockState()));
        assertTrue(MovementHelper.canPlaceAgainst(Blocks.STONE.defaultBlockState()));
    }
}
