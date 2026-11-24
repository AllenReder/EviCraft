package dev.mcagent.runtime.sdk;

import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Profile-neutral World Knowledge adapter used by the Runtime SDK dispatcher. */
public interface RuntimeEvidenceGateway {

    RuntimeEvidenceGateway EMPTY = new RuntimeEvidenceGateway() {
            @Override
        public List<RuntimeBlockEvidence> blockGet(
                String dimension, List<RuntimeBlockPosition> positions) {
            throw new IllegalStateException("Runtime evidence is unavailable");
        }
    };

    List<RuntimeBlockEvidence> blockGet(String dimension, List<RuntimeBlockPosition> positions);

    default RuntimeBlockFindResult blockFind(
            String dimension, CanonicalIdentifierMatcher matcher) {
        throw new IllegalStateException("Runtime block search is unavailable");
    }

    default RuntimeBlockFindResult blockFind(
            String dimension, CanonicalIdentifierMatcher matcher,
            RuntimeBlockPosition origin, int limit) {
        if (origin == null && limit == BlockKnowledge.MAX_FIND_RESULTS) {
            return blockFind(dimension, matcher);
        }
        throw new IllegalStateException("Runtime block selection is unavailable");
    }

    default RuntimeBlockRegionResult blockRegion(
            String dimension, BlockKnowledge.RegionBounds bounds) {
        throw new IllegalStateException("Runtime block region is unavailable");
    }

    default Optional<RuntimeEntityTrack> entityGet(UUID uuid) {
        throw new IllegalStateException("Runtime entity evidence is unavailable");
    }

    default RuntimeEntityListResult entityList(
            String dimension,
            CanonicalIdentifierMatcher entityMatcher,
            CanonicalIdentifierMatcher itemMatcher) {
        throw new IllegalStateException("Runtime entity evidence is unavailable");
    }
}
