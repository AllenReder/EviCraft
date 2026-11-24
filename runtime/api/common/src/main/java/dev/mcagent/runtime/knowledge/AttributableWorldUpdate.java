package dev.mcagent.runtime.knowledge;

import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockObservation;
import dev.mcagent.runtime.evidence.EntityEvidenceSource;
import dev.mcagent.runtime.evidence.EntityObservation;

import java.util.List;
import java.util.Objects;
import java.util.UUID;

/** One exact, physically verified batch to publish atomically through World Knowledge. */
public record AttributableWorldUpdate(
        List<BlockFact> blocks,
        List<EntityFact> entities,
        List<UUID> removedEntities
) {
    public AttributableWorldUpdate {
        blocks = List.copyOf(Objects.requireNonNull(blocks, "blocks"));
        entities = List.copyOf(Objects.requireNonNull(entities, "entities"));
        removedEntities = List.copyOf(Objects.requireNonNull(removedEntities, "removedEntities"));
        if (removedEntities.stream().distinct().count() != removedEntities.size()) {
            throw new IllegalArgumentException("removed entity UUIDs must be unique");
        }
    }

    public record BlockFact(String dimension, long observedTick, BlockObservation observation) {
        public BlockFact {
            Objects.requireNonNull(dimension, "dimension");
            Objects.requireNonNull(observation, "observation");
            if (observedTick < 0L) {
                throw new IllegalArgumentException("observedTick must not be negative");
            }
            if (observation.source() != BlockEvidenceSource.ATTRIBUTABLE_ACTION
                    && observation.source() != BlockEvidenceSource.MISMATCH) {
                throw new IllegalArgumentException(
                        "attributable block facts require attributable_action or mismatch source");
            }
        }
    }

    public record EntityFact(String dimension, long observedTick, EntityObservation observation) {
        public EntityFact {
            Objects.requireNonNull(dimension, "dimension");
            Objects.requireNonNull(observation, "observation");
            if (observedTick < 0L) {
                throw new IllegalArgumentException("observedTick must not be negative");
            }
            if (observation.source() != EntityEvidenceSource.ATTRIBUTABLE_ACTION) {
                throw new IllegalArgumentException(
                        "attributable entity facts require attributable_action source");
            }
        }
    }
}
