package dev.mcagent.runtime.sdk;

import java.util.Objects;

/** SDK projection of one three-state Block Evidence Cell. */
public record RuntimeBlockEvidence(
        String dimension,
        RuntimeBlockPosition position,
        State state,
        String blockState,
        String fluid,
        String source,
        Long observedTick,
        Long observationRevision
) {
    public enum State {
        UNKNOWN,
        KNOWN_AIR,
        KNOWN_BLOCK
    }

    public RuntimeBlockEvidence {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(position, "position");
        Objects.requireNonNull(state, "state");
        boolean known = state != State.UNKNOWN;
        if (known != (source != null && observedTick != null && observationRevision != null)) {
            throw new IllegalArgumentException("known evidence requires source, tick, and revision");
        }
        if (state == State.KNOWN_BLOCK) {
            Objects.requireNonNull(blockState, "blockState");
            Objects.requireNonNull(fluid, "fluid");
        } else if (blockState != null || fluid != null) {
            throw new IllegalArgumentException("only KNOWN_BLOCK carries block state and fluid");
        }
    }

    public static RuntimeBlockEvidence unknown(String dimension, RuntimeBlockPosition position) {
        return new RuntimeBlockEvidence(dimension, position, State.UNKNOWN,
                null, null, null, null, null);
    }

    public static RuntimeBlockEvidence knownAir(
            String dimension, RuntimeBlockPosition position, String source,
            long observedTick, long observationRevision) {
        return new RuntimeBlockEvidence(dimension, position, State.KNOWN_AIR,
                null, null, source, observedTick, observationRevision);
    }

    public static RuntimeBlockEvidence knownBlock(
            String dimension, RuntimeBlockPosition position, String blockState, String fluid,
            String source, long observedTick, long observationRevision) {
        return new RuntimeBlockEvidence(dimension, position, State.KNOWN_BLOCK,
                Objects.requireNonNull(blockState, "blockState"),
                Objects.requireNonNull(fluid, "fluid"), source, observedTick, observationRevision);
    }
}
