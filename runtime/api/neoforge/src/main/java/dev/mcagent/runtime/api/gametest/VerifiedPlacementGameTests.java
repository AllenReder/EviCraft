package dev.mcagent.runtime.api.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.RotatedPillarBlock;
import net.minecraft.world.phys.Vec3;

import java.util.concurrent.atomic.AtomicReference;

public final class VerifiedPlacementGameTests {
    private VerifiedPlacementGameTests() {}

    public static void floor_side_and_creative_placements_are_exact(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 61L);
        BlockPos floorTarget = fixture.target();
        BlockPos sideTarget = floorTarget.north(3);
        BlockPos creativeTarget = floorTarget.south(3);
        BlockPos deterministicTarget = floorTarget.north(6);
        fixture.level().setBlockAndUpdate(floorTarget.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(sideTarget.west(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(creativeTarget.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(deterministicTarget.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(deterministicTarget.west(), Blocks.STONE.defaultBlockState());
        bind(fixture, floorTarget, floorTarget.below(), sideTarget, sideTarget.west(),
                creativeTarget, creativeTarget.below(), deterministicTarget,
                deterministicTarget.below(), deterministicTarget.west());
        prepare(fixture, Items.OAK_STAIRS, 5, 2, Items.DIAMOND_BLOCK, true);
        AtomicReference<String> floor = new AtomicReference<>();
        AtomicReference<String> side = new AtomicReference<>();
        AtomicReference<String> deterministic = new AtomicReference<>();
        AtomicReference<String> creative = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "place-floor", "minecraft:oak_stairs",
                        floorTarget, floor))
                .thenWaitUntil(() -> helper.assertTrue(floor.get() != null,
                        "floor placement did not terminate"))
                .thenExecute(() -> {
                    JsonObject data = successData(helper, floor.get());
                    helper.assertTrue(fixture.level().getBlockState(floorTarget).is(Blocks.OAK_STAIRS)
                                    && data.get("block_state").getAsString().startsWith(
                                    "minecraft:oak_stairs[")
                                    && data.get("consumed_count").getAsInt() == 1,
                            "floor placement state/count was not exact: " + floor.get());
                    assertLayout(helper, fixture, Items.OAK_STAIRS, 5, 1,
                            Items.DIAMOND_BLOCK, true);
                    BlockPos sideFeet = sideTarget.east(2).below();
                    fixture.bot().moveTo(sideFeet.getX() + 0.5, sideFeet.getY(),
                            sideFeet.getZ() + 0.5, 90.0F, 0.0F);
                    fixture.bot().setOnGround(true);
                    fixture.bot().getInventory().setItem(5, new ItemStack(Items.TORCH, 2));
                    call(fixture, "place-side", "minecraft:torch", sideTarget, side);
                })
                .thenWaitUntil(() -> helper.assertTrue(side.get() != null,
                        "side placement did not terminate"))
                .thenExecute(() -> {
                    JsonObject data = successData(helper, side.get());
                    helper.assertTrue(fixture.level().getBlockState(sideTarget).is(Blocks.WALL_TORCH)
                                    && data.get("block_state").getAsString().startsWith(
                                    "minecraft:wall_torch[")
                                    && data.get("consumed_count").getAsInt() == 1,
                            "side support placement was not exact: " + side.get());
                    assertLayout(helper, fixture, Items.TORCH, 5, 1,
                            Items.DIAMOND_BLOCK, true);
                    double feetY = deterministicTarget.getY() + 1.0;
                    double eyeRelative = feetY + fixture.bot().getEyeHeight()
                            - deterministicTarget.getY();
                    fixture.bot().moveTo(deterministicTarget.getX() + eyeRelative, feetY,
                            deterministicTarget.getZ() + 0.5, 0.0F, 0.0F);
                    fixture.bot().setOnGround(true);
                    fixture.bot().getInventory().setItem(5, new ItemStack(Items.OAK_LOG, 2));
                    call(fixture, "place-deterministic", "minecraft:oak_log",
                            deterministicTarget, deterministic);
                })
                .thenWaitUntil(() -> helper.assertTrue(deterministic.get() != null,
                        "deterministic placement did not terminate"))
                .thenExecute(() -> {
                    JsonObject data = successData(helper, deterministic.get());
                    helper.assertTrue(fixture.level().getBlockState(deterministicTarget)
                                    .getValue(RotatedPillarBlock.AXIS) == Direction.Axis.Y
                                    && data.get("consumed_count").getAsInt() == 1,
                            "equal-distance support selection did not use stable face order: "
                                    + deterministic.get());
                    assertLayout(helper, fixture, Items.OAK_LOG, 5, 1,
                            Items.DIAMOND_BLOCK, true);
                    BlockPos feet = floorTarget.west(2).below();
                    fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    fixture.bot().setGameMode(GameType.CREATIVE);
                    fixture.bot().getInventory().setItem(5, new ItemStack(Items.STONE, 1));
                    call(fixture, "place-creative", "minecraft:stone", creativeTarget, creative);
                })
                .thenWaitUntil(() -> helper.assertTrue(creative.get() != null,
                        "creative placement did not terminate"))
                .thenExecute(() -> {
                    JsonObject data = successData(helper, creative.get());
                    helper.assertTrue(fixture.level().getBlockState(creativeTarget).is(Blocks.STONE)
                                    && data.get("consumed_count").getAsInt() == 0,
                            "creative placement did not preserve infinite material: " + creative.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 1,
                            Items.DIAMOND_BLOCK, true);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void required_support_face_uses_visible_outline_when_center_is_occluded(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 64L);
        BlockPos target = fixture.target();
        BlockPos support = target.below();
        BlockPos blocker = target.west();
        fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(blocker, Blocks.OAK_FENCE.defaultBlockState());
        bind(fixture, target, support, blocker);
        prepare(fixture, Items.STONE, 5, 2, Items.DIAMOND_BLOCK, false);
        BlockPos feet = target.west(2).below();
        fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.7,
                -90.0F, 0.0F);
        fixture.bot().setOnGround(true);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "place-visible-outline", "minecraft:stone",
                        target, terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "visible-outline placement did not terminate"))
                .thenExecute(() -> {
                    JsonObject data = successData(helper, terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(target).is(Blocks.STONE)
                                    && fixture.level().getBlockState(blocker).is(Blocks.OAK_FENCE)
                                    && data.get("consumed_count").getAsInt() == 1,
                            "place_block did not use the visible support outline: "
                                    + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 1,
                            Items.DIAMOND_BLOCK, false);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void entity_first_hit_blocks_center_and_outline_placement(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 65L);
        BlockPos target = fixture.target();
        BlockPos support = target.below();
        fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        bind(fixture, target, support);
        prepare(fixture, Items.STONE, 5, 2, Items.DIAMOND_BLOCK, false);
        BlockPos feet = target.west(2).below();
        fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.7,
                -90.0F, 0.0F);
        fixture.bot().setOnGround(true);
        ArmorStand blocker = EntityType.ARMOR_STAND.create(fixture.level());
        helper.assertTrue(blocker != null, "armor stand fixture did not create");
        blocker.moveTo(target.getX() - 0.5, target.getY() - 1.0,
                target.getZ() + 0.6);
        fixture.level().addFreshEntity(blocker);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "place-entity-first-hit", "minecraft:stone",
                        target, terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "entity first-hit placement"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "occluded");
                    helper.assertTrue(fixture.level().getBlockState(target).isAir(),
                            "placement bypassed the native entity first hit");
                    assertLayout(helper, fixture, Items.STONE, 5, 2,
                            Items.DIAMOND_BLOCK, false);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void placement_failures_are_typed_and_do_not_dispatch(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 62L);
        BlockPos noSupport = fixture.target();
        BlockPos changed = noSupport.north(3);
        BlockPos far = noSupport.east(9);
        BlockPos blocked = noSupport.south(3);
        // Beyond the 64-block sight range, so no frame can have seen it.
        BlockPos unknown = noSupport.above(80);
        BlockPos occluded = noSupport.east(6);
        fixture.level().setBlockAndUpdate(changed.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(far.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(blocked.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(occluded.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(occluded.west(2), Blocks.STONE.defaultBlockState());
        bind(fixture, noSupport, changed, changed.below(), far, far.below(),
                blocked, blocked.below(), occluded, occluded.below());
        prepare(fixture, Items.STONE, 5, 4, Items.DIAMOND_BLOCK, false);
        AtomicReference<String> noSupportResult = new AtomicReference<>();
        AtomicReference<String> changedResult = new AtomicReference<>();
        AtomicReference<String> missingResult = new AtomicReference<>();
        AtomicReference<String> nonBlockResult = new AtomicReference<>();
        AtomicReference<String> multiResult = new AtomicReference<>();
        AtomicReference<String> reachResult = new AtomicReference<>();
        AtomicReference<String> entityResult = new AtomicReference<>();
        AtomicReference<String> unknownResult = new AtomicReference<>();
        AtomicReference<String> occludedResult = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "place-no-support", "minecraft:stone",
                        noSupport, noSupportResult))
                .thenWaitUntil(() -> terminal(noSupportResult, helper, "no-support"))
                .thenExecute(() -> {
                    assertFailure(helper, noSupportResult.get(), "no_support");
                    setAndBindMismatch(fixture, changed, Blocks.DIRT.defaultBlockState());
                    call(fixture, "place-changed", "minecraft:stone", changed, changedResult);
                })
                .thenWaitUntil(() -> terminal(changedResult, helper, "changed-target"))
                .thenExecute(() -> {
                    assertFailure(helper, changedResult.get(), "target_changed");
                    call(fixture, "place-missing", "minecraft:oak_planks", noSupport, missingResult);
                })
                .thenWaitUntil(() -> terminal(missingResult, helper, "missing-item"))
                .thenExecute(() -> {
                    assertFailure(helper, missingResult.get(), "item_not_found");
                    fixture.bot().getInventory().setItem(6, new ItemStack(Items.STICK));
                    call(fixture, "place-non-block", "minecraft:stick", noSupport, nonBlockResult);
                })
                .thenWaitUntil(() -> terminal(nonBlockResult, helper, "non-block"))
                .thenExecute(() -> {
                    assertFailure(helper, nonBlockResult.get(), "item_not_block");
                    fixture.bot().getInventory().setItem(7, new ItemStack(Items.SUNFLOWER));
                    call(fixture, "place-multi", "minecraft:sunflower", noSupport, multiResult);
                })
                .thenWaitUntil(() -> terminal(multiResult, helper, "multi-cell"))
                .thenExecute(() -> {
                    assertFailure(helper, multiResult.get(), "multi_cell_item");
                    call(fixture, "place-far", "minecraft:stone", far, reachResult);
                })
                .thenWaitUntil(() -> terminal(reachResult, helper, "out-of-reach"))
                .thenExecute(() -> {
                    assertFailure(helper, reachResult.get(), "out_of_reach");
                    ArmorStand stand = EntityType.ARMOR_STAND.create(fixture.level());
                    helper.assertTrue(stand != null, "armor stand fixture did not create");
                    stand.moveTo(Vec3.atCenterOf(blocked));
                    fixture.level().addFreshEntity(stand);
                    call(fixture, "place-entity", "minecraft:stone", blocked, entityResult);
                })
                .thenWaitUntil(() -> terminal(entityResult, helper, "entity-blocked"))
                .thenExecute(() -> {
                    assertFailure(helper, entityResult.get(), "entity_blocked");
                    call(fixture, "place-unknown", "minecraft:stone", unknown, unknownResult);
                })
                .thenWaitUntil(() -> terminal(unknownResult, helper, "unknown-target"))
                .thenExecute(() -> {
                    assertFailure(helper, unknownResult.get(), "target_unknown");
                    BlockPos feet = occluded.west(4).below();
                    fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    call(fixture, "place-occluded", "minecraft:stone", occluded,
                            occludedResult);
                })
                .thenWaitUntil(() -> terminal(occludedResult, helper, "occluded"))
                .thenExecute(() -> {
                    assertFailure(helper, occludedResult.get(), "occluded");
                    assertLayout(helper, fixture, Items.STONE, 5, 4,
                            Items.DIAMOND_BLOCK, false);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    /** Self, other and unknown occupancy blocker classes reach the caller through occluding_detail. */
    public static void occupancy_classification_distinguishes_self_other_unknown(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 62L);
        BlockPos otherTarget = fixture.target();
        BlockPos feet = otherTarget.west(4).below();
        fixture.level().setBlockAndUpdate(otherTarget.below(), Blocks.STONE.defaultBlockState());
        bind(fixture, otherTarget, otherTarget.below());
        prepare(fixture, Items.STONE, 5, 4, Items.DIAMOND_BLOCK, false);
        fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, -90.0F, 0.0F);
        AtomicReference<String> other = new AtomicReference<>();
        AtomicReference<String> freed = new AtomicReference<>();

        helper.startSequence()
                // Other-entity occupancy: an armor stand in the target cell → entity_blocked, class other.
                .thenExecute(() -> {
                    ArmorStand stand = EntityType.ARMOR_STAND.create(fixture.level());
                    helper.assertTrue(stand != null, "armor stand fixture did not create");
                    stand.moveTo(Vec3.atCenterOf(otherTarget));
                    fixture.level().addFreshEntity(stand);
                    call(fixture, "place-other", "minecraft:stone", otherTarget, other);
                })
                .thenWaitUntil(() -> terminal(other, helper, "other-occupancy"))
                .thenExecute(() -> {
                    assertFailure(helper, other.get(), "entity_blocked");
                    JsonObject data = result(other.get()).getAsJsonObject("data");
                    helper.assertTrue(data.has("occluding_detail")
                                    && data.get("occluding_detail").getAsString()
                                            .contains("target_volume_other"),
                            "other-entity occupancy not classified as target_volume_other: "
                                    + other.get());
                    // Once the other entity leaves, placement must succeed (a transient blockage recovers).
                    fixture.level().getEntitiesOfClass(ArmorStand.class,
                                    new net.minecraft.world.phys.AABB(otherTarget))
                            .forEach(net.minecraft.world.entity.Entity::discard);
                    call(fixture, "place-freed", "minecraft:stone", otherTarget, freed);
                })
                .thenWaitUntil(() -> terminal(freed, helper, "freed-placement"))
                .thenExecute(() -> {
                    successData(helper, freed.get());
                    helper.assertTrue(fixture.level().getBlockState(otherTarget).is(Blocks.STONE),
                            "placement did not succeed after the occupying entity left");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    /**
     * Known replaceable targets (short grass, a water source) are filled in place like
     * vanilla, while a target the bot never observed stays unavailable (the G boundary), a known
     * solid target names its occupant, and the bot's own body is reported as itself.
     */
    public static void replaceable_targets_fill_in_place_and_target_failures_are_explained(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 65L);
        BlockPos feet = fixture.target().west(2).below();
        BlockPos grass = feet.east(2).north(2);
        BlockPos water = feet.east(1).below();
        BlockPos hidden = feet.west(2);
        BlockPos occupied = feet.below();
        fixture.level().setBlockAndUpdate(grass.below(), Blocks.GRASS_BLOCK.defaultBlockState());
        fixture.level().setBlockAndUpdate(grass, Blocks.SHORT_GRASS.defaultBlockState());
        for (BlockPos wall : new BlockPos[] {water.below(), water.north(), water.south(), water.east()}) {
            fixture.level().setBlockAndUpdate(wall, Blocks.STONE.defaultBlockState());
        }
        fixture.level().setBlockAndUpdate(water, Blocks.WATER.defaultBlockState());
        fixture.level().setBlockAndUpdate(hidden.below(), Blocks.GRASS_BLOCK.defaultBlockState());
        fixture.level().setBlockAndUpdate(hidden, Blocks.SHORT_GRASS.defaultBlockState());
        // An opaque wall keeps the hidden grass out of the bot's line of sight.
        fixture.level().setBlockAndUpdate(feet.west(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(feet.west().above(), Blocks.STONE.defaultBlockState());
        bind(fixture, grass, grass.below(), water, water.below(), water.east(), occupied, feet,
                hidden.below());
        prepare(fixture, Items.STONE, 5, 8, Items.DIAMOND_BLOCK, false);
        AtomicReference<String> grassResult = new AtomicReference<>();
        AtomicReference<String> waterResult = new AtomicReference<>();
        AtomicReference<String> hiddenResult = new AtomicReference<>();
        AtomicReference<String> occupiedResult = new AtomicReference<>();
        AtomicReference<String> bodyResult = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "place-grass", "minecraft:stone", grass, grassResult))
                .thenWaitUntil(() -> terminal(grassResult, helper, "grass-replacement"))
                .thenExecute(() -> {
                    successData(helper, grassResult.get());
                    helper.assertTrue(fixture.level().getBlockState(grass).is(Blocks.STONE),
                            "short grass was not replaced in place: " + grassResult.get());
                    call(fixture, "place-water", "minecraft:stone", water, waterResult);
                })
                .thenWaitUntil(() -> terminal(waterResult, helper, "water-replacement"))
                .thenExecute(() -> {
                    successData(helper, waterResult.get());
                    helper.assertTrue(fixture.level().getBlockState(water).is(Blocks.STONE),
                            "water source was not replaced in place: " + waterResult.get());
                    call(fixture, "place-hidden", "minecraft:stone", hidden, hiddenResult);
                })
                .thenWaitUntil(() -> terminal(hiddenResult, helper, "hidden-target"))
                .thenExecute(() -> {
                    assertFailure(helper, hiddenResult.get(), "target_unknown");
                    helper.assertTrue(fixture.level().getBlockState(hidden).is(Blocks.SHORT_GRASS)
                                    && !data(result(hiddenResult.get())).has("target_block_state"),
                            "an unobserved target was placed into or described: "
                                    + hiddenResult.get());
                    call(fixture, "place-occupied", "minecraft:stone", occupied, occupiedResult);
                })
                .thenWaitUntil(() -> terminal(occupiedResult, helper, "occupied-target"))
                .thenExecute(() -> {
                    assertFailure(helper, occupiedResult.get(), "target_occupied");
                    helper.assertTrue("minecraft:stone".equals(data(result(occupiedResult.get()))
                                    .get("target_block_state").getAsString()),
                            "occupied target did not name its known block: " + occupiedResult.get());
                    call(fixture, "place-body", "minecraft:stone", feet, bodyResult);
                })
                .thenWaitUntil(() -> terminal(bodyResult, helper, "body-target"))
                .thenExecute(() -> {
                    assertFailure(helper, bodyResult.get(), "body_in_target");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void partial_cancellation_and_timeout_restore_layout(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 63L);
        BlockPos modeBoundaryTarget = fixture.target();
        BlockPos partialTarget = fixture.target().north(3);
        BlockPos timeoutTarget = fixture.target().north(6);
        fixture.level().setBlockAndUpdate(modeBoundaryTarget.below(),
                Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(partialTarget.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(timeoutTarget.below(), Blocks.STONE.defaultBlockState());
        bind(fixture, modeBoundaryTarget, modeBoundaryTarget.below(), partialTarget,
                partialTarget.below(), timeoutTarget, timeoutTarget.below());
        prepare(fixture, Items.COBBLESTONE, 5, 3, Items.DIAMOND_BLOCK, false);
        AtomicReference<String> terminal = new AtomicReference<>();
        var partialId = JsonParser.parseString("\"place-partial\"");
        boolean[] cancelled = new boolean[1];

        helper.startSequence()
                .thenExecute(() -> call(fixture, "place-mode-boundary", "minecraft:cobblestone",
                        modeBoundaryTarget, terminal))
                .thenWaitUntil(() -> helper.assertTrue(
                        fixture.level().getBlockState(modeBoundaryTarget).is(Blocks.COBBLESTONE)
                                && fixture.bot().getMainHandItem().getCount() == 2,
                        "placement did not expose its game-mode verification boundary"))
                .thenExecute(() -> fixture.bot().setGameMode(GameType.CREATIVE))
                .thenWaitUntil(() -> terminal(terminal, helper, "game-mode boundary"))
                .thenExecute(() -> {
                    JsonObject data = successData(helper, terminal.get());
                    helper.assertTrue(data.get("consumed_count").getAsInt() == 1,
                            "placement did not freeze dispatch-time survival consumption: "
                                    + terminal.get());
                    assertLayout(helper, fixture, Items.COBBLESTONE, 5, 2,
                            Items.DIAMOND_BLOCK, false);
                    fixture.bot().setGameMode(GameType.SURVIVAL);
                    fixture.bot().getInventory().setItem(5, new ItemStack(Items.STONE, 2));
                    terminal.set(null);
                })
                .thenExecute(() -> {
                    rememberView(fixture);
                    fixture.tools().call(partialId, "place_block",
                            args("minecraft:stone", partialTarget), terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        fixture.level().getBlockState(partialTarget).is(Blocks.STONE)
                                && fixture.bot().getMainHandItem().getCount() == 1,
                        "placement did not expose its post-dispatch terminal boundary"))
                .thenExecute(() -> cancelled[0] = fixture.tools().cancel(partialId))
                .thenWaitUntil(() -> terminal(terminal, helper, "partial cancellation"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonObject data = data(result);
                    helper.assertTrue(cancelled[0] && !result.get("success").getAsBoolean()
                                    && result.get("interrupted").getAsBoolean()
                                    && data.get("consumed_count").getAsInt() == 1
                                    && data.get("block_state").getAsString().equals(
                                    "minecraft:stone"),
                            "placement lost verified partial facts: " + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 1,
                            Items.DIAMOND_BLOCK, false);
                    fixture.bot().getInventory().setItem(5, new ItemStack(Items.STONE));
                    terminal.set(null);
                    rememberView(fixture);
                    fixture.tools().call(JsonParser.parseString("\"place-timeout\""), "place_block",
                            args("minecraft:stone", timeoutTarget), terminal::set);
                    ((net.minecraft.world.level.storage.ServerLevelData) fixture.level().getLevelData())
                            .setGameTime(fixture.level().getGameTime() + 601L);
                })
                .thenWaitUntil(() -> terminal(terminal, helper, "timeout"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.get("timed_out").getAsBoolean(),
                            "placement timeout was not ordinary TaskResult: " + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 1,
                            Items.DIAMOND_BLOCK, false);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    private static Fixture fixture(GameTestHelper helper, long session) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos feet = helper.absolutePos(new BlockPos(4, 4, 4));
        BlockPos target = feet.east(2).above();
        for (BlockPos position : BlockPos.betweenClosed(
                feet.offset(-3, -2, -12), feet.offset(14, 5, 12))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
        bot.getInventory().clearContent();
        bot.setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
        bot.setGameMode(GameType.SURVIVAL);
        bot.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, -90.0F, 0.0F);
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, target, tools, new AtomicReference<>());
    }

    private static void prepare(Fixture fixture, Item requested, int source, int count,
                                Item offhand, boolean sneaking) {
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.DIAMOND_AXE));
        fixture.bot().getInventory().selected = 0;
        fixture.bot().getInventory().setItem(source, new ItemStack(requested, count));
        fixture.bot().setItemInHand(InteractionHand.OFF_HAND, new ItemStack(offhand));
        fixture.bot().setShiftKeyDown(sneaking);
    }

    private static void bind(Fixture fixture, BlockPos... positions) {
        RuntimeBotManager.tick(fixture.level().getServer());
        for (BlockPos position : positions) {
            RuntimeKnowledgeFixtures.publishBlock(fixture.level().getServer(),
                    fixture.level().dimension().location().toString(), fixture.level().getGameTime(),
                    position, fixture.level().getBlockState(position), BlockEvidenceSource.MISMATCH);
        }
    }

    private static void setAndBindMismatch(Fixture fixture, BlockPos target,
                                           net.minecraft.world.level.block.state.BlockState changed) {
        RuntimeKnowledgeFixtures.publishBlock(fixture.level().getServer(),
                fixture.level().dimension().location().toString(), fixture.level().getGameTime(),
                target, fixture.level().getBlockState(target), BlockEvidenceSource.MISMATCH);
        fixture.level().setBlockAndUpdate(target, changed);
    }

    private static void call(Fixture fixture, String id, String itemId, BlockPos target,
                             AtomicReference<String> terminal) {
        rememberView(fixture);
        fixture.tools().call(JsonParser.parseString('"' + id + '"'),
                "place_block", args(itemId, target), terminal::set);
    }

    private static void rememberView(Fixture fixture) {
        BotPlayer bot = fixture.bot();
        // FakePlayer head interpolation can still be catching up with the body rotation on the
        // tick a Tool is accepted. Start each restoration assertion from the stable body-aligned
        // view so it observes placement cleanup rather than ordinary idle interpolation.
        bot.setYHeadRot(bot.getYRot());
        fixture.expectedView().set(View.capture(bot));
    }

    private static JsonObject args(String itemId, BlockPos target) {
        JsonObject args = new JsonObject();
        args.addProperty("item_id", itemId);
        JsonObject position = new JsonObject();
        position.addProperty("x", target.getX());
        position.addProperty("y", target.getY());
        position.addProperty("z", target.getZ());
        args.add("position", position);
        return args;
    }

    private static boolean terminal(AtomicReference<String> terminal,
                                    GameTestHelper helper, String label) {
        helper.assertTrue(terminal.get() != null, label + " did not terminate");
        return true;
    }

    private static JsonObject result(String terminal) {
        return JsonParser.parseString(terminal).getAsJsonObject();
    }

    private static JsonObject data(JsonObject result) {
        return result.getAsJsonObject("data");
    }

    private static JsonObject successData(GameTestHelper helper, String terminal) {
        JsonObject result = result(terminal);
        helper.assertTrue(result.get("success").getAsBoolean(),
                "placement unexpectedly failed: " + terminal);
        return data(result);
    }

    private static void assertFailure(GameTestHelper helper, String terminal, String expected) {
        JsonObject result = result(terminal);
        helper.assertTrue(!result.get("success").getAsBoolean()
                        && expected.equals(data(result).get("failure_type").getAsString()),
                "placement did not return " + expected + ": " + terminal);
    }

    private static void assertLayout(GameTestHelper helper, Fixture fixture, Item requested,
                                     int slot, int count, Item offhand, boolean sneaking) {
        ItemStack stack = fixture.bot().getInventory().getItem(slot);
        View expectedView = fixture.expectedView().get();
        helper.assertTrue(stack.is(requested) && stack.getCount() == count
                        && fixture.bot().getMainHandItem().is(Items.DIAMOND_AXE)
                        && fixture.bot().getOffhandItem().is(offhand)
                        && fixture.bot().getInventory().selected == 0
                        && fixture.bot().isShiftKeyDown() == sneaking
                        && expectedView != null && expectedView.matches(fixture.bot()),
                "placement leaked item, hand, slot, offhand, sneak, or view state; expected="
                        + expectedView + ", actual=" + View.capture(fixture.bot()));
    }

    private static void cleanup(Fixture fixture) {
        fixture.bot().closeContainer();
        fixture.bot().getInventory().clearContent();
        fixture.bot().setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
        fixture.bot().setShiftKeyDown(false);
        fixture.bot().setGameMode(GameType.SURVIVAL);
    }

    private record Fixture(ServerLevel level, BotPlayer bot, BlockPos target,
                           DefaultRuntimeToolGateway tools, AtomicReference<View> expectedView) {}

    private record View(float yaw, float pitch, float headYaw) {
        private static View capture(BotPlayer player) {
            return new View(player.getYRot(), player.getXRot(), player.getYHeadRot());
        }

        private boolean matches(BotPlayer player) {
            return Float.compare(yaw, player.getYRot()) == 0
                    && Float.compare(pitch, player.getXRot()) == 0
                    && Float.compare(headYaw, player.getYHeadRot()) == 0;
        }
    }
}
