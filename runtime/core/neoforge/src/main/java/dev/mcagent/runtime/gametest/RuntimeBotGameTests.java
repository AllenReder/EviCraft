package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.entity.BotFactory;
import dev.mcagent.runtime.task.BotTickDispatcher;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.bot.RuntimeBotTrackingDiagnostics;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.knowledge.GroundedEvidencePolicy;
import dev.mcagent.runtime.knowledge.WorldKnowledgeProfile;
import dev.mcagent.runtime.sdk.RuntimeActorGateway;
import dev.mcagent.runtime.sdk.RuntimeActorView;
import dev.mcagent.runtime.sdk.RuntimeBuildInfo;
import dev.mcagent.runtime.sdk.RuntimeEvidenceGateway;
import dev.mcagent.runtime.sdk.RuntimeRpcDispatcher;
import dev.mcagent.runtime.sdk.RuntimeSimulationControl;
import dev.mcagent.runtime.sdk.RuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.RespawnAnchorBlock;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.Map;
import java.util.UUID;

@GameTestHolder("mc_agent_api")
@PrefixGameTestTemplate(false)
public final class RuntimeBotGameTests {

    private RuntimeBotGameTests() {}

    @GameTest(templateNamespace = "mc_agent_runtime_tracking", template = "floor16", timeoutTicks = 400,
            batch = "mc_agent_runtime")
    public static void runtime_bot_uses_configured_vanilla_tracking_lifecycle(
            GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        long runtimeBots = level.getServer().getPlayerList().getPlayers().stream()
                .filter(BotPlayer.class::isInstance)
                .filter(player -> player.getName().getString().equals("bot"))
                .count();
        helper.assertTrue(runtimeBots == 1, "expected exactly one Runtime Bot, got " + runtimeBots);
        helper.assertTrue(bot.getName().getString().equals("bot"), "Runtime Bot name changed");
        helper.assertTrue(BotTickDispatcher.currentTaskFor(bot.getUUID()) == null,
                "a fresh World Run restored an old task slot");
        helper.assertTrue(bot.blockPosition().equals(level.getSharedSpawnPos()),
                "Runtime Bot did not prefer the safe shared world spawn");
        RuntimeBotTrackingDiagnostics initial =
                RuntimeBotManager.trackingDiagnostics(level.getServer()).orElseThrow();
        RuntimeBotTrackingDiagnostics.TrackingState initialTracking =
                initial.tracking().orElseThrow(
                        () -> new AssertionError("vanilla tracking was not active at first join"));
        int expectedRequested = initial.configuredViewDistance().isPresent()
                ? initial.configuredViewDistance().getAsInt()
                : Math.max(2, level.getServer().getPlayerList().getViewDistance());
        helper.assertTrue(initial.requestedViewDistance() == expectedRequested,
                "default Runtime Bot View Distance did not use the server View Distance");
        helper.assertTrue(initial.effectiveViewDistance() == initialTracking.viewDistance(),
                "tracking diagnostics did not report the actual effective View Distance");
        helper.assertTrue(initialTracking.center().equals(bot.chunkPosition()),
                "first tracking center did not use the final safe spawn");

        RuntimeBotManager.start(level.getServer(), Map.of(
                "EVICRAFT_RUNTIME_VIEW_DISTANCE", "20",
                WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "loaded_world_state"));
        helper.assertTrue(RuntimeBotManager.trackingDiagnostics(level.getServer())
                        .orElseThrow().requestedViewDistance() == expectedRequested,
                "Runtime Bot View Distance changed after the World Run started");
        helper.assertTrue(RuntimeBotManager.worldKnowledgeProfile(level.getServer())
                        == WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                "World Knowledge Profile changed after the World Run started");

        BlockPos crossed = new BlockPos(
                level.getSharedSpawnPos().getX() + 512, 200,
                level.getSharedSpawnPos().getZ());
        ItemEntity[] tickingItem = new ItemEntity[1];
        double[] initialItemY = new double[1];
        ChunkPos[] trackedCenter = new ChunkPos[1];
        helper.startSequence()
                .thenExecute(() -> {
                    bot.setNoGravity(true);
                    bot.moveTo(crossed.getX() + 0.5, crossed.getY(),
                            crossed.getZ() + 0.5, bot.getYRot(), bot.getXRot());
                })
                .thenIdle(1)
                .thenExecute(() -> {
                    RuntimeBotTrackingDiagnostics.TrackingState moved =
                            RuntimeBotManager.trackingDiagnostics(level.getServer())
                                    .orElseThrow().tracking().orElseThrow();
                    helper.assertTrue(moved.section().equals(SectionPos.of(bot)),
                            "vanilla tracking section did not update on the next server tick");
                    helper.assertTrue(moved.center().equals(bot.chunkPosition()),
                            "vanilla tracking center did not update on the next server tick");
                })
                .thenWaitUntil(() -> {
                    RuntimeBotTrackingDiagnostics.TrackingState moved =
                            RuntimeBotManager.trackingDiagnostics(level.getServer())
                                    .orElseThrow()
                                    .tracking().orElseThrow();
                    ChunkPos inner = new ChunkPos(moved.center().x + moved.viewDistance(),
                            moved.center().z);
                    helper.assertTrue(level.getChunkSource().getChunkNow(inner.x, inner.z) != null,
                            "a chunk column inside Runtime Bot View Distance was not loaded");
                    helper.assertTrue(moved.pendingChunkCount() == 0
                                    && moved.unacknowledgedBatchCount() == 0,
                            "headless logical chunk delivery did not drain pending batches");
                    helper.assertTrue(level.getChunkSource().chunkMap
                                    .getPlayersCloseForSpawning(bot.chunkPosition()).contains(bot),
                            "Runtime Bot was absent from vanilla natural-spawn proximity");
                    trackedCenter[0] = moved.center();
                })
                .thenExecute(() -> {
                    RuntimeBotTrackingDiagnostics.TrackingState moved =
                            RuntimeBotManager.trackingDiagnostics(level.getServer())
                                    .orElseThrow().tracking().orElseThrow();
                    ChunkPos outer = new ChunkPos(
                            moved.center().x + moved.viewDistance() + 3, moved.center().z);
                    helper.assertTrue(level.getChunkSource().getChunkNow(outer.x, outer.z) == null,
                            "a chunk column outside Runtime Bot View Distance was loaded");
                    level.setBlockAndUpdate(bot.blockPosition().below(), Blocks.STONE.defaultBlockState());
                    bot.setNoGravity(false);
                    bot.fallDistance = 0.0F;
                    tickingItem[0] = new ItemEntity(level, bot.getX(), bot.getY() + 4.0,
                            bot.getZ(), new ItemStack(Items.STICK));
                    initialItemY[0] = tickingItem[0].getY();
                    level.addFreshEntity(tickingItem[0]);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        tickingItem[0].getY() < initialItemY[0],
                        "Runtime Bot simulation presence did not tick ordinary item gravity"))
                .thenExecute(() -> RuntimeBotManager.stop(level.getServer()))
                .thenWaitUntil(() -> {
                    helper.assertTrue(RuntimeBotManager.trackingDiagnostics(
                                    level.getServer()).isEmpty(),
                            "tracking diagnostics survived World Run stop");
                    helper.assertTrue(level.getChunkSource().getChunkNow(
                                    trackedCenter[0].x, trackedCenter[0].z) == null,
                            "isolated Runtime Bot tracking chunks did not unload after stop");
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_startup", template = "floor16", timeoutTicks = 400,
            batch = "mc_agent_runtime")
    public static void loaded_block_knowledge_follows_virtual_client_cache(
            GameTestHelper helper) {
        LoadedBlockKnowledgeGameTests
                .virtual_client_cache_follows_completed_logical_view_delivery(helper);
    }

    @GameTest(templateNamespace = "mc_agent_startup", template = "floor16", timeoutTicks = 1200,
            batch = "mc_agent_loaded_block_updates")
    public static void loaded_block_knowledge_updates_and_search_latency_use_cached_pages(
            GameTestHelper helper) {
        LoadedBlockKnowledgeGameTests
                .incremental_changes_and_search_latency_use_cached_pages(helper);
    }

    @GameTest(templateNamespace = "mc_agent_startup", template = "floor16", timeoutTicks = 400,
            batch = "mc_agent_loaded_entity")
    public static void loaded_entity_knowledge_uses_cached_column_sections(
            GameTestHelper helper) {
        LoadedEntityKnowledgeGameTests
                .publication_samples_only_cached_column_entity_sections(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty", timeoutTicks = 400,
            batch = "mc_agent_runtime")
    public static void uses_vanilla_respawn_policy(GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer first = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        UUID identity = first.getUUID();
        BlockPos deathPos = first.blockPosition();
        BlockPos retainedKnowledge = deathPos.below();
        dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.publishBlock(level.getServer(),
                level.dimension().location().toString(), level.getGameTime(), retainedKnowledge,
                level.getBlockState(retainedKnowledge), BlockEvidenceSource.ATTRIBUTABLE_ACTION);
        long[] revisionBeforeDeath = {RuntimeBotManager.observationRevision(level.getServer())};
        first.setRespawnPosition(level.dimension(), null, 0.0F, false, false);
        first.getInventory().clearContent();
        first.getInventory().add(new ItemStack(Items.DIAMOND));
        level.getGameRules().getRule(GameRules.RULE_KEEPINVENTORY).set(false, level.getServer());
        kill(first, level);

        helper.startSequence()
                .thenWaitUntil(() -> {
                    BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
                    helper.assertTrue(bot != first && bot.isAlive(), "vanilla did not replace the dead body");
                    helper.assertTrue(RuntimeBotManager.observationRevision(level.getServer())
                                    >= revisionBeforeDeath[0] + 2L,
                            "body-unavailable ticks did not publish monotonic knowledge revisions");
                })
                .thenExecute(() -> {
                    BotPlayer second = RuntimeBotManager.current(level.getServer()).orElseThrow();
                    helper.assertTrue(second.getUUID().equals(identity), "UUID changed across respawn");
                    helper.assertTrue(!second.ensureInInventory(Items.DIAMOND),
                            "keepInventory=false retained the inventory");
                    boolean dropped = !level.getEntitiesOfClass(ItemEntity.class,
                            new AABB(deathPos).inflate(3.0),
                            item -> item.getItem().is(Items.DIAMOND)).isEmpty();
                    helper.assertTrue(dropped, "keepInventory=false did not drop the inventory");
                    helper.assertTrue(horizontalDistanceSqr(second.blockPosition(), level.getSharedSpawnPos()) <= 256,
                            "missing bed/anchor did not use shared world spawn");
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(),
                                    level.dimension().location().toString(), retainedKnowledge).state()
                                    != BlockEvidenceCell.State.UNKNOWN,
                            "grounded knowledge was lost across death and respawn");

                    ServerLevel nether = level.getServer().getLevel(Level.NETHER);
                    helper.assertTrue(nether != null, "nether level is unavailable");
                    second.teleportTo(nether, 0.5, 90.0, 0.5, 0.0F, 0.0F);
                })
                .thenWaitUntil(() -> {
                    BotPlayer transferred = RuntimeBotManager.current(
                            level.getServer()).orElseThrow();
                    RuntimeBotTrackingDiagnostics.TrackingState tracking =
                            RuntimeBotManager.trackingDiagnostics(level.getServer()).orElseThrow()
                                    .tracking().orElseThrow();
                    helper.assertTrue(transferred.level().dimension() == Level.NETHER,
                            "live dimension transfer did not move the Runtime Bot body");
                    helper.assertTrue(tracking.dimension().equals(
                                    Level.NETHER.location().toString())
                                    && tracking.center().equals(transferred.chunkPosition()),
                            "vanilla tracking did not follow live dimension transfer");
                })
                .thenExecute(() -> {
                    BotPlayer second = RuntimeBotManager.current(level.getServer()).orElseThrow();
                    second.teleportTo(level,
                            level.getSharedSpawnPos().getX() + 0.5,
                            level.getSharedSpawnPos().getY(),
                            level.getSharedSpawnPos().getZ() + 0.5,
                            0.0F, 0.0F);
                    ServerLevel nether = level.getServer().getLevel(Level.NETHER);
                    helper.assertTrue(nether != null, "nether level is unavailable");
                    BlockPos anchor = new BlockPos(0, 80, 0);
                    prepareAnchor(nether, anchor);
                    second.setRespawnPosition(nether.dimension(), anchor, 0.0F, false, false);
                    revisionBeforeDeath[0] = RuntimeBotManager.observationRevision(level.getServer());
                    kill(second, level);
                })
                .thenWaitUntil(() -> {
                    BotPlayer third = RuntimeBotManager.current(level.getServer()).orElseThrow();
                    helper.assertTrue(third.isAlive() && third.level().dimension() == Level.NETHER,
                            "charged respawn anchor was not used");
                    helper.assertTrue(third.blockPosition().closerThan(new BlockPos(0, 80, 0), 6.0),
                            "respawn anchor selected an unexpected position");
                    helper.assertTrue(RuntimeBotManager.observationRevision(level.getServer())
                                    >= revisionBeforeDeath[0] + 2L,
                            "dimension respawn reset or stalled knowledge revision");
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(),
                                    level.dimension().location().toString(), retainedKnowledge).state()
                                    != BlockEvidenceCell.State.UNKNOWN,
                            "grounded dimension-keyed history was lost after dimension travel");
                    RuntimeBotTrackingDiagnostics.TrackingState netherTracking =
                            RuntimeBotManager.trackingDiagnostics(level.getServer()).orElseThrow()
                                    .tracking().orElseThrow();
                    helper.assertTrue(netherTracking.dimension().equals(
                                    Level.NETHER.location().toString()),
                            "vanilla tracking did not move to the respawn dimension");
                    helper.assertTrue(netherTracking.center().equals(third.chunkPosition()),
                            "vanilla tracking did not center on the respawned body");
                })
                .thenExecute(() -> {
                    BotPlayer third = RuntimeBotManager.current(level.getServer()).orElseThrow();
                    BlockPos bedFoot = level.getSharedSpawnPos().offset(20, 0, 0);
                    prepareBed(level, bedFoot);
                    third.setRespawnPosition(level.dimension(), bedFoot, 0.0F, false, false);
                    third.getInventory().add(new ItemStack(Items.EMERALD));
                    level.getGameRules().getRule(GameRules.RULE_KEEPINVENTORY).set(true, level.getServer());
                    kill(third, third.serverLevel());
                })
                .thenWaitUntil(() -> {
                    BotPlayer fourth = RuntimeBotManager.current(level.getServer()).orElseThrow();
                    BlockPos bedFoot = level.getSharedSpawnPos().offset(20, 0, 0);
                    helper.assertTrue(fourth.isAlive() && fourth.level().dimension() == level.dimension(),
                            "valid overworld bed was not used");
                    helper.assertTrue(fourth.blockPosition().closerThan(bedFoot, 6.0),
                            "bed selected an unexpected respawn position");
                    helper.assertTrue(fourth.ensureInInventory(Items.EMERALD),
                            "keepInventory=true did not retain the inventory");
                    RuntimeBotTrackingDiagnostics.TrackingState overworldTracking =
                            RuntimeBotManager.trackingDiagnostics(level.getServer()).orElseThrow()
                                    .tracking().orElseThrow();
                    helper.assertTrue(overworldTracking.dimension().equals(
                                    level.dimension().location().toString()),
                            "vanilla tracking did not return to the overworld dimension");
                })
                .thenExecute(() -> {
                    level.getGameRules().getRule(GameRules.RULE_KEEPINVENTORY)
                            .set(false, level.getServer());
                    BotPlayer stopping = RuntimeBotManager.current(level.getServer()).orElseThrow();
                    var stopChunk = stopping.chunkPosition();
                    var pendingPublication =
                            dev.mcagent.runtime.sdk.RuntimeSimulationControl.forServer(level.getServer()).observe();
                    RuntimeBotManager.stop(level.getServer());
                    helper.assertTrue(RuntimeBotManager.current(level.getServer()).isEmpty(),
                            "World Run stop retained the Runtime Bot");
                    helper.assertTrue(level.getServer().getPlayerList().getPlayers().stream()
                                    .noneMatch(BotPlayer.class::isInstance),
                            "World Run stop retained the Runtime Bot in the vanilla player list");
                    helper.assertTrue(stopping.getChunkTrackingView()
                                    .equals(net.minecraft.server.level.ChunkTrackingView.EMPTY),
                            "World Run stop retained the Runtime Bot logical tracking view");
                    helper.assertTrue(!level.getChunkSource().chunkMap
                                    .getPlayersCloseForSpawning(stopChunk).contains(stopping),
                            "World Run stop retained natural-spawn tracking presence");
                    helper.assertTrue(RuntimeBotManager.trackingDiagnostics(level.getServer()).isEmpty(),
                            "World Run stop retained tracking configuration or diagnostics");
                    helper.assertTrue(pendingPublication.toCompletableFuture()
                                    .isCompletedExceptionally(),
                            "World Run stop did not release the pending observation waiter");
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty", timeoutTicks = 200,
            batch = "mc_agent_runtime")
    public static void fresh_spawn_does_not_load_old_player_data(GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        UUID uuid = UUID.randomUUID();
        Vec3 oldPosition = Vec3.atBottomCenterOf(level.getSharedSpawnPos().offset(40, 0, 40));
        BotPlayer old = BotFactory.spawnFresh(
                level.getServer(), uuid, "fresh_data_test", level, oldPosition,
                net.minecraft.server.level.ClientInformation.createDefault());
        old.getInventory().add(new ItemStack(Items.DIAMOND));
        BotFactory.despawn(level.getServer(), old);

        Vec3 requested = Vec3.atBottomCenterOf(level.getSharedSpawnPos().offset(-40, 0, -40));
        BotPlayer fresh = BotFactory.spawnFresh(
                level.getServer(), uuid, "fresh_data_test", level, requested,
                net.minecraft.server.level.ClientInformation.createDefault());
        helper.assertTrue(!fresh.ensureInInventory(Items.DIAMOND),
                "fresh spawn restored inventory from old player data");
        helper.assertTrue(fresh.position().distanceToSqr(requested) < 0.01,
                "fresh spawn restored position from old player data");
        BotFactory.despawn(level.getServer(), fresh);
        helper.succeed();
    }

    private static void kill(BotPlayer bot, ServerLevel level) {
        bot.setHealth(0.0F);
        bot.die(level.damageSources().genericKill());
    }

    private static void prepareAnchor(ServerLevel level, BlockPos anchor) {
        for (int x = -3; x <= 3; x++) {
            for (int z = -3; z <= 3; z++) {
                level.setBlockAndUpdate(anchor.offset(x, -1, z), Blocks.STONE.defaultBlockState());
                level.setBlockAndUpdate(anchor.offset(x, 0, z), Blocks.AIR.defaultBlockState());
                level.setBlockAndUpdate(anchor.offset(x, 1, z), Blocks.AIR.defaultBlockState());
            }
        }
        level.setBlockAndUpdate(anchor, Blocks.RESPAWN_ANCHOR.defaultBlockState()
                .setValue(RespawnAnchorBlock.CHARGE, 4));
    }

    private static void prepareBed(ServerLevel level, BlockPos foot) {
        Direction facing = Direction.NORTH;
        BlockPos head = foot.relative(facing);
        for (BlockPos pos : java.util.List.of(foot, head)) {
            level.setBlockAndUpdate(pos.below(), Blocks.STONE.defaultBlockState());
            level.setBlockAndUpdate(pos.above(), Blocks.AIR.defaultBlockState());
        }
        var footState = Blocks.RED_BED.defaultBlockState()
                .setValue(BlockStateProperties.HORIZONTAL_FACING, facing)
                .setValue(BlockStateProperties.BED_PART, BedPart.FOOT);
        level.setBlockAndUpdate(foot, footState);
        level.setBlockAndUpdate(head, footState.setValue(BlockStateProperties.BED_PART, BedPart.HEAD));
    }

    private static long horizontalDistanceSqr(BlockPos left, BlockPos right) {
        long dx = left.getX() - right.getX();
        long dz = left.getZ() - right.getZ();
        return dx * dx + dz * dz;
    }
    @GameTest(templateNamespace = "mc_agent_startup", template = "floor16",
            timeoutTicks = 200, batch = "grounded_evidence_expiry")
    public static void grounded_evidence_expires_on_server_ticks(GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.start(level.getServer(), Map.of(
                GroundedEvidencePolicy.BLOCK_ENVIRONMENT_VARIABLE, "5",
                GroundedEvidencePolicy.ENTITY_ENVIRONMENT_VARIABLE, "5"));
        RuntimeBotManager.create(level.getServer(), "bot");
        String dimension = level.dimension().location().toString();
        BlockPos remembered = level.getSharedSpawnPos().offset(1024, 128, 1024);
        UUID entityUuid = UUID.fromString("00000000-0000-0000-0000-000000000392");
        long admittedAt = level.getServer().getTickCount();
        dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.publishBlock(
                level.getServer(), dimension, admittedAt, remembered,
                Blocks.STONE.defaultBlockState(), BlockEvidenceSource.ATTRIBUTABLE_ACTION);
        dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.publishEntity(
                level.getServer(), dimension, admittedAt, entityUuid,
                "minecraft:sheep", Vec3.atCenterOf(remembered));

        helper.startSequence()
                .thenExecute(() -> {
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(
                                    level.getServer(), dimension, remembered).state()
                                    == BlockEvidenceCell.State.KNOWN_BLOCK,
                            "attributable block was not admitted before expiry");
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.entity(
                                    level.getServer(), entityUuid)
                                    .map(track -> track.state() == EntityTrack.State.KNOWN
                                            && track.position().equals(Vec3.atCenterOf(remembered)))
                                    .orElse(false),
                            "attributable entity did not retain its frozen position");
                })
                // GameTest callbacks precede Post publication. Inspect after four completed
                // frames, then after the fifth completed frame at the expiry boundary.
                .thenIdle(5)
                .thenExecute(() -> {
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(
                                    level.getServer(), dimension, remembered).state()
                                    == BlockEvidenceCell.State.KNOWN_BLOCK,
                            "block expired before the configured boundary");
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.entity(
                                    level.getServer(), entityUuid).isPresent(),
                            "entity expired before the configured boundary");
                })
                .thenIdle(1)
                .thenExecute(() -> {
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(
                                    level.getServer(), dimension, remembered).state()
                                    == BlockEvidenceCell.State.UNKNOWN,
                            "block did not become UNKNOWN at the configured boundary");
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.entity(
                                    level.getServer(), entityUuid).isEmpty(),
                            "entity Track was retained at the configured boundary");
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_startup", template = "floor16",
            timeoutTicks = 200, batch = "grounded_field_of_view")
    public static void narrow_field_of_view_admits_only_what_the_bot_faces(GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.start(level.getServer(), Map.of(
                GroundedEvidencePolicy.FIELD_OF_VIEW_ENVIRONMENT_VARIABLE, "110"));
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        String dimension = level.dimension().location().toString();
        BlockPos feet = helper.absolutePos(new BlockPos(8, 3, 8));
        level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
        // Yaw 0 looks south: one block ahead of the eye, one behind it, and an entity behind.
        bot.teleportTo(level, feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                java.util.Set.of(), 0.0F, 0.0F);
        BlockPos ahead = feet.above().south(3);
        BlockPos behind = feet.above().north(3);
        level.setBlockAndUpdate(ahead, Blocks.GOLD_BLOCK.defaultBlockState());
        level.setBlockAndUpdate(behind, Blocks.DIAMOND_BLOCK.defaultBlockState());
        ArmorStand stand = EntityType.ARMOR_STAND.create(level);
        stand.setNoGravity(true);
        stand.moveTo(feet.getX() + 2.5, feet.getY(), feet.getZ() - 2.5);
        level.addFreshEntity(stand);

        helper.startSequence()
                .thenIdle(5)
                .thenExecute(() -> {
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(
                                    level.getServer(), dimension, ahead).state()
                                    == BlockEvidenceCell.State.KNOWN_BLOCK,
                            "the block the Bot faces was not admitted");
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(
                                    level.getServer(), dimension, behind).state()
                                    != BlockEvidenceCell.State.KNOWN_BLOCK,
                            "a block behind the Bot was admitted");
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.entity(
                                    level.getServer(), stand.getUUID()).isEmpty(),
                            "an entity behind the Bot was admitted");
                    bot.setYRot(180.0F);
                })
                .thenIdle(5)
                .thenExecute(() -> {
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(
                                    level.getServer(), dimension, behind).state()
                                    == BlockEvidenceCell.State.KNOWN_BLOCK,
                            "the block was not admitted after the Bot turned to it");
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.entity(
                                    level.getServer(), stand.getUUID()).isPresent(),
                            "the entity was not admitted after the Bot turned to it");
                    stand.discard();
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }

}
