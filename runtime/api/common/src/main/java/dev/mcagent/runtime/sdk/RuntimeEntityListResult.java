package dev.mcagent.runtime.sdk;

import java.util.List;
import java.util.Objects;

/** Bounded Entity Track list projection. */
public record RuntimeEntityListResult(List<RuntimeEntityTrack> tracks, boolean hasMore) {
    public RuntimeEntityListResult {
        tracks = List.copyOf(Objects.requireNonNull(tracks, "tracks"));
        if (tracks.size() > 256) {
            throw new IllegalArgumentException("at most 256 entity tracks");
        }
    }
}
