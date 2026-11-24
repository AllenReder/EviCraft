package dev.mcagent.runtime.core.pathing.moves.movements;

import java.lang.reflect.Field;

import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Pins for selectThrowaway priority and offhand fallback:
 * <ul>
 *   <li>with several usable blocks in the hotbar whose slot order differs from the priority order, choose by
 *       the order of the Bot's scaffolding list ({@code ScaffoldMaterials}; the factory default puts dirt
 *       before cobblestone), not by slot order;</li>
 *   <li>with no usable block in the hotbar but a scaffolding block in the offhand, fall back to the offhand
 *       and select an empty main-hand slot or one with the TOOL component (sword/pickaxe/axe/shovel/hoe do
 *       not place blocks on right-click, so right-click goes to the offhand).</li>
 * </ul>
 * selectThrowaway is package-private static; this test accesses it from the same package. Requires the MC
 * registries.
 */
@Tag("mc")
class ThrowawaySelectionTest {

    private static boolean booted;
    private static ServerPlayer player;

    @BeforeAll
    static void boot() {
        try {
            net.minecraft.SharedConstants.tryDetectVersion();
            net.minecraft.server.Bootstrap.bootStrap();
            player = allocatePlayer();
            booted = true;
        } catch (Throwable t) {
            booted = false;
        }
    }

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
        assumeTrue(booted, "Minecraft bootstrap unavailable, skipping throwaway selection pins");
        dev.mcagent.runtime.platform.ServerLifecycle.fireStopped();
        clearHotbar();
    }

    @AfterEach
    void tearDown() {
        clearHotbar();
        dev.mcagent.runtime.platform.ServerLifecycle.fireStopped();
    }

    private static void clearHotbar() {
        Inventory inv = player.getInventory();
        for (int i = 0; i < inv.items.size(); i++) {
            inv.items.set(i, ItemStack.EMPTY);
        }
        for (int i = 0; i < inv.offhand.size(); i++) {
            inv.offhand.set(i, ItemStack.EMPTY);
        }
        player.getInventory().selected = 0;
    }

    @Test
    void priorityOrderBeatsSlotOrder() {
        // Cobblestone in slot 0, dirt in slot 3; dirt has priority over cobblestone, so slot 3 is selected
        player.getInventory().items.set(0, new ItemStack(Items.COBBLESTONE));
        player.getInventory().items.set(3, new ItemStack(Items.DIRT));
        assertTrue(MovementPlacement.selectThrowaway(player, true));
        assertEquals(3, player.getInventory().selected,
                "should pick dirt (slot 3) by configured priority, not the earlier-slot cobblestone (slot 0)");
    }

    @Test
    void firstAcceptableItemWins() {
        // Dirt (highest priority) in two slots: the earlier slot wins
        player.getInventory().items.set(2, new ItemStack(Items.DIRT));
        player.getInventory().items.set(5, new ItemStack(Items.DIRT));
        assertTrue(MovementPlacement.selectThrowaway(player, true));
        assertEquals(2, player.getInventory().selected);
    }

    @Test
    void offhandFallbackPicksToolOrEmptyMainHandSlot() {
        // Scaffolding block in the offhand; the hotbar has only a stone sword (TOOL component) in slot 0 and
        // air in slot 1. The slot with the TOOL component must be chosen (a sword does not place blocks on
        // right-click, so right-click goes to the offhand), not a slot that would place a block.
        player.getInventory().items.set(0, new ItemStack(Items.STONE_SWORD));
        // Offhand setup: ServerPlayer.getOffhandItem() reads Inventory.offhand
        player.getInventory().offhand.set(0, new ItemStack(Items.DIRT));
        assertTrue(MovementPlacement.selectThrowaway(player, true));
        // The main hand must switch to slot 0 (sword, TOOL component), not 1 (empty qualifies but is later)
        assertEquals(0, player.getInventory().selected,
                "when the offhand matches, the main hand should switch to an empty slot or one with a TOOL component, got " + player.getInventory().selected);
    }

    @Test
    void offhandFallbackSkipsPlaceableMainHandSlot() {
        // Scaffolding block in the offhand; hotbar slot 0 holds oak planks (placed on right-click, not on the
        // scaffolding list, no TOOL component), slot 1 a stone sword (TOOL component). The hotbar has no
        // usable block, so the offhand fallback applies: skip slot 0 (it would place a block) and choose
        // slot 1 (sword) so right-click goes to the offhand.
        player.getInventory().items.set(0, new ItemStack(Items.OAK_PLANKS));
        player.getInventory().items.set(1, new ItemStack(Items.STONE_SWORD));
        player.getInventory().offhand.set(0, new ItemStack(Items.DIRT));
        assertTrue(MovementPlacement.selectThrowaway(player, true));
        assertEquals(1, player.getInventory().selected,
                "when the main hand holds a placeable block it should be skipped for the sword slot with a TOOL component, got " + player.getInventory().selected);
    }

    @Test
    void noThrowawayReturnsFalse() {
        // No scaffolding in either the hotbar or the offhand
        assertFalse(MovementPlacement.selectThrowaway(player, false));
    }

    @Test
    void worldRunPolicyOverrideAndClearDriveActualNavigationMaterialSelection() {
        player.getInventory().items.set(0, new ItemStack(Items.COBBLESTONE));
        player.getInventory().items.set(3, new ItemStack(Items.OAK_PLANKS));

        dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials.store(
                player, java.util.List.of("minecraft:*_planks"));
        assertTrue(MovementPlacement.selectThrowaway(player, true));
        assertEquals(3, player.getInventory().selected,
                "the written Glob expansion, not the factory list, must authorize route material");

        dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials.store(player, java.util.List.of());
        assertFalse(MovementPlacement.selectThrowaway(player, false),
                "clear explicitly prohibits all scaffold consumption");
    }
}
