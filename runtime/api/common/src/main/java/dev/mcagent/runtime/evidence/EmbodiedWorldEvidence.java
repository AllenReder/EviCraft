package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import dev.mcagent.runtime.knowledge.GroundedEvidencePolicy;
import dev.mcagent.runtime.knowledge.KnowledgeRevision;
import dev.mcagent.runtime.knowledge.WorldKnowledge;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Grounded-evidence provider: what the Actor has seen, touched, or changed by its own action. */
public final class EmbodiedWorldEvidence implements WorldKnowledge {

    private final BlockEvidenceStore blocks;
    private final EntityTrackStore entities;
    private final GroundedBlockSensor observer;

    public EmbodiedWorldEvidence() {
        this(GroundedEvidencePolicy.defaults());
    }

    public EmbodiedWorldEvidence(GroundedEvidencePolicy policy) {
        this.blocks = new BlockEvidenceStore(policy.blockExpiryTicks());
        this.entities = new EntityTrackStore(policy.entityExpiryTicks());
        this.observer = new GroundedBlockSensor(policy.fieldOfViewDegrees());
    }

    @Override
    public KnowledgeRevision revision() {
        return new KnowledgeRevision(blocks.revision());
    }

    @Override
    public void publish(BotPlayer bot) {
        // Entities are seen with the same rays, so their rays join the block frame.
        GroundedBlockSensor.Frame sight = observer.sample(bot);
        List<EntityObservation> seen = GroundedEntitySensor.sample(bot, observer);
        String dimension = bot.level().dimension().location().toString();
        long observedTick = bot.getServer().getTickCount();
        long revision = blocks.publishFrame(dimension, observedTick, sight, sight.contact());
        entities.publishVisibleFrame(dimension, observedTick, revision, seen);
    }

    @Override
    public void publishBodyUnavailable(String dimension, long observedTick) {
        long revision = blocks.publishFrame(dimension, observedTick, List.of());
        entities.publishVisibleFrame(dimension, observedTick, revision, List.of());
    }

    @Override
    public KnowledgeRevision apply(AttributableWorldUpdate update) {
        long revision = blocks.publishAttributable(update.blocks());
        for (AttributableWorldUpdate.EntityFact fact : update.entities()) {
            entities.recordAttributable(fact.dimension(), fact.observedTick(),
                    revision, fact.observation());
        }
        update.removedEntities().forEach(entities::removeAttributable);
        return new KnowledgeRevision(revision);
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
