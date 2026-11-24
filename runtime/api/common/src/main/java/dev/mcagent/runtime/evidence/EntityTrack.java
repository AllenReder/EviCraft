package dev.mcagent.runtime.evidence;

import net.minecraft.world.phys.Vec3;

import java.util.Objects;
import java.util.UUID;

/** UUID-stable visible or frozen entity knowledge for one World Run. */
public record EntityTrack(
        UUID uuid,
        String dimension,
        String entityId,
        String itemId,
        Integer itemCount,
        Vec3 position,
        Float health,
        Float maxHealth,
        boolean hostile,
        State state,
        EntityEvidenceSource source,
        long observedTick,
        long observationRevision
) {
    public enum State {
        VISIBLE,
        KNOWN
    }

    public EntityTrack {
        Objects.requireNonNull(uuid, "uuid");
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(entityId, "entityId");
        Objects.requireNonNull(position, "position");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(source, "source");
        if ((itemId == null) != (itemCount == null) || itemCount != null && itemCount < 1) {
            throw new IllegalArgumentException("item track requires a positive count");
        }
        if ((health == null) != (maxHealth == null)) {
            throw new IllegalArgumentException("living track requires health and max health");
        }
        if (observedTick < 0 || observationRevision < 1) {
            throw new IllegalArgumentException("entity track requires observation metadata");
        }
    }

    EntityTrack freeze() {
        return state == State.KNOWN ? this : new EntityTrack(uuid, dimension, entityId,
                itemId, itemCount, position, health, maxHealth, hostile, State.KNOWN,
                source, observedTick, observationRevision);
    }

    EntityTrack withSource(EntityEvidenceSource attributed) {
        return new EntityTrack(uuid, dimension, entityId, itemId, itemCount, position, health,
                maxHealth, hostile, state, attributed, observedTick, observationRevision);
    }

    /** The track one observation yields, with the observation's own source. */
    public static EntityTrack of(EntityObservation observation, String dimension, State state,
                                 long observedTick, long observationRevision) {
        return new EntityTrack(observation.uuid(), dimension, observation.entityId(),
                observation.itemId(), observation.itemCount(), observation.position(),
                observation.health(), observation.maxHealth(), observation.hostile(), state,
                observation.source(), observedTick, observationRevision);
    }
}
