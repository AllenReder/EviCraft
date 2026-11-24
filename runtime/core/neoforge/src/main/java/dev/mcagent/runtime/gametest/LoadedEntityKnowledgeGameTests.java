package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.EntityEvidenceSource;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.loaded.LoadedWorldKnowledge;
import dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTrackerAccess;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;

import java.util.ArrayList;
import java.util.List;

public final class LoadedEntityKnowledgeGameTests {

    private LoadedEntityKnowledgeGameTests() {}

    public static void publication_samples_only_cached_column_entity_sections(
            GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        LoadedWorldKnowledge knowledge = new LoadedWorldKnowledge();
        Zombie hiddenFar = EntityType.ZOMBIE.create(level);
        if (hiddenFar == null) throw new AssertionError("zombie fixture was not created");
        hiddenFar.moveTo(bot.getX() + 44.0, bot.getY() + 16.0,
                bot.getZ() + 44.0, 0.0F, 0.0F);
        hiddenFar.setNoAi(true);
        hiddenFar.setNoGravity(true);
        hiddenFar.setInvisible(true);
        level.addFreshEntity(hiddenFar);
        BlockPos wallCenter = bot.blockPosition().offset(3, 1, 3);
        for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 2; y++) {
                for (int z = -1; z <= 1; z++) {
                    level.setBlockAndUpdate(wallCenter.offset(x, y, z),
                            Blocks.STONE.defaultBlockState());
                }
            }
        }
        ChunkPos entityColumn = hiddenFar.chunkPosition();
        level.setChunkForced(entityColumn.x, entityColumn.z, true);
        ItemEntity emptyItem = new ItemEntity(level, hiddenFar.getX() + 1.0,
                hiddenFar.getY(), hiddenFar.getZ(), new ItemStack(Items.STICK));
        level.addFreshEntity(emptyItem);
        emptyItem.setItem(ItemStack.EMPTY);
        Zombie[] cacheExit = new Zombie[1];
        List<ArmorStand> representativePopulation = new ArrayList<>();
        for (int index = 0; index < 256; index++) {
            ArmorStand stand = EntityType.ARMOR_STAND.create(level);
            if (stand == null) throw new AssertionError("armor stand fixture was not created");
            stand.moveTo((entityColumn.x << 4) + 8.0, bot.getY() + 1.0,
                    (entityColumn.z << 4) + 8.0, 0.0F, 0.0F);
            level.addFreshEntity(stand);
            representativePopulation.add(stand);
        }

        helper.startSequence()
                .thenWaitUntil(() -> {
                    var cache = ((VirtualClientChunkTrackerAccess) bot.connection.chunkSender)
                            .mcagent$loadedChunkSnapshot();
                    helper.assertTrue(cache.contains(entityColumn),
                            "far entity column did not complete virtual-client delivery");
                    helper.assertTrue(bot.distanceToSqr(hiddenFar) > 64.0 * 64.0,
                            "fixture entity was not beyond the forbidden 64-block filter");
                    helper.assertTrue(!bot.hasLineOfSight(hiddenFar),
                            "fixture wall did not occlude the loaded entity");
                })
                .thenExecute(() -> {
                    knowledge.publish(bot);
                    var tracks = knowledge.entities();
                    helper.assertTrue(tracks.stream().noneMatch(
                                    track -> track.uuid().equals(bot.getUUID())),
                            "Runtime Bot entered loaded Entity Knowledge");
                    EntityTrack zombie = tracks.stream()
                            .filter(track -> track.uuid().equals(hiddenFar.getUUID()))
                            .findFirst().orElseThrow(() -> new AssertionError(
                                    "invisible cached-column entity was filtered"));
                    helper.assertTrue(zombie.state() == EntityTrack.State.VISIBLE
                                    && zombie.source() == EntityEvidenceSource.LOADED_WORLD_STATE,
                            "loaded entity used the wrong state or provenance");
                    helper.assertTrue(tracks.stream().noneMatch(
                                    track -> track.uuid().equals(emptyItem.getUUID())),
                            "empty ItemEntity entered loaded Entity Knowledge");
                    java.lang.management.ThreadMXBean platformBean =
                            java.lang.management.ManagementFactory.getThreadMXBean();
                    helper.assertTrue(platformBean instanceof com.sun.management.ThreadMXBean,
                            "JVM does not expose thread allocation measurement");
                    com.sun.management.ThreadMXBean allocationBean =
                            (com.sun.management.ThreadMXBean) platformBean;
                    allocationBean.setThreadAllocatedMemoryEnabled(true);
                    long threadId = Thread.currentThread().threadId();
                    System.gc();
                    long allocatedBefore = allocationBean.getThreadAllocatedBytes(threadId);
                    long firstStarted = System.nanoTime();
                    for (int publication = 0; publication < 100; publication++) {
                        knowledge.publish(bot);
                    }
                    long firstElapsed = System.nanoTime() - firstStarted;
                    System.gc();
                    long retainedAfterFirstWindow = java.lang.management.ManagementFactory
                            .getMemoryMXBean().getHeapMemoryUsage().getUsed();
                    long secondStarted = System.nanoTime();
                    for (int publication = 0; publication < 100; publication++) {
                        knowledge.publish(bot);
                    }
                    long secondElapsed = System.nanoTime() - secondStarted;
                    long allocated = allocationBean.getThreadAllocatedBytes(threadId)
                            - allocatedBefore;
                    System.gc();
                    long retainedAfterSecondWindow = java.lang.management.ManagementFactory
                            .getMemoryMXBean().getHeapMemoryUsage().getUsed();
                    helper.assertTrue((firstElapsed + secondElapsed) / 200L < 50_000_000L,
                            "representative loaded entity publication fell below 20 TPS: "
                                    + (firstElapsed + secondElapsed) / 200L + "ns average");
                    helper.assertTrue(allocated / 200L < 2_000_000L,
                            "representative loaded entity publication allocated too much: "
                                    + allocated / 200L + " bytes average");
                    helper.assertTrue(retainedAfterSecondWindow - retainedAfterFirstWindow
                                    < 4L * 1024L * 1024L,
                            "representative publication heap did not plateau: first="
                                    + retainedAfterFirstWindow + " second="
                                    + retainedAfterSecondWindow);
                    tracks = knowledge.entities();
                    long representativeTracks = tracks.stream()
                            .filter(track -> representativePopulation.stream().anyMatch(
                                    stand -> stand.getUUID().equals(track.uuid())))
                            .count();
                    helper.assertTrue(representativeTracks == representativePopulation.size(),
                            "representative publications lost or accumulated entity tracks");
                    representativePopulation.forEach(ArmorStand::discard);
                    hiddenFar.discard();
                })
                .thenExecute(() -> {
                    knowledge.publish(bot);
                    helper.assertTrue(knowledge.entities().stream().noneMatch(track ->
                                            representativePopulation.stream().anyMatch(stand ->
                                                    stand.getUUID().equals(track.uuid()))),
                            "removed representative population survived the next publication");
                    helper.assertTrue(knowledge.entity(hiddenFar.getUUID()).isEmpty(),
                            "removed entity survived the next ordinary publication");
                    cacheExit[0] = EntityType.ZOMBIE.create(level);
                    if (cacheExit[0] == null) {
                        throw new AssertionError("cache-exit fixture was not created");
                    }
                    cacheExit[0].moveTo((entityColumn.x << 4) + 8.0, bot.getY(),
                            (entityColumn.z << 4) + 8.0, 0.0F, 0.0F);
                    level.addFreshEntity(cacheExit[0]);
                    knowledge.publish(bot);
                    helper.assertTrue(knowledge.entity(cacheExit[0].getUUID()).isPresent(),
                            "cache-exit fixture was not published before leaving coverage");
                    bot.setNoGravity(true);
                    bot.moveTo(bot.getX() + 512.0, 200.0, bot.getZ(), bot.getYRot(), bot.getXRot());
                })
                .thenIdle(1)
                .thenWaitUntil(() -> {
                    var cache = ((VirtualClientChunkTrackerAccess) bot.connection.chunkSender)
                            .mcagent$loadedChunkSnapshot();
                    helper.assertTrue(!cache.contains(entityColumn),
                            "view-exited entity column remained cached");
                    knowledge.publish(bot);
                    helper.assertTrue(knowledge.entities().stream().noneMatch(
                                            track -> track.uuid().equals(cacheExit[0].getUUID())),
                            "cache-exited identity survived loaded publication");
                })
                .thenExecute(() -> {
                    level.setChunkForced(entityColumn.x, entityColumn.z, false);
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }
}
