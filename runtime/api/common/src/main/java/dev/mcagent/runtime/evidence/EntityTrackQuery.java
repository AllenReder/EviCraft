package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;

import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/** Bounded canonical-id listing of Entity Tracks, in UUID text order. */
public final class EntityTrackQuery {

    public static final int MAX_LIST_RESULTS = 256;

    private EntityTrackQuery() {}

    public static ListResult list(
            List<EntityTrack> tracks,
            String dimension,
            CanonicalIdentifierMatcher entityPattern,
            CanonicalIdentifierMatcher itemPattern) {
        Objects.requireNonNull(tracks, "tracks");
        List<EntityTrack> bounded = tracks.stream()
                .filter(track -> dimension == null || dimension.equals(track.dimension()))
                .filter(track -> entityPattern == null || entityPattern.matches(track.entityId()))
                .filter(track -> itemPattern == null
                        || track.itemId() != null && itemPattern.matches(track.itemId()))
                .sorted(Comparator.comparing(track -> track.uuid().toString()))
                .limit(MAX_LIST_RESULTS + 1L)
                .toList();
        boolean hasMore = bounded.size() > MAX_LIST_RESULTS;
        return new ListResult(hasMore
                ? bounded.subList(0, MAX_LIST_RESULTS) : bounded, hasMore);
    }

    public record ListResult(List<EntityTrack> tracks, boolean hasMore) {
        public ListResult {
            tracks = List.copyOf(Objects.requireNonNull(tracks, "tracks"));
            if (tracks.size() > MAX_LIST_RESULTS) {
                throw new IllegalArgumentException("at most 256 entity tracks");
            }
        }
    }
}
