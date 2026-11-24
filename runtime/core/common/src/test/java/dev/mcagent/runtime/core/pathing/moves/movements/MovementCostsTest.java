package dev.mcagent.runtime.core.pathing.moves.movements;

import java.lang.reflect.Field;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Map;

import dev.mcagent.runtime.core.pathing.execute.RouteMutation;
import dev.mcagent.runtime.core.pathing.execute.RouteMutationPolicy;
import dev.mcagent.runtime.core.pathing.moves.ActionCosts;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.ChunkLoadedTest;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Pins key values of the movement primitive cost functions: on a fake block map, checks the exact costs of
 * traverse (sprint/walk), ascend, descend, diagonal, pillar and dig-down, and that parkour produces nothing
 * when its switch is off. Requires the MC registries; skipped rather than failed when headless bootstrap
 * fails.
 *
 * <p>The player is a bare shell allocated without a constructor, with inventory and food data injected via
 * reflection: the cost functions read only the inventory/food/enchantment snapshot through
 * CalculationContext and touch no other entity state.
 */
@Tag("mc")
class MovementCostsTest {

    private static final double EPS = 1e-3;
    private static final BlockPos SRC = new BlockPos(0, 64, 0);

    private static boolean booted;
    private static ServerPlayer player;

    /** Settings modified by this test, restored after each test. */
    private boolean savedConsiderPotions;
    private boolean savedAllowWaterBucketFall;
    private boolean savedAllowSprint;
    private boolean savedAllowPlace;
    private boolean savedAllowBreak;
    private boolean savedAllowParkour;

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

    /** Allocate a ServerPlayer without a constructor and inject real inventory and food data. */
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
        foodData.set(p, new FoodData()); // full food: can sprint
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
        // A stack of dirt in the hotbar gives both the scaffolding check and bare-hand tool selection a
        // definite item
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
        assumeTrue(booted, "Minecraft bootstrap unavailable, skipping cost pins");
        NavSettings s = NavSettings.get();
        savedConsiderPotions = s.considerPotionEffects;
        savedAllowWaterBucketFall = s.allowWaterBucketFall;
        savedAllowSprint = s.allowSprint;
        savedAllowPlace = s.allowPlace;
        savedAllowBreak = s.allowBreak;
        savedAllowParkour = s.allowParkour;
        // The bare shell player has no effect map or dimension; avoid the sampling paths that touch them
        s.considerPotionEffects = false;
        s.allowWaterBucketFall = false;
        s.allowSprint = true;
        s.allowPlace = true;
        s.allowBreak = true;
    }

    @AfterEach
    void tearDown() {
        NavSettings s = NavSettings.get();
        s.considerPotionEffects = savedConsiderPotions;
        s.allowWaterBucketFall = savedAllowWaterBucketFall;
        s.allowSprint = savedAllowSprint;
        s.allowPlace = savedAllowPlace;
        s.allowBreak = savedAllowBreak;
        s.allowParkour = savedAllowParkour;
    }

    // ==================== Fake world ====================

    /** Map-backed world view; air by default. */
    private static final class FakeView implements BlockGetter {
        final Map<BlockPos, BlockState> blocks = new HashMap<>();

        void set(int x, int y, int z, BlockState state) {
            blocks.put(new BlockPos(x, y, z), state);
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

    /** 5x5 stone floor around SRC (underfoot at y=63). */
    private static FakeView floored() {
        FakeView v = new FakeView();
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                v.set(SRC.getX() + dx, 63, SRC.getZ() + dz, Blocks.STONE.defaultBlockState());
            }
        }
        return v;
    }

    private static CalculationContext context(FakeView view) {
        return new CalculationContext(player, view, ChunkLoadedTest.ALWAYS, true);
    }

    private static CalculationContext context(
            FakeView view, RouteMutationPolicy routeMutations) {
        return new CalculationContext(player, view, ChunkLoadedTest.ALWAYS, true,
                it.unimi.dsi.fastutil.longs.LongSets.emptySet(),
                it.unimi.dsi.fastutil.longs.LongSets.emptySet(), routeMutations);
    }

    @Test
    void fallRetainsBucketPlanAcrossUnknownRecostAndUpdatesFromKnownWater() throws Exception {
        String dimension = "minecraft:overworld";
        BlockPos dest = new BlockPos(1, 50, 0);
        var observations = new java.util.ArrayList<dev.mcagent.runtime.evidence.BlockObservation>();
        for (int y = 50; y <= 65; y++) {
            observations.add(dev.mcagent.runtime.evidence.BlockObservation.knownAir(
                    new BlockPos(1, y, 0), dev.mcagent.runtime.evidence.BlockEvidenceSource.VISION));
        }
        observations.add(dev.mcagent.runtime.evidence.BlockObservation.of(dest.below(),
                Blocks.STONE.defaultBlockState(), dev.mcagent.runtime.evidence.BlockEvidenceSource.VISION));
        observations.add(dev.mcagent.runtime.evidence.BlockObservation.of(SRC.below(),
                Blocks.STONE.defaultBlockState(), dev.mcagent.runtime.evidence.BlockEvidenceSource.VISION));
        for (var direction : Direction.Plane.HORIZONTAL) {
            observations.add(dev.mcagent.runtime.evidence.BlockObservation.knownAir(
                    dest.relative(direction), dev.mcagent.runtime.evidence.BlockEvidenceSource.VISION));
        }
        var store = new dev.mcagent.runtime.evidence.BlockEvidenceStore();
        store.publishFrame(dimension, 1, observations);
        var fall = new MovementFall(player, SRC, dest);
        CalculationContext known = bucketContext(store.snapshot(dimension, SRC, 32));
        assertTrue(fall.getCost(known) < ActionCosts.COST_INF);
        assertTrue(fall.willPlaceBucket());

        var empty = new dev.mcagent.runtime.evidence.BlockEvidenceStore();
        CalculationContext unknown = bucketContext(empty.snapshot(dimension, SRC, 32));
        assertTrue(fall.recalculateCost(unknown) >= ActionCosts.COST_INF);
        assertTrue(fall.willPlaceBucket(), "unknown space must not cancel the planned bucket");

        store.publishFrame(dimension, 2, java.util.List.of(
                dev.mcagent.runtime.evidence.BlockObservation.of(dest,
                        Blocks.WATER.defaultBlockState(),
                        dev.mcagent.runtime.evidence.BlockEvidenceSource.VISION)));
        assertTrue(fall.recalculateCost(bucketContext(store.snapshot(dimension, SRC, 32))) < ActionCosts.COST_INF);
        org.junit.jupiter.api.Assertions.assertFalse(fall.willPlaceBucket());
    }

    private static CalculationContext bucketContext(dev.mcagent.runtime.evidence.BlockEvidenceSnapshot snapshot)
            throws Exception {
        var view = new dev.mcagent.runtime.core.pathing.cache.EmbodiedNavView(snapshot, -64, 384);
        var context = new CalculationContext(player, view, ChunkLoadedTest.ALWAYS, false);
        // The fixture has no Level; supply the already-sampled inventory fact directly.
        Field bucket = CalculationContext.class.getField("hasWaterBucket");
        bucket.setAccessible(true);
        bucket.setBoolean(context, true);
        return context;
    }

    // ==================== Traverse ====================

    @Test
    void traverseFlatSprintCosts3_5638() {
        CalculationContext ctx = context(floored());
        double cost = MovementTraverse.cost(ctx, 0, 64, 0, 1, 0);
        assertEquals(3.5638, cost, EPS);
        assertEquals(ActionCosts.SPRINT_ONE_BLOCK_COST, cost, 1e-9);
    }

    @Test
    void traverseFlatWalkCosts4_6329() {
        NavSettings.get().allowSprint = false;
        CalculationContext ctx = context(floored());
        double cost = MovementTraverse.cost(ctx, 0, 64, 0, 1, 0);
        assertEquals(4.6329, cost, EPS);
        assertEquals(ActionCosts.WALK_ONE_BLOCK_COST, cost, 1e-9);
    }

    @Test
    void traverseThroughClosedDoorRequiresOpenPermission() {
        FakeView view = floored();
        view.set(1, 64, 0, Blocks.OAK_DOOR.defaultBlockState());

        double denied = MovementTraverse.cost(context(view, RouteMutationPolicy.of(
                EnumSet.noneOf(RouteMutation.Kind.class))),
                0, 64, 0, 1, 0);
        double allowed = MovementTraverse.cost(context(view, RouteMutationPolicy.of(
                EnumSet.of(RouteMutation.Kind.OPEN))), 0, 64, 0, 1, 0);

        assertTrue(denied >= ActionCosts.COST_INF);
        assertTrue(allowed < ActionCosts.COST_INF);
    }

    @Test
    void traverseThroughWallRequiresBreakPermission() {
        FakeView view = floored();
        view.set(1, 64, 0, Blocks.DIRT.defaultBlockState());

        double denied = MovementTraverse.cost(context(view, RouteMutationPolicy.of(
                EnumSet.of(RouteMutation.Kind.OPEN, RouteMutation.Kind.PLACE))),
                0, 64, 0, 1, 0);
        double allowed = MovementTraverse.cost(context(view, RouteMutationPolicy.of(
                EnumSet.of(RouteMutation.Kind.BREAK))), 0, 64, 0, 1, 0);

        assertTrue(denied >= ActionCosts.COST_INF);
        assertTrue(allowed < ActionCosts.COST_INF);
    }

    @Test
    void traverseAcrossGapRequiresPlacePermission() {
        FakeView view = floored();
        view.set(1, 63, 0, Blocks.AIR.defaultBlockState());

        double denied = MovementTraverse.cost(context(view, RouteMutationPolicy.of(
                EnumSet.of(RouteMutation.Kind.OPEN, RouteMutation.Kind.BREAK))),
                0, 64, 0, 1, 0);
        double allowed = MovementTraverse.cost(context(view, RouteMutationPolicy.of(
                EnumSet.of(RouteMutation.Kind.PLACE))), 0, 64, 0, 1, 0);

        assertTrue(denied >= ActionCosts.COST_INF);
        assertTrue(allowed < ActionCosts.COST_INF);
    }

    // ==================== Ascend ====================

    @Test
    void ascendFlatCostsWalkPlusJumpPenalty() {
        FakeView v = floored();
        v.set(1, 64, 0, Blocks.STONE.defaultBlockState()); // landing step one block up
        CalculationContext ctx = context(v);
        double cost = MovementAscend.cost(ctx, 0, 64, 0, 1, 0);
        // max(jump time, walk one block) + jump penalty = 4.63285 + 2
        assertEquals(4.63285 + 2, cost, EPS);
    }

    // ==================== Descend ====================

    @Test
    void descendFlatCostsWalkOffPlusFallOne() {
        FakeView v = new FakeView();
        v.set(0, 63, 0, Blocks.STONE.defaultBlockState()); // start floor
        v.set(1, 62, 0, Blocks.STONE.defaultBlockState()); // landing floor one block lower
        CalculationContext ctx = context(v);
        MutableMoveResult res = new MutableMoveResult();
        MovementDescend.cost(ctx, 0, 64, 0, 1, 0, res);
        assertEquals(63, res.y, "landing should be exactly one cell lower (descend, not fall)");
        assertEquals(3.70628 + 5.6147, res.cost, EPS);
    }

    // ==================== Diagonal ====================

    @Test
    void diagonalFlatSprintCosts5_0397() {
        CalculationContext ctx = context(floored());
        MutableMoveResult res = new MutableMoveResult();
        MovementDiagonal.cost(ctx, 0, 64, 0, 1, 1, res);
        assertEquals(64, res.y, "same-level diagonal landing should be at the same height");
        assertEquals(5.0397, res.cost, EPS);
    }

    // ==================== Pillar ====================

    @Test
    void pillarFlatCostsJumpPlusPlacePlusPenalty() {
        CalculationContext ctx = context(floored());
        double cost = MovementPillar.cost(ctx, 0, 64, 0);
        // jump 3.1634 + placement penalty 20 + jump penalty 2; nothing overhead, so no mining
        assertEquals(25.1634, cost, EPS);
    }

    @Test
    void pillarWithDirtOverheadAddsMiningTicks() {
        FakeView v = floored();
        v.set(0, 66, 0, Blocks.DIRT.defaultBlockState()); // dirt two blocks overhead
        CalculationContext ctx = context(v);
        double cost = MovementPillar.cost(ctx, 0, 64, 0);
        // Mining dirt bare-handed (holding a dirt item): hardness 0.5 -> 1/(2/30) = 15 ticks, plus the extra
        // mining penalty. The penalty is read from settings: this pins the cost composition, while the
        // penalty's size is NavSettings' decision.
        assertEquals(25.1634 + 15 + NavSettings.get().blockBreakAdditionalPenalty, cost, EPS);
    }

    // ==================== Dig down ====================

    @Test
    void downwardThroughDirtCostsFallPlusMining() {
        FakeView v = new FakeView();
        v.set(0, 63, 0, Blocks.DIRT.defaultBlockState());  // dirt underfoot
        v.set(0, 62, 0, Blocks.STONE.defaultBlockState()); // standable one block further down
        CalculationContext ctx = context(v);
        double cost = MovementDownward.cost(ctx, 0, 64, 0);
        assertEquals(5.6147 + 15 + NavSettings.get().blockBreakAdditionalPenalty, cost, EPS);
    }

    // ==================== Parkour ====================

    @Test
    void parkourDisabledProducesNothing() {
        NavSettings.get().allowParkour = false;
        FakeView v = new FakeView();
        v.set(0, 63, 0, Blocks.STONE.defaultBlockState()); // takeoff block
        v.set(2, 63, 0, Blocks.STONE.defaultBlockState()); // landing across a one-block gap
        CalculationContext ctx = context(v);
        MutableMoveResult res = new MutableMoveResult();
        MovementParkour.cost(ctx, 0, 64, 0, Direction.EAST, res);
        assertTrue(res.cost >= ActionCosts.COST_INF, "no landing should be produced when parkour is off");
    }

    @Test
    void parkourIsEnabledByDefaultAndPricesOneGapJump() {
        FakeView v = new FakeView();
        v.set(0, 63, 0, Blocks.STONE.defaultBlockState());
        v.set(2, 63, 0, Blocks.STONE.defaultBlockState());
        CalculationContext ctx = context(v);
        MutableMoveResult res = new MutableMoveResult();
        MovementParkour.cost(ctx, 0, 64, 0, Direction.EAST, res);
        assertEquals(2, res.x);
        assertEquals(64, res.y);
        // two-block level jump 4.63285 x 2 + jump penalty 2
        assertEquals(9.2657 + 2, res.cost, EPS);
    }
}
