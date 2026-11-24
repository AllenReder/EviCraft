package dev.mcagent.runtime.knowledge;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.evidence.EntityTrack;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * What one World Run's Actor knows about the world, under the profile the run selected.
 *
 * <p>Server-thread only: publications and reads are ordered by the server tick, so a caller
 * that reads several facts in one call reads them all at one revision.
 */
public interface WorldKnowledge {

    /** The latest publication; each publication and each applied update advances it by one. */
    KnowledgeRevision revision();

    /** Publish what the Actor's body admits this tick. */
    void publish(BotPlayer body);

    /** Publish a tick in which the Actor has no body in {@code dimension}. */
    void publishBodyUnavailable(String dimension, long observedTick);

    /** Publish every fact verified from one physical result at one revision. */
    KnowledgeRevision apply(AttributableWorldUpdate update);

    BlockKnowledge blocks();

    Optional<EntityTrack> entity(UUID uuid);

    List<EntityTrack> entities();
}
