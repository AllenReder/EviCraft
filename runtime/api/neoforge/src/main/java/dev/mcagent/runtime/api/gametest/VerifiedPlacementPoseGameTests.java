package dev.mcagent.runtime.api.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;

import java.util.concurrent.atomic.AtomicReference;

/** Public Runtime Tool GameTests for item-specific Placement-Reachable Poses. */
public final class VerifiedPlacementPoseGameTests {
    private VerifiedPlacementPoseGameTests() {}

    /** A pose reached beside an occluder must survive the handoff to exact placement. */
    public static void placement_after_pose_waits_for_residual_drift(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3193L);
        BlockPos target = fixture.start().east(4).north(2);
        walkway(fixture, fixture.start().getX() - 2, target.getX() + 2,
                target.getZ() - 2, fixture.start().getZ() + 3);
        fixture.level().setBlockAndUpdate(target.west(), Blocks.OBSIDIAN.defaultBlockState());
        bindArea(fixture, target.offset(-6, -2, -3), target.offset(3, 3, 6));
        prepare(fixture, Items.OBSIDIAN, 5, 2);
        AtomicReference<String> pose = new AtomicReference<>();
        AtomicReference<String> placed = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> {
                    // The pose just before a final deceleration tick of the approach. The
                    // support's center is hidden by the preceding block; only its edge is visible.
                    fixture.bot().moveTo(target.getX() - 3.50213428292209, target.getY(),
                            target.getZ() + 2.69616832708, -90.0F, 0.0F);
                    fixture.bot().setShiftKeyDown(false);
                    fixture.bot().setPose(Pose.STANDING);
                    fixture.bot().setOnGround(true);
                    fixture.bot().setDeltaMovement(new Vec3(0, -0.0784000015258789,
                            0.01165955685366939));
                    call(fixture, "pose-residual-drift", "minecraft:obsidian", target, pose);
                })
                .thenWaitUntil(() -> terminal(pose, helper, "residual-drift placement pose"))
                .thenExecute(() -> {
                    helper.assertTrue(result(pose.get()).get("success").getAsBoolean(),
                            "placement pose failed before handoff: " + pose.get());
                    fixture.tools().call(JsonParser.parseString("\"place-after-residual-drift\""),
                            "place_block", args("minecraft:obsidian", target), placed::set);
                })
                .thenWaitUntil(() -> terminal(placed, helper, "placement after residual drift"))
                .thenExecute(() -> {
                    helper.assertTrue(result(placed.get()).get("success").getAsBoolean()
                                    && fixture.level().getBlockState(target).is(Blocks.OBSIDIAN)
                                    && fixture.bot().getInventory().getItem(5).getCount() == 1,
                            "verified pose did not survive handoff to placement: " + placed.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void immediate_pose_is_verified_without_placement_or_consumption(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3181L);
        BlockPos target = fixture.start().east(2).above();
        fixture.level().setBlockAndUpdate(target.below(), Blocks.STONE.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-4, -2, -4), target.offset(4, 3, 4));
        prepare(fixture, Items.STONE, 5, 2);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "pose-immediate", "minecraft:stone", target,
                        terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "immediate placement pose"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && data.entrySet().size() == 3
                                    && data.has("item_id") && data.has("position") && data.has("feet")
                                    && fixture.level().getBlockState(target).isAir(),
                            "placement-pose success dispatched placement or exposed extra facts: "
                                    + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 2);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void navigation_reaches_a_frozen_pose_and_preserves_target_and_support(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3182L);
        BlockPos target = fixture.start().east(8).above();
        for (int x = fixture.start().getX() - 1; x <= target.getX() + 1; x++) {
            fixture.level().setBlockAndUpdate(new BlockPos(x, fixture.start().getY() - 1,
                    fixture.start().getZ()), Blocks.STONE.defaultBlockState());
        }
        fixture.level().setBlockAndUpdate(target.below(), Blocks.STONE.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -4), target.offset(3, 3, 4));
        prepare(fixture, Items.OAK_STAIRS, 5, 3);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "pose-navigation", "minecraft:oak_stairs", target,
                        terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "placement-pose navigation"))
                .thenExecute(() -> {
                    JsonObject data = result(terminal.get()).getAsJsonObject("data");
                    helper.assertTrue(result(terminal.get()).get("success").getAsBoolean()
                                    && data.getAsJsonObject("feet").get("x").getAsInt()
                                    != fixture.start().getX()
                                    && fixture.level().getBlockState(target).isAir()
                                    && fixture.level().getBlockState(target.below()).is(Blocks.STONE),
                            "placement-pose navigation did not preserve its context: " + terminal.get());
                    assertLayout(helper, fixture, Items.OAK_STAIRS, 5, 3);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void known_preconditions_and_observed_support_removal_are_stable(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3183L);
        BlockPos noSupport = fixture.start().east(2).above();
        BlockPos changed = noSupport.north(3);
        BlockPos supportedTarget = fixture.start().east(8).above();
        fixture.level().setBlockAndUpdate(changed.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(supportedTarget.below(), Blocks.STONE.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -5), supportedTarget.offset(3, 3, 5));
        RuntimeKnowledgeFixtures.publishBlock(
                fixture.level().getServer(), fixture.level().dimension().location().toString(),
                fixture.level().getGameTime(), changed, Blocks.AIR.defaultBlockState(),
                BlockEvidenceSource.MISMATCH);
        fixture.level().setBlockAndUpdate(changed, Blocks.DIRT.defaultBlockState());
        prepare(fixture, Items.STONE, 5, 2);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "pose-no-support", "minecraft:stone", noSupport,
                        terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "no-support placement pose"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "no_support");
                    terminal.set(null);
                    RuntimeKnowledgeFixtures.publishBlock(fixture.level().getServer(),
                            fixture.level().dimension().location().toString(), fixture.level().getGameTime(),
                            changed, Blocks.DIRT.defaultBlockState(), BlockEvidenceSource.MISMATCH);
                    call(fixture, "pose-changed-target", "minecraft:stone", changed, terminal);
                })
                .thenWaitUntil(() -> terminal(terminal, helper, "changed placement target"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "target_occupied");
                    terminal.set(null);
                    call(fixture, "pose-observed-support-removal", "minecraft:stone", supportedTarget,
                            terminal);
                })
                .thenExecute(() -> {
                    fixture.level().setBlockAndUpdate(supportedTarget.below(), Blocks.AIR.defaultBlockState());
                    RuntimeKnowledgeFixtures.publishBlock(fixture.level().getServer(),
                            fixture.level().dimension().location().toString(), fixture.level().getGameTime(),
                            supportedTarget.below(), Blocks.AIR.defaultBlockState(), BlockEvidenceSource.MISMATCH);
                })
                .thenWaitUntil(() -> terminal(terminal, helper, "observed support removal"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "no_support");
                    helper.assertTrue(fixture.level().getBlockState(supportedTarget).isAir(),
                            "support change caused a placement dispatch");
                    assertLayout(helper, fixture, Items.STONE, 5, 2);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void collision_occlusion_interruption_and_timeout_restore_body(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3184L);
        BlockPos blocked = fixture.start().east(2).above();
        BlockPos far = fixture.start().east(9).above();
        fixture.level().setBlockAndUpdate(blocked.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(far.below(), Blocks.STONE.defaultBlockState());
        for (int x = fixture.start().getX() - 1; x <= far.getX() + 1; x++) {
            fixture.level().setBlockAndUpdate(new BlockPos(x, fixture.start().getY() - 1,
                    fixture.start().getZ()), Blocks.STONE.defaultBlockState());
        }
        bindArea(fixture, fixture.start().offset(-3, -2, -4), far.offset(3, 3, 4));
        prepare(fixture, Items.STONE, 5, 3);
        ArmorStand blocker = EntityType.ARMOR_STAND.create(fixture.level());
        helper.assertTrue(blocker != null, "armor stand fixture did not create");
        blocker.moveTo(blocked.getX() + 0.5, blocked.getY(), blocked.getZ() + 0.5);
        fixture.level().addFreshEntity(blocker);
        AtomicReference<String> terminal = new AtomicReference<>();
        var interruptedId = JsonParser.parseString("\"pose-interrupted\"");
        boolean[] cancelled = new boolean[1];

        helper.startSequence()
                .thenExecute(() -> call(fixture, "pose-collision", "minecraft:stone", blocked,
                        terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "entity-blocked placement pose"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "no_placement_pose");
                    helper.assertTrue(fixture.level().getBlockState(blocked).isAir(),
                            "collision pose dispatched placement");
                    blocker.discard();
                    terminal.set(null);
                    fixture.tools().call(interruptedId, "goto_block_placement_pose",
                            args("minecraft:stone", far), terminal::set);
                })
                .thenExecute(() -> cancelled[0] = fixture.tools().cancel(interruptedId))
                .thenWaitUntil(() -> terminal(terminal, helper, "interrupted placement pose"))
                .thenExecute(() -> {
                    JsonObject interrupted = result(terminal.get());
                    helper.assertTrue(cancelled[0] && interrupted.get("interrupted").getAsBoolean()
                                    && !interrupted.getAsJsonObject("data").has("feet"),
                            "interrupted pose leaked an unverified Feet Cell: " + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 3);
                    terminal.set(null);
                    fixture.tools().call(JsonParser.parseString("\"pose-timeout\""),
                            "goto_block_placement_pose", args("minecraft:stone", far), terminal::set);
                    ((net.minecraft.world.level.storage.ServerLevelData) fixture.level().getLevelData())
                            .setGameTime(fixture.level().getGameTime() + 601L);
                })
                .thenWaitUntil(() -> terminal(terminal, helper, "timed-out placement pose"))
                .thenExecute(() -> {
                    JsonObject timeout = result(terminal.get());
                    helper.assertTrue(timeout.get("timed_out").getAsBoolean()
                                    && !timeout.getAsJsonObject("data").has("feet"),
                            "timed-out pose leaked a verified Feet Cell: " + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 3);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void multiple_known_supports_choose_the_visible_context(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3185L);
        BlockPos target = fixture.start().east(10).above();
        BlockPos lowerSupport = target.below();
        BlockPos northSupport = target.north();
        walkway(fixture, fixture.start().getX(), target.getX(), fixture.start().getZ(),
                fixture.start().getZ() + 1);
        fixture.level().setBlockAndUpdate(lowerSupport, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(northSupport, Blocks.STONE.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -3), target.offset(3, 3, 3));
        prepare(fixture, Items.STONE, 5, 3);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> {
                    clearScaffoldPolicy(fixture);
                    call(fixture, "pose-multiple-supports", "minecraft:stone", target, terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        fixture.bot().getX() > fixture.start().getX() + 1.0,
                        "placement navigation never began before one known support changed"))
                .thenExecute(() -> fixture.level().setBlockAndUpdate(lowerSupport,
                        Blocks.DIRT.defaultBlockState()))
                .thenWaitUntil(() -> terminal(terminal, helper, "multiple-support placement pose"))
                .thenExecute(() -> {
                    JsonObject response = result(terminal.get());
                    helper.assertTrue(response.get("success").getAsBoolean()
                                    && fixture.level().getBlockState(target).isAir()
                                    && fixture.level().getBlockState(lowerSupport).is(Blocks.DIRT)
                                    && fixture.level().getBlockState(northSupport).is(Blocks.STONE),
                            "placement pose did not continue with its remaining known support: "
                                    + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 3);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void difficult_support_outline_is_verified_without_placement(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3186L);
        BlockPos target = fixture.start().east(2).above();
        BlockPos support = target.below();
        BlockPos centerBlocker = target.west();
        fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(centerBlocker, Blocks.OAK_FENCE.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -3), target.offset(3, 3, 3));
        prepare(fixture, Items.STONE, 5, 2);
        BlockPos feet = target.west(2).below();
        fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.7,
                -90.0F, 0.0F);
        fixture.bot().setOnGround(true);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "pose-difficult-outline", "minecraft:stone",
                        target, terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "outline placement pose"))
                .thenExecute(() -> {
                    JsonObject response = result(terminal.get());
                    helper.assertTrue(response.get("success").getAsBoolean()
                                    && fixture.level().getBlockState(target).isAir()
                                    && fixture.level().getBlockState(support).is(Blocks.STONE)
                                    && fixture.level().getBlockState(centerBlocker)
                                    .is(Blocks.OAK_FENCE),
                            "placement pose did not use a visible difficult support outline: "
                                    + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 2);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void ray_blocker_is_protected_while_navigation_uses_another_pose(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3187L);
        BlockPos target = fixture.start().east(6).above();
        BlockPos support = target.below();
        BlockPos blocker = target.west();
        walkway(fixture, fixture.start().getX(), target.getX(),
                fixture.start().getZ() - 1, fixture.start().getZ());
        fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(blocker, Blocks.SHULKER_BOX.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -4), target.offset(3, 3, 3));
        prepare(fixture, Items.STONE, 5, 3);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> {
                    clearScaffoldPolicy(fixture);
                    call(fixture, "pose-ray-blocker", "minecraft:stone", target, terminal);
                })
                .thenWaitUntil(() -> terminal(terminal, helper, "ray-blocked placement pose"))
                .thenExecute(() -> {
                    JsonObject response = result(terminal.get());
                    helper.assertTrue(response.get("success").getAsBoolean()
                                    && fixture.level().getBlockState(target).isAir()
                                    && fixture.level().getBlockState(support).is(Blocks.STONE)
                                    && fixture.level().getBlockState(blocker).is(Blocks.SHULKER_BOX),
                            "placement navigation consumed a ray blocker instead of using another pose: "
                                    + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 3);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void destructive_route_preserves_target_and_every_known_support(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3188L);
        BlockPos target = fixture.start().east(8).above();
        BlockPos support = target.below();
        BlockPos routeLow = fixture.start().east(3);
        BlockPos routeHigh = routeLow.above();
        tunnel(fixture, fixture.start().getX() - 1, target.getX() + 1);
        fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(routeLow, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(routeHigh, Blocks.STONE.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -3), target.offset(3, 3, 3));
        prepare(fixture, Items.STONE, 5, 3);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> {
                    clearScaffoldPolicy(fixture);
                    call(fixture, "pose-protected-route", "minecraft:stone", target, terminal);
                })
                .thenWaitUntil(() -> terminal(terminal, helper, "protected route placement pose"))
                .thenExecute(() -> {
                    JsonObject response = result(terminal.get());
                    helper.assertTrue(response.get("success").getAsBoolean()
                                    && (fixture.level().getBlockState(routeLow).isAir()
                                    || fixture.level().getBlockState(routeHigh).isAir())
                                    && fixture.level().getBlockState(target).isAir()
                                    && fixture.level().getBlockState(support).is(Blocks.STONE)
                                    && fixture.level().getBlockState(target.above()).is(Blocks.BEDROCK)
                                    && fixture.level().getBlockState(target.north()).is(Blocks.BEDROCK)
                                    && fixture.level().getBlockState(target.south()).is(Blocks.BEDROCK),
                            "placement navigation did not preserve the frozen placement context: "
                                    + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 3);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void frozen_pose_candidates_exhaust_without_mutating_the_context(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3189L);
        BlockPos target = fixture.start().east(8).above();
        BlockPos support = target.below();
        BlockPos blocker = target.west();
        tunnel(fixture, fixture.start().getX() - 1, target.getX() - 1);
        fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(blocker, Blocks.SHULKER_BOX.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -3), target.offset(3, 3, 3));
        prepare(fixture, Items.STONE, 5, 3);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> {
                    clearScaffoldPolicy(fixture);
                    call(fixture, "pose-exhausted", "minecraft:stone", target, terminal);
                })
                .thenWaitUntil(() -> terminal(terminal, helper, "exhausted placement poses"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "no_placement_pose");
                    helper.assertTrue(fixture.level().getBlockState(target).isAir()
                                    && fixture.level().getBlockState(support).is(Blocks.STONE)
                                    && fixture.level().getBlockState(blocker).is(Blocks.SHULKER_BOX),
                            "exhausted placement poses mutated their frozen context");
                    assertLayout(helper, fixture, Items.STONE, 5, 3);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void target_change_during_navigation_is_rejected_before_placement(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3190L);
        BlockPos target = fixture.start().east(10).above();
        BlockPos support = target.below();
        walkway(fixture, fixture.start().getX(), target.getX(), fixture.start().getZ(),
                fixture.start().getZ());
        fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -3), target.offset(3, 3, 3));
        prepare(fixture, Items.STONE, 5, 3);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> {
                    clearScaffoldPolicy(fixture);
                    call(fixture, "pose-target-changed-in-flight", "minecraft:stone", target,
                            terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        fixture.bot().getX() > fixture.start().getX() + 1.0,
                        "placement navigation never began before target change"))
                .thenExecute(() -> fixture.level().setBlockAndUpdate(target,
                        Blocks.DIRT.defaultBlockState()))
                .thenWaitUntil(() -> terminal(terminal, helper, "changed target during navigation"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "target_occupied");
                    helper.assertTrue(fixture.level().getBlockState(target).is(Blocks.DIRT)
                                    && fixture.level().getBlockState(support).is(Blocks.STONE),
                            "changed target was placed into or its support was consumed");
                    assertLayout(helper, fixture, Items.STONE, 5, 3);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void discovered_non_neighbor_ray_blocker_is_promoted_before_replan(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3191L);
        BlockPos target = fixture.start().east(10).above();
        BlockPos support = target.below();
        BlockPos blocker = target.west(2);
        BlockPos firstOccludedPose = target.west(4).below();
        int detourZ = fixture.start().getZ() + 5;
        walkway(fixture, fixture.start().getX(), target.getX(), fixture.start().getZ(),
                fixture.start().getZ());
        walkway(fixture, fixture.start().getX() + 3, fixture.start().getX() + 3,
                fixture.start().getZ(), detourZ);
        walkway(fixture, fixture.start().getX() + 3, target.getX(), detourZ, detourZ);
        walkway(fixture, target.getX(), target.getX(), fixture.start().getZ(), detourZ);
        fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(blocker, Blocks.OAK_PLANKS.defaultBlockState());
        bindArea(fixture, fixture.start().offset(-3, -2, -3), target.offset(3, 3, 7));
        prepare(fixture, Items.STONE, 5, 3);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> {
                    clearScaffoldPolicy(fixture);
                    call(fixture, "pose-promoted-ray-blocker", "minecraft:stone", target,
                            terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        fixture.bot().getX() >= firstOccludedPose.getX() + 0.25,
                        "placement navigation never reached its forced occluded arrival"))
                .thenWaitUntil(() -> terminal(terminal, helper,
                        "promoted ray-blocker placement pose"))
                .thenExecute(() -> {
                    JsonObject response = result(terminal.get());
                    JsonObject feet = response.getAsJsonObject("data").getAsJsonObject("feet");
                    helper.assertTrue(response.get("success").getAsBoolean()
                                    && feet.get("z").getAsInt() != fixture.start().getZ()
                                    && fixture.level().getBlockState(target).isAir()
                                    && fixture.level().getBlockState(support).is(Blocks.STONE)
                                    && fixture.level().getBlockState(blocker).is(Blocks.OAK_PLANKS),
                            "failed arrival did not protect its discovered ray blocker before "
                                    + "replanning to another pose: " + terminal.get());
                    assertLayout(helper, fixture, Items.STONE, 5, 3);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void scaffold_navigation_never_buries_target_or_known_support(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 3192L);
        BlockPos target = fixture.start().east(8).below();
        BlockPos routeSupport = target.east();
        BlockPos sideSupport = target.north();
        BlockPos ordinaryScaffold = fixture.start().east(2).below();
        int floorY = fixture.start().getY() - 1;
        int startZ = fixture.start().getZ();
        int detourZ = startZ + 7;
        int farX = fixture.start().getX() + 10;
        walkway(fixture, fixture.start().getX(), target.getX() - 1,
                startZ, startZ);
        walkway(fixture, target.getX() + 1, farX, startZ, startZ);
        walkway(fixture, fixture.start().getX() + 4, fixture.start().getX() + 4,
                startZ, detourZ);
        walkway(fixture, fixture.start().getX() + 4, farX, detourZ, detourZ);
        walkway(fixture, farX, farX, startZ, detourZ);
        fixture.level().setBlockAndUpdate(target, Blocks.AIR.defaultBlockState());
        fixture.level().setBlockAndUpdate(ordinaryScaffold, Blocks.AIR.defaultBlockState());
        fixture.level().setBlockAndUpdate(routeSupport, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(sideSupport, Blocks.STONE.defaultBlockState());
        for (int x = target.getX() - 1; x <= target.getX() + 1; x++) {
            fixture.level().setBlockAndUpdate(
                    new BlockPos(x, fixture.start().getY() + 2, startZ),
                    Blocks.BEDROCK.defaultBlockState());
            for (int z : new int[]{startZ - 1, startZ + 1}) {
                fixture.level().setBlockAndUpdate(
                        new BlockPos(x, fixture.start().getY(), z),
                        Blocks.BEDROCK.defaultBlockState());
                fixture.level().setBlockAndUpdate(
                        new BlockPos(x, fixture.start().getY() + 1, z),
                        Blocks.BEDROCK.defaultBlockState());
            }
        }
        for (int x = fixture.start().getX() + 1; x <= fixture.start().getX() + 3; x++) {
            fixture.level().setBlockAndUpdate(
                    new BlockPos(x, fixture.start().getY() + 2, startZ),
                    Blocks.BEDROCK.defaultBlockState());
            for (int z : new int[]{startZ - 1, startZ + 1}) {
                fixture.level().setBlockAndUpdate(
                        new BlockPos(x, fixture.start().getY(), z),
                        Blocks.BEDROCK.defaultBlockState());
                fixture.level().setBlockAndUpdate(
                        new BlockPos(x, fixture.start().getY() + 1, z),
                        Blocks.BEDROCK.defaultBlockState());
            }
        }
        helper.assertTrue(target.getY() == floorY,
                "scaffold-protection fixture target is not the direct bridge gap");
        bindArea(fixture, fixture.start().offset(-3, -3, -3),
                fixture.start().offset(12, 4, 8));
        prepare(fixture, Items.STONE, 5, 3);
        fixture.bot().getAttribute(Attributes.BLOCK_INTERACTION_RANGE).setBaseValue(2.5);
        fixture.bot().getInventory().setItem(1, new ItemStack(Items.COBBLESTONE, 16));
        AtomicReference<String> policyTerminal = new AtomicReference<>();
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> setScaffoldPolicy(
                        fixture, "minecraft:cobblestone", policyTerminal))
                .thenWaitUntil(() -> terminal(policyTerminal, helper, "scaffold policy setup"))
                .thenExecute(() -> {
                    helper.assertTrue(result(policyTerminal.get()).get("success").getAsBoolean(),
                            "scaffold policy setup failed: " + policyTerminal.get());
                    call(fixture, "pose-protected-scaffold", "minecraft:stone", target,
                            terminal);
                })
                .thenWaitUntil(() -> terminal(terminal, helper,
                        "scaffold-protected placement pose"))
                .thenExecute(() -> {
                    JsonObject response = result(terminal.get());
                    helper.assertTrue(response.get("success").getAsBoolean(),
                            "scaffold-protected pose failed: " + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(ordinaryScaffold)
                                    .is(Blocks.COBBLESTONE),
                            "scaffold navigation skipped the forced ordinary bridge at "
                                    + ordinaryScaffold + ": "
                                    + fixture.level().getBlockState(ordinaryScaffold));
                    helper.assertTrue(fixture.level().getBlockState(target).isAir(),
                            "scaffold navigation buried its protected target: " + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(routeSupport).is(Blocks.STONE)
                                    && fixture.level().getBlockState(sideSupport).is(Blocks.STONE),
                            "scaffold navigation replaced a known support: " + terminal.get());
                    helper.assertTrue(fixture.bot().getInventory().getItem(5).is(Items.STONE)
                                    && fixture.bot().getInventory().getItem(5).getCount() == 3,
                            "placement-pose navigation consumed or moved the requested stack");
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
        BlockPos start = helper.absolutePos(new BlockPos(4, 4, 4));
        for (BlockPos position : BlockPos.betweenClosed(
                start.offset(-5, -3, -8), start.offset(16, 6, 8))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        level.setBlockAndUpdate(start.below(), Blocks.STONE.defaultBlockState());
        bot.getInventory().clearContent();
        bot.setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
        bot.moveTo(start.getX() + 0.5, start.getY(), start.getZ() + 0.5, -90.0F, 0.0F);
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, start, tools);
    }

    private static void prepare(Fixture fixture, Item requested, int source, int count) {
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.DIAMOND_AXE));
        fixture.bot().getInventory().selected = 0;
        fixture.bot().getInventory().setItem(source, new ItemStack(requested, count));
        fixture.bot().setItemInHand(InteractionHand.OFF_HAND, new ItemStack(Items.DIAMOND_BLOCK));
        fixture.bot().setShiftKeyDown(true);
        fixture.bot().setYRot(-90.0F);
        fixture.bot().setXRot(0.0F);
        fixture.bot().setYHeadRot(-90.0F);
    }

    private static void bindArea(Fixture fixture, BlockPos min, BlockPos max) {
        RuntimeBotManager.tick(fixture.level().getServer());
        for (BlockPos position : BlockPos.betweenClosed(min, max)) {
            RuntimeKnowledgeFixtures.publishBlock(fixture.level().getServer(),
                    fixture.level().dimension().location().toString(), fixture.level().getGameTime(),
                    position, fixture.level().getBlockState(position), BlockEvidenceSource.MISMATCH);
        }
    }

    private static void clearScaffoldPolicy(Fixture fixture) {
        JsonObject args = new JsonObject();
        args.addProperty("action", "clear");
        fixture.tools().call(JsonParser.parseString("\"placement-pose-no-scaffold\""),
                "manage_scaffold_materials", args, ignored -> {});
    }

    private static void setScaffoldPolicy(Fixture fixture, String itemId,
                                          AtomicReference<String> terminal) {
        JsonObject args = new JsonObject();
        args.addProperty("action", "set");
        args.add("item_id_globs", JsonParser.parseString("[\"" + itemId + "\"]"));
        fixture.tools().call(JsonParser.parseString("\"placement-pose-scaffold-policy\""),
                "manage_scaffold_materials", args, terminal::set);
    }

    private static void walkway(Fixture fixture, int minX, int maxX, int minZ, int maxZ) {
        for (int x = minX; x <= maxX; x++) {
            for (int z = minZ; z <= maxZ; z++) {
                fixture.level().setBlockAndUpdate(new BlockPos(x, fixture.start().getY() - 1, z),
                        Blocks.STONE.defaultBlockState());
            }
        }
    }

    private static void tunnel(Fixture fixture, int minX, int maxX) {
        int y = fixture.start().getY();
        int z = fixture.start().getZ();
        walkway(fixture, minX, maxX, z, z);
        for (int x = minX; x <= maxX; x++) {
            for (int blockedY = y; blockedY <= y + 2; blockedY++) {
                fixture.level().setBlockAndUpdate(new BlockPos(x, blockedY, z - 1),
                        Blocks.BEDROCK.defaultBlockState());
                fixture.level().setBlockAndUpdate(new BlockPos(x, blockedY, z + 1),
                        Blocks.BEDROCK.defaultBlockState());
            }
            fixture.level().setBlockAndUpdate(new BlockPos(x, y + 2, z),
                    Blocks.BEDROCK.defaultBlockState());
        }
    }

    private static void call(Fixture fixture, String id, String itemId, BlockPos target,
                             AtomicReference<String> terminal) {
        fixture.tools().call(JsonParser.parseString('"' + id + '"'), "goto_block_placement_pose",
                args(itemId, target), terminal::set);
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

    private static JsonObject result(String terminal) {
        return JsonParser.parseString(terminal).getAsJsonObject();
    }

    private static boolean terminal(AtomicReference<String> terminal, GameTestHelper helper,
                                    String label) {
        helper.assertTrue(terminal.get() != null, label + " did not terminate");
        return true;
    }

    private static void assertFailure(GameTestHelper helper, String raw, String failureType) {
        JsonObject result = result(raw);
        helper.assertTrue(!result.get("success").getAsBoolean()
                        && failureType.equals(result.getAsJsonObject("data")
                        .get("failure_type").getAsString()),
                "expected " + failureType + ": " + raw);
    }

    private static void assertLayout(GameTestHelper helper, Fixture fixture, Item requested,
                                     int source, int expectedCount) {
        BotPlayer bot = fixture.bot();
        helper.assertTrue(bot.getInventory().selected == 0
                        && bot.getInventory().getItem(0).is(Items.DIAMOND_AXE)
                        && bot.getInventory().getItem(source).is(requested)
                        && bot.getInventory().getItem(source).getCount() == expectedCount
                        && bot.getOffhandItem().is(Items.DIAMOND_BLOCK)
                        && bot.isShiftKeyDown()
                        && bot.getYRot() == -90.0F && bot.getXRot() == 0.0F
                        && bot.getYHeadRot() == -90.0F,
                "placement-pose did not restore temporary body/Inventory state");
    }

    private static void cleanup(Fixture fixture) {
        fixture.tools().sessionClosed(Long.MAX_VALUE);
        RuntimeBotManager.stop(fixture.level().getServer());
    }

    private record Fixture(ServerLevel level, BotPlayer bot, BlockPos start,
                           DefaultRuntimeToolGateway tools) {}
}
