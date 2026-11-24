package dev.mcagent.runtime.evidence;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** World-Run-local entity memory that never refreshes hidden entities from live state. */
public final class EntityTrackStore {

    private final int expiryTicks;
    private final Map<UUID, EntityTrack> tracks = new LinkedHashMap<>();

    public EntityTrackStore() {
        this(400);
    }

    public EntityTrackStore(int expiryTicks) {
        if (expiryTicks != -1 && expiryTicks < 1) {
            throw new IllegalArgumentException("expiryTicks must be -1 or positive");
        }
        this.expiryTicks = expiryTicks;
    }

    public void publishVisibleFrame(
            String dimension, long observedTick, long observationRevision,
            List<EntityObservation> observations) {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(observations, "observations");
        Set<UUID> visible = new HashSet<>();
        for (EntityObservation observation : observations) {
            if (observation.source() != EntityEvidenceSource.VISION
                    || !visible.add(observation.uuid())) {
                throw new IllegalArgumentException("visible frame requires unique visual observations");
            }
            EntityTrack previous = tracks.get(observation.uuid());
            EntityTrack track = EntityTrack.of(observation, dimension,
                    EntityTrack.State.VISIBLE, observedTick, observationRevision);
            // What the Actor's own action established stays attributed to it while it is seen.
            tracks.put(observation.uuid(), previous != null
                    && previous.source() == EntityEvidenceSource.ATTRIBUTABLE_ACTION
                    ? track.withSource(EntityEvidenceSource.ATTRIBUTABLE_ACTION) : track);
        }
        tracks.replaceAll((uuid, track) -> visible.contains(uuid) ? track : track.freeze());
        if (expiryTicks != -1) {
            tracks.entrySet().removeIf(entry -> !visible.contains(entry.getKey())
                    && observedTick - entry.getValue().observedTick() >= expiryTicks);
        }
    }

    public Optional<EntityTrack> get(UUID uuid) {
        return Optional.ofNullable(tracks.get(Objects.requireNonNull(uuid, "uuid")));
    }

    public List<EntityTrack> snapshot() {
        return List.copyOf(tracks.values());
    }

    public void recordAttributable(
            String dimension, long observedTick, long observationRevision,
            EntityObservation observation) {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(observation, "observation");
        if (observation.source() != EntityEvidenceSource.ATTRIBUTABLE_ACTION) {
            throw new IllegalArgumentException("attributable evidence requires attributable source");
        }
        tracks.put(observation.uuid(), EntityTrack.of(observation, dimension,
                EntityTrack.State.KNOWN, observedTick, observationRevision));
    }

    public boolean removeAttributable(UUID uuid) {
        return tracks.remove(Objects.requireNonNull(uuid, "uuid")) != null;
    }
}
