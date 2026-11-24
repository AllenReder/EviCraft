package dev.mcagent.runtime.sdk;

import java.util.Objects;
import java.util.UUID;

/** SDK-safe UUID Entity Track projection; external entity health and numeric ids are absent. */
public record RuntimeEntityTrack(
        UUID uuid,
        String dimension,
        String entityId,
        String itemId,
        Integer itemCount,
        RuntimeEntityPosition position,
        State state,
        String source,
        long observedTick,
        long observationRevision
) {
    public enum State {
        VISIBLE,
        KNOWN
    }

    public RuntimeEntityTrack {
        Objects.requireNonNull(uuid, "uuid");
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(entityId, "entityId");
        Objects.requireNonNull(position, "position");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(source, "source");
        if ((itemId == null) != (itemCount == null) || itemCount != null && itemCount < 1) {
            throw new IllegalArgumentException("item track requires a positive count");
        }
        if (observedTick < 0 || observationRevision < 1) {
            throw new IllegalArgumentException("entity track requires observation metadata");
        }
    }
}
