package dev.mcagent.runtime.knowledge.loaded;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.evidence.EntityObservation;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import dev.mcagent.runtime.knowledge.KnowledgeRevision;
import dev.mcagent.runtime.knowledge.WorldKnowledge;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** Loaded-world-state provider backed exclusively by one Bot's virtual-client cache. */
public final class LoadedWorldKnowledge implements WorldKnowledge {

    private final LoadedBlockKnowledgeStore blocks = new LoadedBlockKnowledgeStore();
    private final LoadedEntityKnowledgeStore entities = new LoadedEntityKnowledgeStore();
    private final LoadedEntityObservationSampler entitySampler =
            new LoadedEntityObservationSampler();
    private long revision;

    @Override
    public KnowledgeRevision revision() {
        return new KnowledgeRevision(revision);
    }

    @Override
    public void publish(BotPlayer body) {
        VirtualClientChunkTracker.Snapshot cache =
                ((VirtualClientChunkTrackerAccess) body.connection.chunkSender)
                        .mcagent$loadedChunkSnapshot();
        String dimension = body.level().dimension().location().toString();
        if (!dimension.equals(cache.dimension())) {
            cache = new VirtualClientChunkTracker.Snapshot(dimension, Map.of(), 0L);
        }
        publishSnapshot(cache, body.getServer().getTickCount(),
                entitySampler.sample(body, cache));
    }

    @Override
    public void publishBodyUnavailable(String dimension, long observedTick) {
        publishSnapshot(new VirtualClientChunkTracker.Snapshot(dimension, Map.of(), 0L),
                observedTick, List.of());
    }

    @Override
    public KnowledgeRevision apply(AttributableWorldUpdate update) {
        revision++;
        blocks.apply(update.blocks(), revision);
        entities.apply(update.entities(), update.removedEntities(), revision, blocks::covers);
        return new KnowledgeRevision(revision);
    }

    void publishSnapshot(VirtualClientChunkTracker.Snapshot source, long observedTick) {
        publishSnapshot(source, observedTick, List.of());
    }

    void publishSnapshot(VirtualClientChunkTracker.Snapshot source, long observedTick,
                         List<EntityObservation> entityObservations) {
        revision++;
        blocks.publish(source, observedTick, revision);
        entities.publish(source.dimension(), observedTick, revision, entityObservations);
    }

    @Override
    public BlockKnowledge blocks() {
        return blocks;
    }

    @Override
    public Optional<EntityTrack> entity(UUID uuid) {
        return entities.get(uuid);
    }

    @Override
    public List<EntityTrack> entities() {
        return entities.snapshot();
    }
}
