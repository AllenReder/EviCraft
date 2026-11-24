package dev.mcagent.runtime.knowledge;

import dev.mcagent.runtime.evidence.EntityTrack;
import net.minecraft.world.phys.Vec3;

import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/** Profile-neutral selection over entity facts already admitted by Entity Knowledge. */
public final class EntityKnowledgeSelection {

    private EntityKnowledgeSelection() {}

    public static List<EntityTrack> selectTargets(
            List<EntityTrack> tracks,
            String dimension,
            CanonicalIdentifierMatcher entityMatcher,
            CanonicalIdentifierMatcher itemMatcher,
            Vec3 origin,
            Double radius) {
        Objects.requireNonNull(tracks, "tracks");
        Objects.requireNonNull(origin, "origin");
        if (radius != null && radius < 0.0) {
            throw new IllegalArgumentException("entity target radius must not be negative");
        }
        double radiusSquared = radius == null ? Double.POSITIVE_INFINITY : radius * radius;
        return tracks.stream()
                .filter(EntityKnowledgeSelection::eligibleForTargeting)
                .filter(track -> dimension == null || dimension.equals(track.dimension()))
                .filter(track -> entityMatcher == null || entityMatcher.matches(track.entityId()))
                .filter(track -> itemMatcher == null
                        || track.itemId() != null && itemMatcher.matches(track.itemId()))
                .filter(track -> origin.distanceToSqr(track.position()) <= radiusSquared)
                .sorted(Comparator
                        .comparingDouble((EntityTrack track) -> origin.distanceToSqr(track.position()))
                        .thenComparing(track -> track.uuid().toString()))
                .toList();
    }

    /** Entity Knowledge-owned admission for automatic targeting and attributable loot. */
    public static boolean eligibleForTargeting(EntityTrack track) {
        return track != null && (track.state() == EntityTrack.State.VISIBLE
                || track.source() == dev.mcagent.runtime.evidence.EntityEvidenceSource.ATTRIBUTABLE_ACTION
                || track.source() == dev.mcagent.runtime.evidence.EntityEvidenceSource.VISION);
    }

    /** Current hostile centers used by generic navigation avoidance. */
    public static List<Vec3> avoidanceCenters(List<EntityTrack> tracks, String dimension) {
        Objects.requireNonNull(tracks, "tracks");
        Objects.requireNonNull(dimension, "dimension");
        return tracks.stream()
                .filter(track -> dimension.equals(track.dimension()))
                .filter(track -> track.state() == EntityTrack.State.VISIBLE)
                .filter(EntityTrack::hostile)
                .map(EntityTrack::position)
                .toList();
    }
}
