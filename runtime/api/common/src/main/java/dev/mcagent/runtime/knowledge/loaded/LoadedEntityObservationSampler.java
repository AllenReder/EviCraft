package dev.mcagent.runtime.knowledge.loaded;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.evidence.EntityEvidenceSource;
import dev.mcagent.runtime.evidence.EntityObservation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.phys.AABB;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Main-thread sampler over entity sections belonging to cached chunk columns. */
final class LoadedEntityObservationSampler {

    List<EntityObservation> sample(
            BotPlayer body, VirtualClientChunkTracker.Snapshot cache) {
        ServerLevel level = body.serverLevel();
        Map<UUID, EntityObservation> observations = new LinkedHashMap<>();
        cache.columns().values().stream()
                .sorted(Comparator.comparingLong(page -> page.position().toLong()))
                .forEach(page -> sampleColumn(body, level, page.position(), observations));
        return List.copyOf(observations.values());
    }

    private static void sampleColumn(
            BotPlayer body, ServerLevel level, ChunkPos column,
            Map<UUID, EntityObservation> observations) {
        AABB bounds = new AABB(column.getMinBlockX(), level.getMinBuildHeight(),
                column.getMinBlockZ(), column.getMaxBlockX() + 1.0,
                level.getMaxBuildHeight(), column.getMaxBlockZ() + 1.0);
        for (Entity entity : level.getEntities(body, bounds,
                candidate -> included(candidate, column))) {
            observations.putIfAbsent(entity.getUUID(), EntityObservation.current(
                    entity, EntityEvidenceSource.LOADED_WORLD_STATE));
        }
    }

    private static boolean included(Entity entity, ChunkPos column) {
        return !entity.isRemoved()
                && entity.chunkPosition().equals(column)
                && (!(entity instanceof ItemEntity item) || !item.getItem().isEmpty());
    }
}
