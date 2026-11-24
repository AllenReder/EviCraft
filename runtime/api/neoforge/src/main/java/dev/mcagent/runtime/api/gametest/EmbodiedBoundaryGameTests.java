package dev.mcagent.runtime.api.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.sdk.DefaultRuntimeEvidenceGateway;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import dev.mcagent.runtime.sdk.RuntimeBlockFindResult;
import dev.mcagent.runtime.sdk.RuntimeBlockPaletteEntry;
import dev.mcagent.runtime.sdk.RuntimeBlockPosition;
import dev.mcagent.runtime.sdk.RuntimeBlockRegionResult;
import dev.mcagent.runtime.sdk.RuntimeEvidenceGateway;
import dev.mcagent.runtime.sdk.RuntimeEntityListResult;
import dev.mcagent.runtime.sdk.RuntimeEntityTrack;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.entity.animal.Sheep;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.AABB;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

@GameTestHolder("mc_agent_api")
@PrefixGameTestTemplate(false)
public final class EmbodiedBoundaryGameTests {

    private EmbodiedBoundaryGameTests() {}

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 1200, batch = "embodied_boundary_navigation")
    public static void goto_preserves_known_wall_and_uses_evidence_backed_door(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos start = helper.absolutePos(new BlockPos(4, 300, 4));
        BlockPos doorWallCenter = start.east();
        BlockPos wallCenter = start.east(2);
        BlockPos doorLow = doorWallCenter;
        BlockPos target = start.east(8);
        BlockPos underDoor = doorLow.below(3);
        BlockPos wallView = wallCenter.east();
        for (BlockPos position : BlockPos.betweenClosed(
                start.offset(-2, -5, -6), target.offset(2, 6, 6))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        for (BlockPos position : BlockPos.betweenClosed(
                start.offset(-2, -1, -5), target.offset(2, -1, 5))) {
            level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
        }
        level.setBlockAndUpdate(underDoor.below(), Blocks.STONE.defaultBlockState());
        for (BlockPos position : BlockPos.betweenClosed(
                doorWallCenter.offset(0, 0, -20), doorWallCenter.offset(0, 20, 20))) {
            level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
        }
        var lowerDoor = Blocks.OAK_DOOR.defaultBlockState()
                .setValue(net.minecraft.world.level.block.DoorBlock.FACING,
                        net.minecraft.core.Direction.EAST);
        level.setBlockAndUpdate(doorLow, lowerDoor);
        level.setBlockAndUpdate(doorLow.above(), lowerDoor.setValue(
                net.minecraft.world.level.block.DoorBlock.HALF,
                net.minecraft.world.level.block.state.properties.DoubleBlockHalf.UPPER));
        bot.setInvulnerable(true);
        bot.fallDistance = 0.0F;
        bot.setHealth(bot.getMaxHealth());
        bot.moveTo(underDoor.getX() + 0.5, underDoor.getY(), underDoor.getZ() + 0.5,
                90.0F, 0.0F);

        String dimension = level.dimension().location().toString();
        long initialRevision = RuntimeBotManager.observationRevision(level.getServer());
        AtomicReference<String> terminal = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(1L);
        long[] routeRevision = new long[1];
        long[] wallRevision = new long[1];
        long[] openedRevision = new long[1];
        boolean[] doorWasOpened = new boolean[1];

        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > initialRevision
                                && RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                doorLow.below()).state() == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "underside observation did not establish the route support"))
                .thenExecute(() -> {
                    bot.moveTo(start.getX() + 0.5, start.getY(), start.getZ() + 0.5,
                            90.0F, 0.0F);
                    routeRevision[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> {
                    BlockEvidenceCell startFloor = RuntimeKnowledgeFixtures.block(
                            level.getServer(), dimension, start.below());
                    BlockEvidenceCell nextFloor = RuntimeKnowledgeFixtures.block(
                            level.getServer(), dimension, start.east().below());
                    BlockEvidenceCell door = RuntimeKnowledgeFixtures.block(
                            level.getServer(), dimension, doorLow);
                    BlockEvidenceCell doorFloor = RuntimeKnowledgeFixtures.block(
                            level.getServer(), dimension, doorLow.below());
                    helper.assertTrue(
                            RuntimeBotManager.observationRevision(level.getServer())
                                    > routeRevision[0]
                                    && startFloor.state() == BlockEvidenceCell.State.KNOWN_BLOCK
                                    && nextFloor.state() == BlockEvidenceCell.State.KNOWN_BLOCK
                                    && door.state() == BlockEvidenceCell.State.KNOWN_BLOCK
                                    && doorFloor.state() == BlockEvidenceCell.State.KNOWN_BLOCK,
                            "fixture did not establish a known route door: "
                                    + "startFloor=" + startFloor.state()
                                    + " nextFloor=" + nextFloor.state()
                                    + " door=" + door.state()
                                    + " doorFloor=" + doorFloor.state());
                })
                .thenExecute(() -> {
                    for (BlockPos position : BlockPos.betweenClosed(
                            wallCenter.offset(0, 0, -5), wallCenter.offset(0, 5, 5))) {
                        level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
                    }
                    bot.moveTo(wallView.getX() + 0.5, wallView.getY(), wallView.getZ() + 0.5,
                            -90.0F, 0.0F);
                    wallRevision[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > wallRevision[0]
                                && RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                wallCenter).state() == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "fixture wall did not become known before goto"))
                .thenExecute(() -> {
                    bot.moveTo(start.getX() + 0.5, start.getY(), start.getZ() + 0.5,
                            90.0F, 0.0F);
                    JsonObject args = new JsonObject();
                    JsonObject goal = new JsonObject();
                    goal.addProperty("kind", "column");
                    goal.addProperty("x", target.getX());
                    goal.addProperty("z", target.getZ());
                    args.add("goal", goal);
                    tools.call(JsonParser.parseString("\"frontier-goto\""),
                            "goto", args, terminal::set);
                })
                .thenIdle(5)
                .thenExecute(() -> {
                    helper.assertTrue(bot.getX() < wallCenter.getX() + 0.5,
                            "goto crossed the known fixture wall");
                    doorWasOpened[0] = level.getBlockState(doorLow).getValue(
                            net.minecraft.world.level.block.DoorBlock.OPEN);
                    for (BlockPos position : BlockPos.betweenClosed(
                            wallCenter.offset(0, 0, -5), wallCenter.offset(0, 5, 5))) {
                        helper.assertTrue(level.getBlockState(position).is(Blocks.STONE),
                                "route mutation changed a known wall before the hidden dependency was observed");
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    openedRevision[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > openedRevision[0]
                                && RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                doorLow).state() == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "opening the view did not preserve the known door route"))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "goto did not replan to a terminal result after observation"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "replanned goto failed: " + terminal.get());
                    helper.assertTrue(doorWasOpened[0]
                                    || level.getBlockState(doorLow).getValue(
                                    net.minecraft.world.level.block.DoorBlock.OPEN),
                            "evidence-backed goto did not open the known route door");
                    bot.setInvulnerable(false);
                    bot.fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.getYRot(), bot.getXRot());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 240, batch = "embodied_boundary_interact")
    public static void break_block_breaks_only_the_exact_known_block(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = helper.absolutePos(new BlockPos(4, 220, 4)).north(256);
        BlockPos target = feet.east(2).above();
        BlockPos neighbour = target.above();
        String dimension = level.dimension().location().toString();
        long[] before = new long[1];
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(10L);

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -2), feet.offset(5, 4, 2))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    level.setBlockAndUpdate(target, Blocks.STONE.defaultBlockState());
                    level.setBlockAndUpdate(neighbour, Blocks.STONE.defaultBlockState());
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                target).state() == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "fixture target did not become KNOWN_BLOCK"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("position", positionJson(target));
                    tools.call(JsonParser.parseString("\"exact-left\""),
                            "break_block", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "break_block did not reach a terminal result"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "exact left interaction failed: " + terminal.get());
                    helper.assertTrue(level.getBlockState(target).isAir(),
                            "exact left interaction did not remove its target");
                    helper.assertTrue(level.getBlockState(neighbour).is(Blocks.STONE),
                            "exact left interaction crossed into another block");
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 160, batch = "embodied_boundary_interact_unknown")
    public static void use_item_rejects_an_unknown_air_aim(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(256));
        BlockPos wall = feet.east().above();
        BlockPos hiddenAir = wall.east();
        String dimension = level.dimension().location().toString();
        long[] before = new long[1];
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(11L);

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -3), feet.offset(5, 4, 3))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    for (int y = -5; y <= 5; y++) {
                        for (int z = -5; z <= 5; z++) {
                            level.setBlockAndUpdate(wall.offset(0, y, z),
                                    Blocks.STONE.defaultBlockState());
                        }
                    }
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && evidence(level, wall).state()
                                == BlockEvidenceCell.State.KNOWN_BLOCK
                                && evidence(level, hiddenAir).state()
                                == BlockEvidenceCell.State.UNKNOWN,
                        "fixture did not preserve the hidden aim as UNKNOWN"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("aim", positionJson(hiddenAir));
                    tools.call(JsonParser.parseString("\"unknown-right\""),
                            "use_item", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "UNKNOWN right interaction did not reach a terminal result"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.get("message").getAsString().contains("KNOWN_AIR"),
                            "UNKNOWN aim was not rejected at the evidence boundary: "
                                    + terminal.get());
                    helper.assertTrue(level.getBlockState(wall).is(Blocks.STONE),
                            "UNKNOWN right interaction changed its occluding first hit");
                    helper.assertTrue(evidence(level, hiddenAir).state()
                                    == BlockEvidenceCell.State.UNKNOWN,
                            "rejected UNKNOWN interaction filled hidden evidence");
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 180, batch = "embodied_boundary_interact_mismatch")
    public static void break_block_ray_mismatch_updates_only_the_first_hit_evidence(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(512));
        BlockPos blocker = feet.east().above();
        BlockPos target = feet.east(3).above();
        String dimension = level.dimension().location().toString();
        long[] before = new long[1];
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(12L);

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -3), feet.offset(6, 4, 3))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    level.setBlockAndUpdate(target, Blocks.STONE.defaultBlockState());
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && evidence(level, target).state()
                                == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "fixture target did not become KNOWN_BLOCK before occlusion"))
                .thenExecute(() -> {
                    level.setBlockAndUpdate(blocker, Blocks.STONE.defaultBlockState());
                    JsonObject args = new JsonObject();
                    args.add("position", positionJson(target));
                    tools.call(JsonParser.parseString("\"ray-mismatch\""),
                            "break_block", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "ray mismatch did not reach a terminal result"))
                .thenExecute(() -> {
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean(),
                            "different first hit was interacted with: " + terminal.get());
                    helper.assertTrue(level.getBlockState(blocker).is(Blocks.STONE)
                                    && level.getBlockState(target).is(Blocks.STONE),
                            "ray mismatch mutated the blocker or evidence-bound target");
                    BlockEvidenceCell blockerEvidence = evidence(level, blocker);
                    helper.assertTrue(blockerEvidence.state()
                                    == BlockEvidenceCell.State.KNOWN_BLOCK
                                    && blockerEvidence.source() == BlockEvidenceSource.MISMATCH,
                            "ray mismatch did not update only its attributable first hit evidence: "
                                    + blockerEvidence);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 180, batch = "embodied_boundary_interact_air")
    public static void use_item_supports_an_optional_current_facing_known_air_aim(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(1024));
        BlockPos aim = feet.east(5).above();
        long[] before = new long[1];
        int[] remaining = new int[1];
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(14L);

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -3), feet.offset(7, 4, 3))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND,
                            new ItemStack(Items.SNOWBALL, 2));
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND,
                            ItemStack.EMPTY);
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && evidence(level, aim).state()
                                == BlockEvidenceCell.State.KNOWN_AIR,
                        "air-use fixture aim did not become KNOWN_AIR"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.addProperty("item_id", "minecraft:snowball");
                    tools.call(JsonParser.parseString("\"known-air-right\""),
                            "use_item", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "KNOWN_AIR right interaction did not reach a terminal result"))
                .thenExecute(() -> {
                    remaining[0] = bot.get().getMainHandItem().getCount();
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND,
                            ItemStack.EMPTY);
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && remaining[0] == 1,
                            "KNOWN_AIR right interaction did not use exactly one snowball: "
                                    + terminal.get() + ", remaining=" + remaining[0]);
                    BlockEvidenceCell refreshed = evidence(level, aim);
                    helper.assertTrue(refreshed.state() == BlockEvidenceCell.State.KNOWN_AIR
                                    && refreshed.source()
                                    == BlockEvidenceSource.ATTRIBUTABLE_ACTION,
                            "successful air use did not refresh only its exact aim: " + refreshed);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 180, batch = "embodied_boundary_interact_air_mismatch")
    public static void use_item_known_air_rejects_a_different_first_hit(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(1280));
        BlockPos blocker = feet.east().above();
        BlockPos aim = feet.east(2).above();
        long[] before = new long[1];
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(15L);

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -3), feet.offset(6, 4, 3))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND,
                            ItemStack.EMPTY);
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND,
                            ItemStack.EMPTY);
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && evidence(level, aim).state()
                                == BlockEvidenceCell.State.KNOWN_AIR,
                        "air mismatch fixture aim did not become KNOWN_AIR"))
                .thenExecute(() -> {
                    level.setBlockAndUpdate(blocker, Blocks.STONE.defaultBlockState());
                    JsonObject args = new JsonObject();
                    args.add("aim", positionJson(aim));
                    tools.call(JsonParser.parseString("\"known-air-mismatch\""),
                            "use_item", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "KNOWN_AIR ray mismatch did not reach a terminal result"))
                .thenExecute(() -> {
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.get("message").getAsString().contains("first hit"),
                            "KNOWN_AIR different first hit was not a ray mismatch: "
                                    + terminal.get());
                    helper.assertTrue(level.getBlockState(blocker).is(Blocks.STONE),
                            "KNOWN_AIR mismatch interacted with its blocker");
                    helper.assertTrue(evidence(level, blocker).source()
                                    == BlockEvidenceSource.MISMATCH,
                            "KNOWN_AIR mismatch did not refresh its first hit");
                    helper.assertTrue(evidence(level, aim).state()
                                    == BlockEvidenceCell.State.KNOWN_AIR
                                    && evidence(level, aim).source()
                                    != BlockEvidenceSource.MISMATCH,
                            "KNOWN_AIR mismatch rewrote the unaffected aim");
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 180, batch = "embodied_boundary_interact_ender_eye")
    public static void use_item_rejects_a_preheld_ender_eye_on_a_known_block(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(1536));
        BlockPos aim = feet.east(2).above();
        long[] before = new long[1];
        int[] remaining = new int[1];
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(16L);

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -3), feet.offset(7, 4, 3))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    level.setBlockAndUpdate(aim, Blocks.END_PORTAL_FRAME.defaultBlockState());
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND,
                            new ItemStack(Items.ENDER_EYE));
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND,
                            ItemStack.EMPTY);
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && evidence(level, aim).state()
                                == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "Ender Eye fixture aim did not become KNOWN_BLOCK"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("aim", positionJson(aim));
                    tools.call(JsonParser.parseString("\"generic-ender-eye\""),
                            "use_item", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "generic Ender Eye interaction did not reach a terminal result"))
                .thenExecute(() -> {
                    remaining[0] = bot.get().getMainHandItem().getCount();
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND,
                            ItemStack.EMPTY);
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.get("message").getAsString()
                                    .contains("throw_eye_of_ender")
                                    && remaining[0] == 1
                                    && level.getBlockState(aim)
                                    .is(Blocks.END_PORTAL_FRAME),
                            "generic use_item duplicated or consumed Ender Eye semantics: "
                                    + terminal.get() + ", remaining=" + remaining[0]);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 180, batch = "embodied_boundary_interact_hold")
    public static void use_item_rejects_an_invalid_unbounded_hold(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(1792));
        BlockPos target = feet.east(2).above();
        long[] before = new long[1];
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(17L);

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -3), feet.offset(5, 4, 3))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    level.setBlockAndUpdate(target, Blocks.STONE.defaultBlockState());
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && evidence(level, target).state()
                                == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "hold fixture target did not become KNOWN_BLOCK"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("aim", positionJson(target));
                    args.addProperty("hold_ticks", -2);
                    tools.call(JsonParser.parseString("\"invalid-hold\""),
                            "use_item", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "invalid hold did not reach a terminal result"))
                .thenExecute(() -> {
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.get("message").getAsString()
                                    .contains("-1 or non-negative"),
                            "invalid unbounded hold reached physical execution: "
                                    + terminal.get());
                    helper.assertTrue(level.getBlockState(target).is(Blocks.STONE),
                            "invalid hold mutated its target");
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 180, batch = "embodied_boundary_interact_control")
    public static void break_block_is_busy_and_cancellable_by_request_id(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(2048));
        BlockPos target = feet.east(2).above();
        long[] before = new long[1];
        boolean[] cancelled = new boolean[1];
        AtomicReference<String> firstTerminal = new AtomicReference<>();
        AtomicReference<String> secondTerminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(18L);

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -3), feet.offset(5, 4, 3))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    level.setBlockAndUpdate(target, Blocks.OBSIDIAN.defaultBlockState());
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND,
                            ItemStack.EMPTY);
                    bot.get().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND,
                            ItemStack.EMPTY);
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && evidence(level, target).state()
                                == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "control fixture target did not become KNOWN_BLOCK"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("position", positionJson(target));
                    var firstId = JsonParser.parseString("\"long-left\"");
                    tools.call(firstId, "break_block", args, firstTerminal::set);
                    tools.call(JsonParser.parseString("\"second-left\""),
                            "break_block", args, secondTerminal::set);
                    cancelled[0] = tools.cancel(firstId);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        firstTerminal.get() != null && secondTerminal.get() != null,
                        "busy/cancel interaction calls did not both terminate"))
                .thenExecute(() -> {
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                    JsonObject first = JsonParser.parseString(firstTerminal.get()).getAsJsonObject();
                    JsonObject second = JsonParser.parseString(secondTerminal.get()).getAsJsonObject();
                    helper.assertTrue(cancelled[0]
                                    && !first.get("success").getAsBoolean()
                                    && first.has("interrupted")
                                    && first.get("interrupted").getAsBoolean(),
                            "task.cancel did not cancel sync break_block by request id: "
                                    + firstTerminal.get());
                    helper.assertTrue(!second.get("success").getAsBoolean()
                                    && "busy".equals(second.get("failure_type").getAsString()),
                            "concurrent break_block did not return busy: "
                                    + secondTerminal.get());
                    helper.assertTrue(level.getBlockState(target).is(Blocks.OBSIDIAN),
                            "cancelled/busy interactions changed their target");
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 180, batch = "embodied_boundary_interact_entity_visible")
    public static void interact_entity_right_clicks_only_a_visible_uuid(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(2304));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<Sheep> sheep = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(19L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -2, -3), feet.offset(6, 4, 3))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-2, -1, -3), feet.offset(6, -1, 3))) {
                        level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
                    }
                    bot.get().getInventory().clearContent();
                    bot.get().getInventory().add(new ItemStack(Items.SHEARS));
                    bot.get().fallDistance = 0.0F;
                    bot.get().setHealth(bot.get().getMaxHealth());
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    Sheep target = EntityType.SHEEP.create(level);
                    helper.assertTrue(target != null, "sheep did not spawn");
                    target.moveTo(feet.getX() + 2.5, feet.getY(), feet.getZ() + 0.5,
                            90.0F, 0.0F);
                    target.setNoAi(true);
                    level.addFreshEntity(target);
                    sheep.set(target);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                sheep.get().getUUID())
                                .map(track -> track.state()
                                        == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "fixture sheep did not become a VISIBLE UUID track"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.addProperty("uuid", sheep.get().getUUID().toString());
                    args.addProperty("item_id", "minecraft:shears");
                    tools.call(JsonParser.parseString("\"visible-sheep\""),
                            "interact_entity", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "interact_entity did not reach a terminal result"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && sheep.get().isSheared(),
                            "VISIBLE UUID was not right-clicked with shears: " + terminal.get());
                    sheep.get().discard();
                    bot.get().getInventory().clearContent();
                    bot.get().setDeltaMovement(Vec3.ZERO);
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 360, batch = "embodied_boundary_interact_entity_known")
    public static void interact_entity_uses_frozen_position_and_loses_an_occluded_uuid(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(2560));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<Sheep> sheep = new AtomicReference<>();
        AtomicReference<Vec3> frozen = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(20L);
        long[] before = new long[1];
        long[] hiddenBefore = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-6, -2, -12), feet.offset(12, 5, 12))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-6, -1, -12), feet.offset(12, -1, 12))) {
                        level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
                    }
                    bot.get().getInventory().clearContent();
                    bot.get().getInventory().add(new ItemStack(Items.SHEARS));
                    bot.get().setInvulnerable(true);
                    bot.get().fallDistance = 0.0F;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    Sheep target = EntityType.SHEEP.create(level);
                    helper.assertTrue(target != null, "sheep did not spawn");
                    target.moveTo(feet.getX() + 6.5, feet.getY(), feet.getZ() + 0.5,
                            90.0F, 0.0F);
                    target.setNoAi(true);
                    level.addFreshEntity(target);
                    sheep.set(target);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                sheep.get().getUUID())
                                .map(track -> track.state()
                                        == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "occlusion fixture sheep did not become VISIBLE"))
                .thenExecute(() -> {
                    var visible = RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    sheep.get().getUUID())
                            .orElseThrow(() -> new AssertionError("VISIBLE track disappeared"));
                    frozen.set(visible.position());
                    BlockPos wall = feet.east(8);
                    for (BlockPos position : BlockPos.betweenClosed(
                            wall.offset(0, 0, -12), wall.offset(0, 5, 12))) {
                        level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
                    }
                    sheep.get().moveTo(feet.getX() + 10.5, feet.getY(),
                            feet.getZ() + 0.5, 90.0F, 0.0F);
                    bot.get().moveTo(feet.getX() - 4.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    hiddenBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > hiddenBefore[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                sheep.get().getUUID())
                                .map(track -> track.state()
                                        == dev.mcagent.runtime.evidence.EntityTrack.State.KNOWN
                                        && track.position().equals(frozen.get()))
                                .orElse(false),
                        "occluded UUID did not become frozen KNOWN evidence"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.addProperty("uuid", sheep.get().getUUID().toString());
                    args.addProperty("item_id", "minecraft:shears");
                    tools.call(JsonParser.parseString("\"known-sheep\""),
                            "interact_entity", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "occluded interact_entity did not reach a terminal result"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.has("data")
                                    && "target_lost".equals(result.getAsJsonObject("data")
                                    .get("failure_type").getAsString()),
                            "occluded UUID did not fail target_lost: " + terminal.get());
                    helper.assertTrue(!sheep.get().isSheared(),
                            "occluded UUID was interacted with through hidden live state");
                    helper.assertTrue(bot.get().getX() < feet.getX() + 8.0,
                            "Bot crossed the occluder toward the hidden live position");
                    helper.assertTrue(RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    sheep.get().getUUID())
                                    .map(track -> track.position().equals(frozen.get()))
                                    .orElse(false),
                            "interact_entity refreshed the hidden live position");
                    sheep.get().discard();
                    bot.get().getInventory().clearContent();
                    bot.get().setDeltaMovement(Vec3.ZERO);
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                    bot.get().setInvulnerable(false);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 420, batch = "embodied_boundary_interact_entity_reacquire")
    public static void interact_entity_waits_for_the_same_uuid_to_become_visible_again(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(2816));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<Sheep> sheep = new AtomicReference<>();
        AtomicReference<Vec3> frozen = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(21L);
        long[] before = new long[1];
        long[] hiddenBefore = new long[1];
        long[] revealedBefore = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-12, -2, -10), feet.offset(12, 5, 10))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    for (BlockPos position : BlockPos.betweenClosed(
                            feet.offset(-12, -1, -10), feet.offset(12, -1, 10))) {
                        level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
                    }
                    bot.get().getInventory().clearContent();
                    bot.get().getInventory().add(new ItemStack(Items.SHEARS));
                    bot.get().setInvulnerable(true);
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    Sheep target = EntityType.SHEEP.create(level);
                    helper.assertTrue(target != null, "sheep did not spawn");
                    target.moveTo(feet.getX() + 6.5, feet.getY(), feet.getZ() + 0.5,
                            90.0F, 0.0F);
                    target.setNoAi(true);
                    level.addFreshEntity(target);
                    sheep.set(target);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                sheep.get().getUUID())
                                .map(track -> track.state()
                                        == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "reacquisition fixture sheep did not become VISIBLE"))
                .thenExecute(() -> {
                    frozen.set(RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    sheep.get().getUUID()).orElseThrow().position());
                    BlockPos wall = feet.east(8);
                    for (BlockPos position : BlockPos.betweenClosed(
                            wall.offset(0, 0, -10), wall.offset(0, 5, 10))) {
                        level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
                    }
                    sheep.get().moveTo(feet.getX() + 10.5, feet.getY(),
                            feet.getZ() + 0.5, 90.0F, 0.0F);
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    hiddenBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > hiddenBefore[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                sheep.get().getUUID())
                                .map(track -> track.state()
                                        == dev.mcagent.runtime.evidence.EntityTrack.State.KNOWN
                                        && track.position().equals(frozen.get()))
                                .orElse(false),
                        "reacquisition fixture did not freeze the KNOWN position"))
                .thenExecute(() -> {
                    helper.assertTrue(RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    sheep.get().getUUID())
                                    .map(track -> track.state()
                                            == dev.mcagent.runtime.evidence.EntityTrack.State.KNOWN)
                                    .orElse(false),
                            "interact_entity was not invoked from a KNOWN UUID");
                    JsonObject args = new JsonObject();
                    args.addProperty("uuid", sheep.get().getUUID().toString());
                    args.addProperty("item_id", "minecraft:shears");
                    tools.call(JsonParser.parseString("\"reacquired-sheep\""),
                            "interact_entity", args, terminal::set);
                })
                .thenExecute(() -> {
                    helper.assertTrue(terminal.get() == null && !sheep.get().isSheared(),
                            "KNOWN UUID was interacted with synchronously before evidence reacquisition: "
                                    + terminal.get());
                    helper.assertTrue(RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    sheep.get().getUUID())
                                    .map(track -> track.state()
                                            == dev.mcagent.runtime.evidence.EntityTrack.State.KNOWN
                                            && track.position().equals(frozen.get()))
                                    .orElse(false),
                            "KNOWN UUID changed before the fixture was revealed");
                    BlockPos wall = feet.east(8);
                    for (BlockPos position : BlockPos.betweenClosed(
                            wall.offset(0, 0, -10), wall.offset(0, 5, 10))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    sheep.get().moveTo(frozen.get().x, frozen.get().y, frozen.get().z,
                            90.0F, 0.0F);
                    bot.get().moveTo(frozen.get().x - 2.0, frozen.get().y,
                            frozen.get().z, -90.0F, 0.0F);
                    revealedBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer())
                                > revealedBefore[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                sheep.get().getUUID())
                                .map(track -> track.state()
                                        == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "same UUID did not return to VISIBLE evidence before interaction"))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "interact_entity did not finish after same-UUID reacquisition"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && sheep.get().isSheared(),
                            "same visible UUID was not interacted with after reacquisition: "
                                    + terminal.get());
                    sheep.get().discard();
                    bot.get().getInventory().clearContent();
                    bot.get().setDeltaMovement(Vec3.ZERO);
                    bot.get().fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.get().moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.get().getYRot(), bot.get().getXRot());
                    bot.get().setInvulnerable(false);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 600, batch = "embodied_boundary_collect_uuid")
    public static void collect_items_collects_one_exact_visible_uuid_and_removes_its_track(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(3072));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> diamond = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(23L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 14, 6);
                    bot.get().getInventory().clearContent();
                    bot.get().fallDistance = 0.0F;
                    // Keep the body and item in adjacent feet cells while their exact positions
                    // remain outside pickup overlap. Collection must keep approaching the evidence
                    // position instead of treating the adjacent node as terminal arrival.
                    bot.get().moveTo(feet.getX() + 0.05, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    diamond.set(spawnItem(level, feet.getX() + 1.95, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND, 2)));
                    diamond.get().setPickUpDelay(10_000);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                diamond.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "exact collection fixture did not publish a VISIBLE item UUID"))
                .thenExecute(() -> {
                    diamond.get().setPickUpDelay(0);
                    JsonArray uuids = new JsonArray();
                    uuids.add(diamond.get().getUUID().toString().toUpperCase(Locale.ROOT));
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-exact-diamond\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(1)
                .thenExecute(() -> helper.assertTrue(terminal.get() == null
                                && !diamond.get().isRemoved(),
                        "collect_items terminated before the exact target settled"))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "exact UUID collect_items did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 2,
                            "exact VISIBLE item UUID was not collected: " + terminal.get());
                    helper.assertTrue(diamond.get().isRemoved()
                                    && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    diamond.get().getUUID()).isEmpty(),
                            "attributable pickup did not immediately remove the exact UUID Track");
                    bot.get().getInventory().clearContent();
                    bot.get().getInventory().setItem(0, new ItemStack(Items.DIAMOND_PICKAXE));
                    bot.get().getInventory().setItem(1, new ItemStack(Items.COBBLESTONE));
                    bot.get().getInventory().selected = 0;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    diamond.set(spawnItem(level, feet.getX() + 2.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    diamond.get().setNoGravity(true);
                    diamond.get().setPickUpDelay(10_000);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                    terminal.set(null);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                diamond.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "hand-switch collection fixture did not become VISIBLE"))
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(diamond.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-hand-switch-diamond\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(2)
                .thenExecute(() -> {
                    // Scaffold placement temporarily selects its material slot while navigation
                    // owns the body. Reproduce that public handoff invariant deterministically:
                    // collect_items must restore the slot it inherited when the task terminates.
                    bot.get().getInventory().selected = 1;
                    diamond.get().setPickUpDelay(0);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "hand-switch exact UUID collect_items did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 1,
                            "hand-switch exact VISIBLE item UUID was not collected: "
                                    + terminal.get());
                    helper.assertTrue(bot.get().getInventory().countItem(Items.COBBLESTONE) == 1,
                            "collection unexpectedly consumed the handoff fixture material");
                    helper.assertTrue(bot.get().getInventory().selected == 0
                                    && bot.get().getMainHandItem().is(Items.DIAMOND_PICKAXE),
                            "collection did not restore the selected tool after a temporary"
                                    + " navigation-owned hand switch");
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 240, batch = "embodied_boundary_collect_falling")
    public static void collect_items_retries_a_falling_drop_after_its_position_changes(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(4864));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> falling = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(25L);
        long[] before = new long[1];
        double[] initialY = new double[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 16, 8);
                    bot.get().getInventory().clearContent();
                    bot.get().fallDistance = 0.0F;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    ItemEntity item = new ItemEntity(level, feet.getX() + 2.5,
                            feet.getY() + 6.5, feet.getZ() + 0.5,
                            new ItemStack(Items.DIAMOND));
                    item.setDeltaMovement(Vec3.ZERO);
                    item.setPickUpDelay(0);
                    level.addFreshEntity(item);
                    falling.set(item);
                    initialY[0] = item.getY();
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> {
                    var track = RuntimeKnowledgeFixtures.entity(level.getServer(),
                            falling.get().getUUID());
                    helper.assertTrue(RuntimeBotManager.observationRevision(level.getServer())
                                    > before[0]
                                    && track.map(value -> value.state()
                                    == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                    .orElse(false)
                                    && track.map(value -> value.position().y
                                    > feet.getY() + 4.0).orElse(false),
                            "falling item did not publish an airborne VISIBLE UUID");
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        falling.get().getY() < initialY[0] - 0.1
                                && falling.get().getY() > feet.getY() + 1.5,
                        "ordinary gravity did not produce an airborne position change"))
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(falling.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.addProperty("radius", 8);
                    tools.call(JsonParser.parseString("\"collect-falling-diamond\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(1)
                .thenExecute(() -> helper.assertTrue(terminal.get() == null
                                && !falling.get().isRemoved(),
                        "collect_items terminated before the moving target settled"))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "falling-item collect_items did not terminate after landing"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && result.getAsJsonObject("data")
                                    .get("collected_entities").getAsInt() == 1
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 1
                                    && falling.get().isRemoved(),
                            "ordinary falling item was not collected after position refresh: "
                                    + terminal.get());
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 700, batch = "embodied_boundary_collect_moving")
    public static void collect_items_retries_a_still_visible_moving_drop_after_navigation_failure(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(3328));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> moving = new AtomicReference<>();
        AtomicReference<ItemEntity> budget = new AtomicReference<>();
        AtomicReference<ItemEntity> glob = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(24L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 16, 8);
                    bot.get().getInventory().clearContent();
                    bot.get().fallDistance = 0.0F;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    // The initial evidence is deliberately airborne. nearGround navigation has
                    // no route to its height. The fixture moves this exact UUID to its landed
                    // position during the Runtime-owned retry wait so the public seam exercises
                    // the fresh-position retry deterministically.
                    ItemEntity item = new ItemEntity(level, feet.getX() + 2.5,
                            feet.getY() + 5.5, feet.getZ() + 0.5,
                            new ItemStack(Items.DIAMOND));
                    item.setPickUpDelay(0);
                    item.setNoGravity(true);
                    item.setDeltaMovement(Vec3.ZERO);
                    level.addFreshEntity(item);
                    moving.set(item);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> {
                    var track = RuntimeKnowledgeFixtures.entity(level.getServer(),
                            moving.get().getUUID());
                    helper.assertTrue(RuntimeBotManager.observationRevision(level.getServer())
                                    > before[0]
                                    && track.map(value -> value.state()
                                    == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                    .orElse(false)
                                    && track.map(value -> value.position().y
                                    > feet.getY() + 1.5).orElse(false),
                            "moving item did not publish an airborne VISIBLE UUID");
                })
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(moving.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.addProperty("radius", 8);
                    tools.call(JsonParser.parseString("\"collect-moving-diamond\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(12)
                // Lower bound: a zero/one/two-tick retry must not classify the still-airborne
                // exact UUID before the Runtime-owned retry window has elapsed.
                .thenExecute(() -> helper.assertTrue(terminal.get() == null,
                        "VISIBLE airborne exact target ended before its retry wait: "
                                + terminal.get()))
                .thenExecute(() -> {
                    moving.get().moveTo(feet.getX() + 2.5, feet.getY(),
                            feet.getZ() + 0.5, 0.0F, 0.0F);
                    moving.get().setDeltaMovement(Vec3.ZERO);
                })
                // Upper bound: after landing, the public collect_items outcome must be present
                // within ten ticks. This leaves the observed navigation/pickup overhead while
                // rejecting an implementation that waits 15 or 20 ticks before rebuilding.
                .thenExecuteAfter(10, () -> helper.assertTrue(terminal.get() != null,
                        "moving-item collect_items did not terminate within 10 ticks after landing"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && result.getAsJsonObject("data")
                                    .get("collected_entities").getAsInt() == 1
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 1
                                    && moving.get().isRemoved(),
                            "still-visible moving item was not collected after retry: "
                                    + terminal.get());
                    helper.assertTrue(RuntimeKnowledgeFixtures.entity(level.getServer(),
                            moving.get().getUUID()).isEmpty(),
                            "collected moving UUID Track was not removed");
                    bot.get().getInventory().clearContent();
                    ItemEntity unreachable = new ItemEntity(level, feet.getX() + 2.5,
                            feet.getY() + 5.5, feet.getZ() + 0.5,
                            new ItemStack(Items.DIAMOND));
                    unreachable.setPickUpDelay(0);
                    unreachable.setNoGravity(true);
                    unreachable.setDeltaMovement(Vec3.ZERO);
                    level.addFreshEntity(unreachable);
                    budget.set(unreachable);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                    terminal.set(null);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                budget.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "permanently airborne exact budget fixture did not become VISIBLE"))
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(budget.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.addProperty("radius", 8);
                    tools.call(JsonParser.parseString("\"collect-budget-diamond\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(35)
                // Lower bound: zero, one, or two rebuilds must not exhaust this fixture before
                // the 35-tick checkpoint.
                .thenExecute(() -> helper.assertTrue(terminal.get() == null,
                        "VISIBLE unreachable exact target exhausted retry budget too early: "
                                + terminal.get()))
                // Upper bound: four rebuilds completed in 59 ticks in the calibrated runtime;
                // 27 more ticks after the lower checkpoint (62 from call) covers normal failure
                // overhead but leaves a fifth rebuild outside the deadline.
                .thenExecuteAfter(27, () -> helper.assertTrue(terminal.get() != null,
                        "visible unreachable exact target did not exhaust retry budget within "
                                + "62 ticks of the public call"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "unreachable".equals(data.get("failure_type").getAsString())
                                    && data.get("skipped_entities").getAsInt() == 1
                                    && !budget.get().isRemoved(),
                            "visible unreachable exact target did not return unreachable: "
                                    + terminal.get());
                    bot.get().getInventory().clearContent();
                    ItemEntity globItem = new ItemEntity(level, feet.getX() + 2.5,
                            feet.getY() + 5.5, feet.getZ() + 0.5,
                            new ItemStack(Items.EMERALD));
                    globItem.setPickUpDelay(0);
                    globItem.setNoGravity(true);
                    globItem.setDeltaMovement(Vec3.ZERO);
                    level.addFreshEntity(globItem);
                    glob.set(globItem);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                    terminal.set(null);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                glob.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "Glob airborne fixture did not become VISIBLE"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("uuids", JsonNull.INSTANCE);
                    args.addProperty("item_id_glob", "minecraft:emerald");
                    args.addProperty("radius", 8);
                    tools.call(JsonParser.parseString("\"collect-glob-airborne\""),
                            "collect_items", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "Glob airborne target did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "unreachable".equals(data.get("failure_type").getAsString())
                                    && data.get("skipped_entities").getAsInt() == 1
                                    && !glob.get().isRemoved(),
                            // A still-visible glob drop that navigation cannot reach is
                            // retried and then skipped as unreachable, not lost.
                            "Glob airborne visible target was not skipped as unreachable: "
                                    + terminal.get());
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_collection_admissibility", template = "floor16",
            timeoutTicks = 220, batch = "embodied_boundary_collect_admissibility")
    public static void collect_items_keeps_still_known_out_of_radius_uuid_unreachable(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(5120));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> item = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(30L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 26, 8);
                    bot.get().getInventory().clearContent();
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    ItemEntity spawned = spawnItem(level, feet.getX() + 2.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND));
                    spawned.setPickUpDelay(10_000);
                    spawned.setUnlimitedLifetime();
                    item.set(spawned);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                item.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "admissibility fixture did not become VISIBLE"))
                .thenExecute(() -> {
                    item.get().moveTo(feet.getX() + 9.5, feet.getY(), feet.getZ() + 0.5,
                            0.0F, 0.0F);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                item.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE
                                && track.position().x > feet.getX() + 8).orElse(false),
                        "admissibility fixture did not publish its still-known out-of-radius position"))
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(item.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.addProperty("radius", 8);
                    tools.call(JsonParser.parseString("\"collect-out-of-radius\""),
                            "collect_items", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "out-of-radius exact collection did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "unreachable".equals(data.get("failure_type").getAsString())
                                    && data.get("skipped_entities").getAsInt() == 1
                                    && notPickedUp(item.get()),
                            "still-known out-of-radius UUID was mislabeled target_lost: "
                                    + terminal.get());
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 220, batch = "embodied_boundary_collect_multi_uuid")
    public static void collect_items_reconciles_same_tick_pickup_for_each_exact_uuid(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(3840));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> first = new AtomicReference<>();
        AtomicReference<ItemEntity> second = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(26L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 14, 6);
                    bot.get().getInventory().clearContent();
                    bot.get().fallDistance = 0.0F;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    first.set(spawnItem(level, feet.getX() + 2.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    second.set(spawnItem(level, feet.getX() + 2.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                first.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false)
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                second.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "multi-UUID collection fixtures did not become VISIBLE"))
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(first.get().getUUID().toString());
                    uuids.add(second.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-two-diamonds\""),
                            "collect_items", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "multi-UUID collect_items did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && data.get("collected_entities").getAsInt() == 2
                                    && data.get("collected_items").getAsInt() == 2
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 2,
                            "same-tick pickup was not attributed to both exact UUIDs: "
                                    + terminal.get());
                    helper.assertTrue(first.get().isRemoved() && second.get().isRemoved()
                                    && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    first.get().getUUID()).isEmpty()
                                    && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    second.get().getUUID()).isEmpty(),
                            "same-tick pickup did not immediately remove both exact UUID Tracks");
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 300, batch = "embodied_boundary_collect_partial")
    public static void collect_items_skips_a_lost_glob_target_and_collects_the_next(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(4096));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> lost = new AtomicReference<>();
        AtomicReference<ItemEntity> survivor = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(27L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 14, 6);
                    bot.get().getInventory().clearContent();
                    bot.get().fallDistance = 0.0F;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    lost.set(spawnItem(level, feet.getX() + 2.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    survivor.set(spawnItem(level, feet.getX() + 5.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    lost.get().setPickUpDelay(10_000);
                    survivor.get().setPickUpDelay(10_000);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                lost.get().getUUID()).isPresent()
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                survivor.get().getUUID()).isPresent(),
                        "partial collection fixtures did not enter embodied evidence"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("uuids", JsonNull.INSTANCE);
                    args.addProperty("item_id_glob", "minecraft:diamond");
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-partial-diamonds\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(2)
                .thenExecute(() -> {
                    lost.get().discard();
                    survivor.get().setPickUpDelay(0);
                    survivor.get().moveTo(bot.get().getX(), bot.get().getY(), bot.get().getZ());
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "partial collect_items did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && data.get("collected_entities").getAsInt() == 1
                                    && data.get("collected_items").getAsInt() == 1
                                    && data.get("skipped_entities").getAsInt() == 1
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 1,
                            "lost Glob target stopped collection of the next target: "
                                    + terminal.get());
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 700, batch = "embodied_boundary_collect_all_skipped")
    public static void collect_items_distinguishes_unreachable_from_expired_targets(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(4352));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> first = new AtomicReference<>();
        AtomicReference<ItemEntity> second = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(28L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 14, 6);
                    bot.get().getInventory().clearContent();
                    bot.get().fallDistance = 0.0F;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    first.set(spawnItem(level, feet.getX() + 2.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    second.set(spawnItem(level, feet.getX() + 5.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    first.get().setPickUpDelay(10_000);
                    second.get().setPickUpDelay(10_000);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                first.get().getUUID()).isPresent()
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                second.get().getUUID()).isPresent(),
                        "all-skipped collection fixtures did not enter embodied evidence"))
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(first.get().getUUID().toString());
                    uuids.add(second.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.add("item_id_glob", JsonNull.INSTANCE);
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-lost-diamonds\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(2)
                .thenExecute(() -> {
                    first.get().discard();
                    second.get().discard();
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "all-skipped collect_items did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "unreachable".equals(data.get("failure_type").getAsString())
                                    && "uuids".equals(data.get("selection").getAsString())
                                    && data.get("collected_entities").getAsInt() == 0
                                    && data.get("collected_items").getAsInt() == 0
                                    && data.get("skipped_entities").getAsInt() == 2,
                            "all still-known UUID targets did not return unreachable: "
                                    + terminal.get());
                    terminal.set(null);
                })
                .thenIdle(401)
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(first.get().getUUID().toString());
                    uuids.add(second.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.add("item_id_glob", JsonNull.INSTANCE);
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-expired-diamonds\""),
                            "collect_items", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "expired collect_items did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "target_lost".equals(data.get("failure_type").getAsString())
                                    && data.get("collected_entities").getAsInt() == 0
                                    && data.get("collected_items").getAsInt() == 0
                                    && data.get("skipped_entities").getAsInt() == 2,
                            "expired UUID targets did not return target_lost: "
                                    + terminal.get());
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 220, batch = "embodied_boundary_collect_ambiguous")
    public static void collect_items_does_not_invent_identity_for_ambiguous_pickup_delta(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(4608));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> first = new AtomicReference<>();
        AtomicReference<ItemEntity> second = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(29L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 14, 6);
                    bot.get().getInventory().clearContent();
                    bot.get().fallDistance = 0.0F;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    first.set(spawnItem(level, feet.getX() + 0.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    second.set(spawnItem(level, feet.getX() + 1.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    first.get().setPickUpDelay(10_000);
                    second.get().setPickUpDelay(10_000);
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                first.get().getUUID()).isPresent()
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                second.get().getUUID()).isPresent(),
                        "ambiguous collection fixtures did not enter embodied evidence"))
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(first.get().getUUID().toString());
                    uuids.add(second.get().getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.add("item_id_glob", JsonNull.INSTANCE);
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-ambiguous-diamonds\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(2)
                .thenExecute(() -> {
                    bot.get().getInventory().add(new ItemStack(Items.DIAMOND));
                    first.get().discard();
                    second.get().discard();
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "ambiguous collect_items did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "unreachable".equals(data.get("failure_type").getAsString())
                                    && data.get("collected_entities").getAsInt() == 0
                                    && data.get("collected_items").getAsInt() == 0
                                    && data.get("skipped_entities").getAsInt() == 2
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 1,
                            "ambiguous inventory delta invented a collected UUID or used the wrong failure category: "
                                    + terminal.get());
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 320, batch = "embodied_boundary_collect_glob")
    public static void collect_items_glob_uses_frozen_known_positions_and_default_radius(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(5376));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> target = new AtomicReference<>();
        AtomicReference<ItemEntity> outside = new AtomicReference<>();
        AtomicReference<Vec3> frozen = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(24L);
        long[] visibleBefore = new long[1];
        long[] hiddenBefore = new long[1];
        long[] revealBefore = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 22, 10);
                    bot.get().getInventory().clearContent();
                    bot.get().setInvulnerable(true);
                    bot.get().setDeltaMovement(Vec3.ZERO);
                    bot.get().fallDistance = 0.0F;
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    target.set(spawnItem(level, feet.getX() + 2.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    target.get().setPickUpDelay(10_000);
                    outside.set(spawnItem(level, feet.getX() + 9.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.DIAMOND)));
                    outside.get().setPickUpDelay(10_000);
                    visibleBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > visibleBefore[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                target.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false)
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                outside.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "Glob collection fixtures did not become VISIBLE"))
                .thenExecute(() -> {
                    frozen.set(RuntimeKnowledgeFixtures.entity(level.getServer(),
                            target.get().getUUID()).orElseThrow().position());
                    BlockPos wall = feet.east(4);
                    for (BlockPos position : BlockPos.betweenClosed(
                            wall.offset(0, 0, -10), wall.offset(0, 5, 10))) {
                        level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
                    }
                    target.get().moveTo(feet.getX() + 6.5, feet.getY(),
                            feet.getZ() + 0.5);
                    hiddenBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > hiddenBefore[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                target.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.KNOWN
                                && track.position().equals(frozen.get())).orElse(false),
                        "Glob target did not become a frozen KNOWN item Track"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("uuids", JsonNull.INSTANCE);
                    args.addProperty("item_id_glob", "minecraft:diamond");
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-known-diamond\""),
                            "collect_items", args, terminal::set);
                })
                .thenIdle(5)
                .thenExecute(() -> {
                    helper.assertTrue(terminal.get() == null
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 0,
                            "KNOWN Glob target was collected through hidden live state");
                    helper.assertTrue(RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    target.get().getUUID()).map(track -> track.position()
                                    .equals(frozen.get())).orElse(false),
                            "Glob collection refreshed the hidden live item position");
                    BlockPos wall = feet.east(4);
                    for (BlockPos position : BlockPos.betweenClosed(
                            wall.offset(0, 0, -10), wall.offset(0, 5, 10))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    target.get().moveTo(frozen.get().x, frozen.get().y, frozen.get().z);
                    revealBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > revealBefore[0]
                                && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                target.get().getUUID()).map(track -> track.state()
                                == dev.mcagent.runtime.evidence.EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "same item UUID did not become VISIBLE after reveal"))
                // Keep pickup disabled until the observation seam has actually published the
                // reacquired UUID. Otherwise an already-near collector can absorb the item in
                // the entity tick between wall removal and the next scheduled observation.
                .thenExecute(() -> target.get().setPickUpDelay(0))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "Glob collect_items did not finish after item reacquisition"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && bot.get().getInventory().countItem(Items.DIAMOND) == 1,
                            "KNOWN Glob item was not collected after VISIBLE reacquisition: "
                                    + terminal.get());
                    helper.assertTrue(notPickedUp(outside.get())
                                    && data(result).get("collected_entities").getAsInt() == 1,
                            "default radius 8 collected a Track frozen 9 blocks away (removal="
                                    + outside.get().getRemovalReason() + ", result="
                                    + terminal.get() + ")");
                    outside.get().discard();
                    bot.get().setInvulnerable(false);
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 220, batch = "embodied_boundary_collect_no_live_scan")
    public static void collect_items_glob_does_not_discover_a_never_observed_hidden_drop(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BlockPos feet = chunkCenteredArenaFeet(helper.absolutePos(new BlockPos(4, 260, 4)).south(3584));
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<BotPlayer> bot = new AtomicReference<>();
        AtomicReference<ItemEntity> hidden = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() ->
                RuntimeBotManager.current(level.getServer()).orElse(null));
        tools.sessionOpened(25L);
        long[] before = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    bot.set(RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created")));
                    prepareItemArena(level, feet, 14, 10);
                    bot.get().getInventory().clearContent();
                    BlockPos wall = feet.east(3);
                    for (BlockPos position : BlockPos.betweenClosed(
                            wall.offset(0, 0, -10), wall.offset(0, 5, 10))) {
                        level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
                    }
                    bot.get().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    hidden.set(spawnItem(level, feet.getX() + 6.5, feet.getY(),
                            feet.getZ() + 0.5, new ItemStack(Items.EMERALD)));
                    before[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenIdle(5)
                .thenExecute(() -> {
                    helper.assertTrue(RuntimeBotManager.observationRevision(level.getServer())
                                    > before[0]
                                    && RuntimeKnowledgeFixtures.entity(level.getServer(),
                                    hidden.get().getUUID()).isEmpty(),
                            "wall-hidden drop unexpectedly entered Entity Tracks");
                    JsonObject args = new JsonObject();
                    args.add("uuids", JsonNull.INSTANCE);
                    args.addProperty("item_id_glob", "minecraft:emerald");
                    args.add("radius", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"collect-hidden-emerald\""),
                            "collect_items", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "hidden-drop Glob collection did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.has("data")
                                    && "unknown_not_known".equals(result.getAsJsonObject("data")
                                    .get("failure_type").getAsString()),
                            "empty knowledge was not returned as unknown/not-known: "
                                    + terminal.get());
                    helper.assertTrue(!hidden.get().isRemoved()
                                    && bot.get().getInventory().countItem(Items.EMERALD) == 0,
                            "collect_items performed a live AABB scan through the wall");
                    hidden.get().discard();
                    cleanupItemArena(level, bot.get());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty", timeoutTicks = 200,
            batch = "embodied_boundary")
    public static void visible_cells_are_remembered_but_wall_hidden_cells_stay_unknown(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        RuntimeEvidenceGateway queries = new DefaultRuntimeEvidenceGateway(level.getServer());
        BlockPos feet = helper.absolutePos(new BlockPos(4, 140, 4));
        for (BlockPos position : BlockPos.betweenClosed(feet.offset(-4, -2, -4),
                feet.offset(4, 4, 4))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
        BlockPos eyeCell = feet.above();
        BlockPos wall = eyeCell.east();
        BlockPos hidden = eyeCell.east(2);
        BlockPos visibleAir = eyeCell.north();
        BlockPos glass = eyeCell.west();
        BlockPos throughGlass = eyeCell.west(2);
        for (int y = -1; y <= 1; y++) {
            for (int z = -1; z <= 1; z++) {
                level.setBlockAndUpdate(wall.offset(0, y, z), Blocks.STONE.defaultBlockState());
            }
        }
        level.setBlockAndUpdate(hidden, Blocks.DIAMOND_ORE.defaultBlockState());
        long[] before = new long[1];
        long[] transparentBefore = new long[1];
        long[] unloadedBefore = new long[1];
        long[] embodiedBefore = new long[1];
        BlockPos[] unloaded = new BlockPos[1];
        BlockPos embodiedFeet = feet.offset(40, 0, 0);
        BlockPos contactFloor = embodiedFeet.below();
        BlockPos shapeEye = embodiedFeet.above();
        BlockPos bottomSlab = shapeEye.east();
        BlockPos visibleThroughGap = shapeEye.east(2);
        BlockPos topSlab = shapeEye.west();
        BlockPos downwardAir = embodiedFeet.north().below(2);
        BlockPos downwardBlocker = embodiedFeet.north().below(3);
        BlockPos belowDownwardBlocker = embodiedFeet.north().below(4);

        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(
                        stabilizeCurrentBot(level, feet, 90.0F),
                        "Runtime Bot did not stabilize before embodied conformance"))
                .thenExecute(() -> before[0] = RuntimeBotManager.observationRevision(
                        level.getServer()))
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before[0],
                        "scheduled Observation Refresh did not publish a frame"))
                .thenExecute(() -> {
                    assertState(helper, level, wall, BlockEvidenceCell.State.KNOWN_BLOCK);
                    assertState(helper, level, visibleAir, BlockEvidenceCell.State.KNOWN_AIR);
                    assertState(helper, level, hidden, BlockEvidenceCell.State.UNKNOWN);
                    level.setBlockAndUpdate(glass, Blocks.GLASS.defaultBlockState());
                    level.setBlockAndUpdate(throughGlass, Blocks.GOLD_ORE.defaultBlockState());
                    RuntimeBotManager.current(level.getServer())
                            .orElseThrow(() -> new AssertionError("Runtime Bot was not created"))
                            .setYRot(90.0F);
                    transparentBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > transparentBefore[0],
                        "transparent scene did not receive a scheduled frame"))
                .thenExecute(() -> {
                    assertState(helper, level, glass, BlockEvidenceCell.State.KNOWN_BLOCK);
                    assertState(helper, level, throughGlass, BlockEvidenceCell.State.KNOWN_BLOCK);
                    BlockEvidenceCell target = RuntimeKnowledgeFixtures.block(level.getServer(),
                            level.dimension().location().toString(), throughGlass);
                    helper.assertTrue(target.source() == BlockEvidenceSource.VISION,
                            "transparent target was not admitted by eye-origin vision");

                    unloaded[0] = nearestUnloadedCell(level, eyeCell);
                    helper.assertTrue(unloaded[0] != null,
                            "test fixture has no unloaded cell within the observation range");
                    helper.assertTrue(!isLoaded(level, unloaded[0]),
                            "unloaded test cell was already loaded");
                    unloadedBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > unloadedBefore[0],
                        "unloaded-boundary scene did not receive a scheduled frame"))
                .thenExecute(() -> {
                    helper.assertTrue(!isLoaded(level, unloaded[0]),
                            "Observation Refresh loaded terrain while observing");
                    assertState(helper, level, unloaded[0], BlockEvidenceCell.State.UNKNOWN);
                    String dimension = level.dimension().location().toString();
                    RuntimeBlockFindResult visibleGold = queries.blockFind(
                            dimension, CanonicalIdentifierGlob.compile("minecraft:gold_ore"));
                    helper.assertTrue(visibleGold.matches().size() == 1
                                    && visibleGold.matches().getFirst().position().equals(
                                    new RuntimeBlockPosition(throughGlass.getX(),
                                            throughGlass.getY(), throughGlass.getZ())),
                            "block.find did not search only known full-match block ids");
                    helper.assertTrue(!visibleGold.hasMore() && !visibleGold.complete(),
                            "known-only search claimed completeness beyond embodied evidence");
                    RuntimeBlockFindResult hiddenDiamond = queries.blockFind(
                            dimension, CanonicalIdentifierGlob.compile("minecraft:diamond_ore"));
                    helper.assertTrue(hiddenDiamond.matches().isEmpty()
                                    && !hiddenDiamond.complete(),
                            "empty block.find proved absence or discovered a hidden target");

                    RuntimeBlockPosition unknownPosition = new RuntimeBlockPosition(
                            unloaded[0].getX(), unloaded[0].getY(), unloaded[0].getZ());
                    RuntimeBlockRegionResult unknownRegion = queries.blockRegion(
                            dimension, bounds(unknownPosition, unknownPosition));
                    RuntimeBlockPaletteEntry unknownEntry = unknownRegion.palette().get(
                            unknownRegion.indices().getFirst());
                    helper.assertTrue(unknownEntry.state()
                                    == dev.mcagent.runtime.sdk.RuntimeBlockEvidence.State.UNKNOWN
                                    && !unknownRegion.complete(),
                            "block.region did not preserve UNKNOWN through its palette");
                    RuntimeBlockPosition knownPosition = new RuntimeBlockPosition(
                            throughGlass.getX(), throughGlass.getY(), throughGlass.getZ());
                    RuntimeBlockRegionResult knownRegion = queries.blockRegion(
                            dimension, bounds(knownPosition, knownPosition));
                    helper.assertTrue(knownRegion.complete()
                                    && knownRegion.palette().get(knownRegion.indices().getFirst()).state()
                                    == dev.mcagent.runtime.sdk.RuntimeBlockEvidence.State.KNOWN_BLOCK,
                            "fully known block.region was not complete");

                    assertRejected(helper, () -> queries.blockFind(
                            dimension, CanonicalIdentifierGlob.compile(
                                    "minecraft:(gold_ore)")),
                            "block.find accepted unsupported Glob syntax");
                    assertRejected(helper, () -> queries.blockRegion(dimension,
                                    bounds(new RuntimeBlockPosition(0, 0, 0),
                                            new RuntimeBlockPosition(128, 0, 0))),
                            "block.region accepted an axis longer than 128 cells");

                    for (BlockPos position : BlockPos.betweenClosed(
                            embodiedFeet.offset(-4, -6, -4), embodiedFeet.offset(4, 4, 4))) {
                        level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
                    }
                    level.setBlockAndUpdate(contactFloor, Blocks.STONE.defaultBlockState());
                    level.setBlockAndUpdate(bottomSlab, Blocks.STONE_SLAB.defaultBlockState()
                            .setValue(BlockStateProperties.SLAB_TYPE, SlabType.BOTTOM));
                    level.setBlockAndUpdate(visibleThroughGap,
                            Blocks.EMERALD_ORE.defaultBlockState());
                    level.setBlockAndUpdate(topSlab, Blocks.STONE_SLAB.defaultBlockState()
                            .setValue(BlockStateProperties.SLAB_TYPE, SlabType.TOP));
                    level.setBlockAndUpdate(downwardBlocker, Blocks.DEEPSLATE.defaultBlockState());
                    level.setBlockAndUpdate(belowDownwardBlocker,
                            Blocks.REDSTONE_ORE.defaultBlockState());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        stabilizeCurrentBot(level, embodiedFeet, 0.0F),
                        "Runtime Bot did not stabilize in the contact-evidence fixture"))
                .thenExecute(() -> embodiedBefore[0] = RuntimeBotManager.observationRevision(
                        level.getServer()))
                .thenWaitUntil(() -> {
                    helper.assertTrue(stabilizeCurrentBot(level, embodiedFeet, 0.0F)
                                    && RuntimeBotManager.observationRevision(level.getServer())
                                    > embodiedBefore[0]
                                && evidence(level, contactFloor).state()
                                == BlockEvidenceCell.State.KNOWN_BLOCK
                                && evidence(level, contactFloor).source()
                                == BlockEvidenceSource.CONTACT,
                            "embodied conformance scene did not admit the contact floor");
                })
                .thenExecute(() -> {
                    BlockEvidenceCell contact = evidence(level, contactFloor);
                    helper.assertTrue(contact.state() == BlockEvidenceCell.State.KNOWN_BLOCK,
                            "contact floor was not admitted as block evidence");
                    helper.assertTrue(contact.source() == BlockEvidenceSource.CONTACT,
                            "body collision did not retain CONTACT provenance");

                    assertState(helper, level, bottomSlab, BlockEvidenceCell.State.KNOWN_BLOCK);
                    assertState(helper, level, visibleThroughGap,
                            BlockEvidenceCell.State.KNOWN_BLOCK);
                    assertState(helper, level, topSlab, BlockEvidenceCell.State.KNOWN_BLOCK);

                    // The drop beside the feet is known only as far as the eye sees past the
                    // floor edge: the landing block and the air above it, not what it covers.
                    BlockEvidenceCell downward = evidence(level, downwardAir);
                    helper.assertTrue(downward.state() == BlockEvidenceCell.State.KNOWN_AIR,
                            "sight did not admit the visible air above the landing block");
                    helper.assertTrue(downward.source() == BlockEvidenceSource.VISION,
                            "air beside the feet was not admitted by eye-origin vision");
                    BlockEvidenceCell blocker = evidence(level, downwardBlocker);
                    helper.assertTrue(blocker.state() == BlockEvidenceCell.State.KNOWN_BLOCK,
                            "sight did not admit the visible landing block");
                    helper.assertTrue(blocker.source() == BlockEvidenceSource.VISION,
                            "landing block was not admitted by eye-origin vision");
                    assertState(helper, level, belowDownwardBlocker,
                            BlockEvidenceCell.State.UNKNOWN);
                    RuntimeBotManager.current(level.getServer()).ifPresent(
                            current -> current.setInvulnerable(false));
                })
                .thenSucceed();
    }

    private static boolean stabilizeCurrentBot(ServerLevel level, BlockPos feet, float yRot) {
        BotPlayer current = RuntimeBotManager.current(level.getServer()).orElse(null);
        if (current == null || !current.isAlive()) return false;

        Vec3 expected = Vec3.atBottomCenterOf(feet);
        current.setInvulnerable(true);
        if (current.position().distanceToSqr(expected) >= 0.25) {
            current.setDeltaMovement(Vec3.ZERO);
            current.fallDistance = 0.0F;
            current.moveTo(expected.x, expected.y, expected.z, yRot, 0.0F);
            return false;
        }
        return current.onGround();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 700, batch = "embodied_boundary_entity")
    public static void entity_tracks_freeze_while_hidden_and_expire_after_400_ticks(
            GameTestHelper helper) {
        ServerLevel level = provisionedLevel(helper);
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        RuntimeEvidenceGateway queries = new DefaultRuntimeEvidenceGateway(level.getServer());
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(22L);
        AtomicReference<String> expiredTerminal = new AtomicReference<>();
        AtomicReference<String> numericTerminal = new AtomicReference<>();
        BlockPos feet = helper.absolutePos(new BlockPos(4, 310, 4));
        for (BlockPos position : BlockPos.betweenClosed(feet.offset(-3, -2, -8),
                feet.offset(10, 4, 8))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
        bot.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, 90.0F, 0.0F);

        Zombie visibleZombie = spawnZombie(helper, level, feet.east(6));
        Zombie invisibleZombie = spawnZombie(helper, level, feet.south(5));
        invisibleZombie.setInvisible(true);
        BlockPos outOfRangePosition = feet.east(65);
        level.getChunkAt(outOfRangePosition);
        Zombie outOfRangeZombie = spawnZombie(helper, level, outOfRangePosition);
        ItemEntity diamond = new ItemEntity(level, feet.getX() + 0.5, feet.getY() + 1.0,
                feet.getZ() - 5.5, new ItemStack(Items.DIAMOND, 2));
        diamond.setNoGravity(true);
        diamond.setPickUpDelay(10_000);
        level.addFreshEntity(diamond);

        RuntimeEntityTrack[] visibleSnapshot = new RuntimeEntityTrack[1];
        long before = RuntimeBotManager.observationRevision(level.getServer());
        long[] hiddenBefore = new long[1];

        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > before
                                && queries.entityGet(visibleZombie.getUUID())
                                .map(track -> track.state() == RuntimeEntityTrack.State.VISIBLE)
                                .orElse(false)
                                && queries.entityGet(diamond.getUUID())
                                .map(track -> track.state() == RuntimeEntityTrack.State.VISIBLE)
                                .orElse(false),
                        "scheduled entity observation did not publish VISIBLE UUID tracks"))
                .thenExecute(() -> {
                    RuntimeEntityTrack track = queries.entityGet(visibleZombie.getUUID())
                            .orElseThrow(() -> new AssertionError("visible UUID track disappeared"));
                    visibleSnapshot[0] = track;
                    helper.assertTrue(track.uuid().equals(visibleZombie.getUUID()),
                            "entity.get did not preserve exact UUID identity");
                    helper.assertTrue(queries.entityGet(invisibleZombie.getUUID()).isEmpty(),
                            "ordinary visibility admitted an invisible entity");
                    helper.assertTrue(queries.entityGet(outOfRangeZombie.getUUID()).isEmpty(),
                            "entity observation exceeded its 64-block range");
                    helper.assertTrue(queries.entityGet(UUID.randomUUID()).isEmpty(),
                            "entity.get guessed an unknown UUID");

                    RuntimeEntityListResult items = queries.entityList(
                            level.dimension().location().toString(),
                            CanonicalIdentifierGlob.compile("minecraft:item"),
                            CanonicalIdentifierGlob.compile("minecraft:diamond"));
                    RuntimeEntityTrack exactDiamond = items.tracks().stream()
                            .filter(candidate -> candidate.uuid().equals(diamond.getUUID()))
                            .findFirst().orElse(null);
                    helper.assertTrue(exactDiamond != null && exactDiamond.itemCount() == 2
                                    && items.tracks().size() <= 256
                                    && items.tracks().stream().allMatch(candidate ->
                                    candidate.entityId().equals("minecraft:item")
                                            && candidate.itemId().equals("minecraft:diamond")),
                            "entity.list did not full-match bounded entity/item canonical ids");

                    BlockPos wall = feet.east(3);
                    for (int y = 0; y <= 2; y++) {
                        level.setBlockAndUpdate(wall.above(y), Blocks.STONE.defaultBlockState());
                    }
                    visibleZombie.moveTo(feet.getX() + 8.5, feet.getY(),
                            feet.getZ() + 0.5, 0.0F, 0.0F);
                    hiddenBefore[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > hiddenBefore[0]
                                && queries.entityGet(visibleZombie.getUUID())
                                .map(track -> track.state() == RuntimeEntityTrack.State.KNOWN)
                                .orElse(false),
                        "occluded entity did not transition to frozen KNOWN"))
                .thenExecute(() -> {
                    RuntimeEntityTrack hidden = queries.entityGet(visibleZombie.getUUID())
                            .orElseThrow(() -> new AssertionError("KNOWN UUID track disappeared"));
                    helper.assertTrue(hidden.position().equals(visibleSnapshot[0].position()),
                            "hidden entity position refreshed through the wall");
                    helper.assertTrue(hidden.observedTick() == visibleSnapshot[0].observedTick()
                                    && hidden.observationRevision()
                                    == visibleSnapshot[0].observationRevision(),
                            "hidden entity provenance advanced without visibility");
                })
                .thenIdle(401)
                .thenExecute(() -> {
                    helper.assertTrue(queries.entityGet(visibleZombie.getUUID()).isEmpty(),
                            "KNOWN Entity Track remained usable after 400 Ticks");
                    JsonObject expiredArgs = new JsonObject();
                    expiredArgs.addProperty("uuid", visibleZombie.getUUID().toString());
                    tools.call(JsonParser.parseString("\"expired-entity\""),
                            "interact_entity", expiredArgs, expiredTerminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(expiredTerminal.get() != null,
                        "expired UUID interact_entity did not terminate"))
                .thenExecute(() -> {
                    JsonObject expired = JsonParser.parseString(
                            expiredTerminal.get()).getAsJsonObject();
                    helper.assertTrue(!expired.get("success").getAsBoolean()
                                    && expired.has("data")
                                    && "target_lost".equals(expired.getAsJsonObject("data")
                                    .get("failure_type").getAsString()),
                            "expired Entity Track did not return target_lost: "
                                    + expiredTerminal.get());
                    JsonObject numericArgs = new JsonObject();
                    numericArgs.addProperty("entity_id", visibleZombie.getId());
                    tools.call(JsonParser.parseString("\"numeric-entity\""),
                            "interact_entity", numericArgs, numericTerminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(numericTerminal.get() != null,
                        "numeric entity id rejection did not terminate"))
                .thenExecute(() -> {
                    JsonObject numeric = JsonParser.parseString(
                            numericTerminal.get()).getAsJsonObject();
                    helper.assertTrue(!numeric.get("success").getAsBoolean()
                                    && numeric.get("message").getAsString().contains("uuid"),
                            "interact_entity accepted a numeric live entity id: "
                                    + numericTerminal.get());
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.getYRot(), bot.getXRot());
                })
                .thenSucceed();
    }

    private static ServerLevel provisionedLevel(GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.create(level.getServer(), "bot");
        return level;
    }

    private static Zombie spawnZombie(
            GameTestHelper helper, ServerLevel level, BlockPos position) {
        Zombie zombie = EntityType.ZOMBIE.create(level);
        helper.assertTrue(zombie != null, "zombie did not spawn");
        zombie.moveTo(position.getX() + 0.5, position.getY(), position.getZ() + 0.5,
                0.0F, 0.0F);
        zombie.setNoAi(true);
        zombie.setNoGravity(true);
        zombie.setInvulnerable(true);
        level.addFreshEntity(zombie);
        return zombie;
    }

    private static BlockPos chunkCenteredArenaFeet(BlockPos candidate) {
        ChunkPos chunk = new ChunkPos(candidate);
        return new BlockPos(chunk.getMiddleBlockX(), candidate.getY(), chunk.getMiddleBlockZ());
    }

    private static void prepareItemArena(
            ServerLevel level, BlockPos feet, int east, int lateral) {
        discardTestItems(level, feet, east, lateral);
        for (BlockPos position : BlockPos.betweenClosed(
                feet.offset(-3, -2, -lateral), feet.offset(east, 6, lateral))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        for (BlockPos position : BlockPos.betweenClosed(
                feet.offset(-3, -1, -lateral), feet.offset(east, -1, lateral))) {
            level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
        }
    }

    private static ItemEntity spawnItem(
            ServerLevel level, double x, double y, double z, ItemStack stack) {
        ItemEntity item = new ItemEntity(level, x, y, z, stack);
        item.setDeltaMovement(Vec3.ZERO);
        item.setNoGravity(true);
        item.setPickUpDelay(0);
        level.addFreshEntity(item);
        return item;
    }

    /**
     * An item reference reads as removed both when it was picked up and when its chunk unloaded
     * under the arena; only the first means the collector took it.
     */
    private static boolean notPickedUp(ItemEntity item) {
        return !item.isRemoved()
                || item.getRemovalReason() == net.minecraft.world.entity.Entity.RemovalReason.UNLOADED_TO_CHUNK;
    }

    private static JsonObject data(JsonObject result) {
        return result.getAsJsonObject("data");
    }

    private static void cleanupItemArena(ServerLevel level, BotPlayer bot) {
        bot.getInventory().clearContent();
        bot.setDeltaMovement(Vec3.ZERO);
        bot.fallDistance = 0.0F;
        Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
        bot.moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                bot.getYRot(), bot.getXRot());
    }

    private static void discardTestItems(
            ServerLevel level, BlockPos feet, int east, int lateral) {
        var bounds = new net.minecraft.world.phys.AABB(
                feet.getX() - 4, feet.getY() - 3, feet.getZ() - lateral - 1,
                feet.getX() + east + 2, feet.getY() + 8, feet.getZ() + lateral + 2);
        level.getEntitiesOfClass(ItemEntity.class, bounds).forEach(ItemEntity::discard);
    }

    private static void assertRejected(GameTestHelper helper, Runnable operation, String message) {
        try {
            operation.run();
            helper.fail(message);
        } catch (IllegalArgumentException expected) {
            // Expected public boundary rejection.
        }
    }

    private static BlockKnowledge.RegionBounds bounds(
            RuntimeBlockPosition min, RuntimeBlockPosition max) {
        return BlockKnowledge.RegionBounds.between(
                new BlockPos(min.x(), min.y(), min.z()),
                new BlockPos(max.x(), max.y(), max.z()));
    }

    private static BlockEvidenceCell evidence(ServerLevel level, BlockPos position) {
        return RuntimeKnowledgeFixtures.block(
                level.getServer(), level.dimension().location().toString(), position);
    }

    private static void assertState(GameTestHelper helper, ServerLevel level, BlockPos position,
                                    BlockEvidenceCell.State expected) {
        BlockEvidenceCell actual = evidence(level, position);
        helper.assertTrue(actual.state() == expected,
                "expected " + expected + " at " + position + ", got " + actual);
    }

    private static BlockPos nearestUnloadedCell(ServerLevel level, BlockPos origin) {
        for (int radius = 2; radius <= 7; radius++) {
            for (int dx = -radius; dx <= radius; dx++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) != radius) continue;
                    BlockPos candidate = new BlockPos(
                            ((origin.getX() >> 4) + dx) * 16 + 8,
                            origin.getY(),
                            ((origin.getZ() >> 4) + dz) * 16 + 8);
                    if (candidate.distSqr(origin) <= 127L * 127L && !isLoaded(level, candidate)) {
                        return candidate;
                    }
                }
            }
        }
        return null;
    }

    private static boolean isLoaded(ServerLevel level, BlockPos position) {
        return level.getChunkSource().getChunkNow(position.getX() >> 4, position.getZ() >> 4) != null;
    }

    private static JsonObject positionJson(BlockPos position) {
        JsonObject json = new JsonObject();
        json.addProperty("x", position.getX());
        json.addProperty("y", position.getY());
        json.addProperty("z", position.getZ());
        return json;
    }
}
