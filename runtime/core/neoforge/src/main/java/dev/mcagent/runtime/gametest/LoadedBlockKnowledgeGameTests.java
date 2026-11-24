package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.knowledge.WorldKnowledgeProfile;
import dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTrackerAccess;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

public final class LoadedBlockKnowledgeGameTests {

    private static final long MAX_BLOCK_FIND_NANOS = 50_000_000L;

    private LoadedBlockKnowledgeGameTests() {}

    public static void incremental_changes_and_search_latency_use_cached_pages(
            GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        int previousViewDistance = level.getServer().getPlayerList().getViewDistance();
        level.getServer().getPlayerList().setViewDistance(10);
        RuntimeBotManager.start(level.getServer(), java.util.Map.of(
                WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "loaded_world_state",
                "EVICRAFT_RUNTIME_VIEW_DISTANCE", "10"));
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        java.util.ArrayList<ChunkPos> expectedColumns = new java.util.ArrayList<>();
        bot.getChunkTrackingView().forEach(expectedColumns::add);
        expectedColumns.forEach(position -> level.getChunk(position.x, position.z));
        Set<Long> expectedColumnKeys = expectedColumns.stream()
                .map(ChunkPos::toLong).collect(java.util.stream.Collectors.toUnmodifiableSet());
        BlockPos[] inside = new BlockPos[1];
        BlockPos[] outside = new BlockPos[1];
        int[] stableCompleteTicks = new int[1];

        helper.startSequence()
                .thenWaitUntil(() -> {
                    var tracking = RuntimeBotManager.trackingDiagnostics(level.getServer())
                            .orElseThrow().tracking().orElseThrow();
                    helper.assertTrue(tracking.viewDistance() == 10,
                            "latency gate did not run at effective view distance 10");
                    var cache = ((VirtualClientChunkTrackerAccess) bot.connection.chunkSender)
                            .mcagent$loadedChunkSnapshot();
                    List<ChunkPos> missing = missingColumns(expectedColumns, cache);
                    List<ChunkPos> unexpected = cache.columns().keySet().stream()
                            .filter(key -> !expectedColumnKeys.contains(key))
                            .map(ChunkPos::new).toList();
                    boolean complete = tracking.pendingChunkCount() == 0
                            && tracking.unacknowledgedBatchCount() == 0
                            && cache.columns().size() == expectedColumns.size()
                            && missing.isEmpty() && unexpected.isEmpty();
                    stableCompleteTicks[0] = complete ? stableCompleteTicks[0] + 1 : 0;
                    helper.assertTrue(stableCompleteTicks[0] >= 2,
                            "latency gate did not stabilize the complete vanilla loaded view: "
                                    + "expected=" + expectedColumns.size()
                                    + ", actual=" + cache.columns().size()
                                    + ", pending=" + tracking.pendingChunkCount()
                                    + ", unacknowledged=" + tracking.unacknowledgedBatchCount()
                                    + ", missing=" + missing.stream().limit(16)
                                    .map(ChunkPos::toString).collect(Collectors.joining(","))
                                    + ", unexpected=" + unexpected.stream().limit(16)
                                    .map(ChunkPos::toString).collect(Collectors.joining(",")));
                })
                .thenExecute(() -> {
                    var tracking = RuntimeBotManager.trackingDiagnostics(level.getServer())
                            .orElseThrow().tracking().orElseThrow();
                    inside[0] = bot.blockPosition().offset(1, 0, 1);
                    ChunkPos outsideColumn = new ChunkPos(
                            tracking.center().x + tracking.viewDistance() + 3,
                            tracking.center().z);
                    outside[0] = new BlockPos(
                            (outsideColumn.x << 4) + 8, inside[0].getY(),
                            (outsideColumn.z << 4) + 8);
                    helper.assertTrue(level.getChunkSource().getChunkNow(
                                    outsideColumn.x, outsideColumn.z) == null,
                            "outside-coverage fixture unexpectedly started loaded");
                    level.setBlockAndUpdate(inside[0], Blocks.GOLD_BLOCK.defaultBlockState());
                    level.setBlockAndUpdate(outside[0], Blocks.DIAMOND_BLOCK.defaultBlockState());
                    RuntimeBotManager.tick(level.getServer());
                    var cells = cells(level, inside[0], outside[0]);
                    helper.assertTrue(cells.get(0).cell().state()
                                    == BlockEvidenceCell.State.KNOWN_BLOCK
                                    && "minecraft:gold_block".equals(
                                    cells.get(0).cell().blockState()),
                            "in-coverage block mutation was stale on the next publication");
                    helper.assertTrue(cells.get(1).cell().state()
                                    == BlockEvidenceCell.State.UNKNOWN,
                            "outside-coverage mutation entered loaded knowledge");
                    assertBlockFindLatency(helper, level.getServer(), bot.blockPosition(),
                            "minecraft:structure_block", false);
                    assertBlockFindLatency(helper, level.getServer(), bot.blockPosition(),
                            "minecraft:gold_block", true);
                    assertBlockFindLatency(helper, level.getServer(), bot.blockPosition(),
                            "minecraft:stone", true);
                })
                .thenExecute(() -> {
                    RuntimeBotManager.stop(level.getServer());
                    level.getServer().getPlayerList().setViewDistance(previousViewDistance);
                })
                .thenSucceed();
    }

    private static List<ChunkPos> missingColumns(
            List<ChunkPos> expected,
            dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTracker.Snapshot cache) {
        return expected.stream().filter(position -> !cache.contains(position)).toList();
    }

    private static void assertBlockFindLatency(
            GameTestHelper helper,
            MinecraftServer server,
            BlockPos origin,
            String blockId,
            boolean expectedMatch) {
        for (int limit : List.of(32, 256)) {
            assertFindLatency(helper, server, blockId, origin, limit, expectedMatch,
                    blockId + " near limit=" + limit);
            assertFindLatency(helper, server, blockId, null, limit, expectedMatch,
                    blockId + " coordinate limit=" + limit);
        }
    }

    private static void assertFindLatency(
            GameTestHelper helper,
            MinecraftServer server,
            String blockId,
            BlockPos origin,
            int limit,
            boolean expectedMatch,
            String label) {
        BlockKnowledge blocks = RuntimeBotManager.knowledge(server).blocks();
        var matcher = CanonicalIdentifierGlob.compile(blockId);
        blocks.find("minecraft:overworld", matcher, origin, limit);
        long started = System.nanoTime();
        BlockKnowledge.FindResult result =
                blocks.find("minecraft:overworld", matcher, origin, limit);
        long elapsed = System.nanoTime() - started;
        boolean hasMatch = !result.matches().isEmpty();
        helper.assertTrue(hasMatch == expectedMatch,
                label + " returned an unexpected match state");
        helper.assertTrue(elapsed <= MAX_BLOCK_FIND_NANOS,
                label + " took " + elapsed / 1_000_000.0 + "ms on the server thread");
    }

    public static void virtual_client_cache_follows_completed_logical_view_delivery(
            GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.start(level.getServer(), java.util.Map.of(
                WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "loaded_world_state"));
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        ChunkPos initialCenter = bot.chunkPosition();
        ChunkPos[] movedCenter = new ChunkPos[1];
        BlockPos[] changedBlock = new BlockPos[1];

        helper.startSequence()
                .thenWaitUntil(() -> {
                    var tracking = RuntimeBotManager.trackingDiagnostics(level.getServer())
                            .orElseThrow().tracking().orElseThrow();
                    helper.assertTrue(tracking.pendingChunkCount() == 0,
                            "initial logical chunk delivery did not complete");
                    var cache = ((VirtualClientChunkTrackerAccess) bot.connection.chunkSender)
                            .mcagent$loadedChunkSnapshot();
                    helper.assertTrue(cache.contains(initialCenter),
                            "completed in-view column did not enter loaded knowledge");
                })
                .thenExecute(() -> {
                    level.setChunkForced(initialCenter.x, initialCenter.z, true);
                    bot.setNoGravity(true);
                    bot.moveTo(bot.getX() + 512.0, 200.0, bot.getZ(),
                            bot.getYRot(), bot.getXRot());
                })
                .thenIdle(1)
                .thenWaitUntil(() -> {
                    var tracking = RuntimeBotManager.trackingDiagnostics(level.getServer())
                            .orElseThrow().tracking().orElseThrow();
                    movedCenter[0] = tracking.center();
                    var cache = ((VirtualClientChunkTrackerAccess) bot.connection.chunkSender)
                            .mcagent$loadedChunkSnapshot();
                    helper.assertTrue(tracking.pendingChunkCount() == 0,
                            "moved logical chunk delivery did not complete");
                    helper.assertTrue(cache.contains(movedCenter[0]),
                            "completed moved-view column did not enter loaded knowledge");
                    helper.assertTrue(!cache.contains(initialCenter),
                            "view-exited column remained in loaded knowledge");
                    helper.assertTrue(level.getChunkSource().getChunkNow(
                                    initialCenter.x, initialCenter.z) != null,
                            "forceload did not keep the cache-exited server chunk resident");
                })
                .thenExecute(() -> {
                    changedBlock[0] = new BlockPos(
                            (movedCenter[0].x << 4) + 8, 199,
                            (movedCenter[0].z << 4) + 8);
                    level.setBlockAndUpdate(changedBlock[0], Blocks.GOLD_BLOCK.defaultBlockState());
                })
                .thenIdle(1)
                .thenWaitUntil(() -> {
                    var tracking = RuntimeBotManager.trackingDiagnostics(level.getServer())
                            .orElseThrow().tracking().orElseThrow();
                    BlockPos serverResidentOutsideView = new BlockPos(
                            (initialCenter.x << 4) + 8, 64,
                            (initialCenter.z << 4) + 8);
                    ChunkPos neverLoaded = new ChunkPos(
                            movedCenter[0].x + tracking.viewDistance() + 3,
                            movedCenter[0].z);
                    helper.assertTrue(level.getChunkSource().getChunkNow(
                                    neverLoaded.x, neverLoaded.z) == null,
                            "query-purity fixture unexpectedly started server-resident");
                    BlockPos neverLoadedBlock = new BlockPos(
                            (neverLoaded.x << 4) + 8, 64,
                            (neverLoaded.z << 4) + 8);
                    var cells = cells(level,
                            serverResidentOutsideView, changedBlock[0], neverLoadedBlock);
                    helper.assertTrue(cells.get(0).cell().state()
                                    == BlockEvidenceCell.State.UNKNOWN,
                            "server-resident view-exited column was not UNKNOWN");
                    helper.assertTrue(cells.get(1).cell().state()
                                    == BlockEvidenceCell.State.KNOWN_BLOCK
                                    && "minecraft:gold_block".equals(
                                    cells.get(1).cell().blockState()),
                            "delivered block update was absent from loaded knowledge");
                    helper.assertTrue("loaded_world_state".equals(
                                    cells.get(1).cell().source().wireValue()),
                            "loaded exact block used the wrong provenance");
                    helper.assertTrue(cells.get(2).cell().state()
                                    == BlockEvidenceCell.State.UNKNOWN,
                            "outside query did not remain UNKNOWN");
                    helper.assertTrue(level.getChunkSource().getChunkNow(
                                    neverLoaded.x, neverLoaded.z) == null,
                            "World Knowledge query loaded or generated a server chunk");
                })
                .thenExecute(() -> {
                    level.setChunkForced(initialCenter.x, initialCenter.z, false);
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenWaitUntil(() -> {
                    helper.assertTrue(RuntimeBotManager.trackingDiagnostics(
                                    level.getServer()).isEmpty(),
                            "Runtime Bot tracking survived the loaded knowledge GameTest");
                    helper.assertTrue(level.getChunkSource().getChunkNow(
                                    movedCenter[0].x, movedCenter[0].z) == null,
                            "Runtime Bot cache coverage remained server-loaded after stop");
                })
                .thenSucceed();
    }

    private static List<BlockKnowledge.LocatedCell> cells(ServerLevel level, BlockPos... positions) {
        BlockKnowledge blocks = RuntimeBotManager.knowledge(level.getServer()).blocks();
        String dimension = level.dimension().location().toString();
        return java.util.Arrays.stream(positions)
                .map(position -> new BlockKnowledge.LocatedCell(
                        position, blocks.cell(dimension, position)))
                .toList();
    }
}
