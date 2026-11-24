package dev.mcagent.runtime.sdk;

import java.util.Objects;
import java.util.UUID;

/** The complete actor projection allowed on the SDK control surface. */
public record RuntimeActorView(UUID uuid, String name, Lifecycle lifecycle, long observationRevision) {

    public enum Lifecycle {
        STARTING,
        ALIVE,
        DEAD,
        RESPAWNING
    }

    public RuntimeActorView {
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(lifecycle, "lifecycle");
        if (observationRevision < 0L) {
            throw new IllegalArgumentException("observationRevision must not be negative");
        }
    }

    public static RuntimeActorView starting(long observationRevision) {
        return new RuntimeActorView(null, "bot", Lifecycle.STARTING, observationRevision);
    }
}
