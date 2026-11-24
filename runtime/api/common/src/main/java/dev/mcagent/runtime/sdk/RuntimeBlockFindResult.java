package dev.mcagent.runtime.sdk;

import java.util.List;
import java.util.Objects;

/** Bounded known-only block search projection. */
public record RuntimeBlockFindResult(
        List<RuntimeBlockEvidence> matches,
        boolean hasMore,
        boolean complete
) {
    public RuntimeBlockFindResult {
        matches = List.copyOf(Objects.requireNonNull(matches, "matches"));
        if (matches.size() > 256) throw new IllegalArgumentException("at most 256 matches");
        if (matches.stream().anyMatch(match -> match.state() != RuntimeBlockEvidence.State.KNOWN_BLOCK)) {
            throw new IllegalArgumentException("block find matches must be KNOWN_BLOCK evidence");
        }
        if (complete) {
            throw new IllegalArgumentException("known-only search cannot prove world completeness");
        }
    }
}
