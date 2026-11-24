package dev.mcagent.runtime.knowledge.loaded;

import dev.mcagent.runtime.evidence.EntityObservation;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import net.minecraft.core.BlockPos;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.BiPredicate;

/** Entity knowledge of the loaded profile: the entities in loaded columns as of this tick. */
final class LoadedEntityKnowledgeStore {

    private Map<UUID, EntityTrack> tracks = new LinkedHashMap<>();

    /** Replace every track with this tick's entities, in UUID text order. */
    void publish(String dimension, long observedTick, long revision,
                 List<EntityObservation> observations) {
        Map<UUID, EntityTrack> next = new LinkedHashMap<>();
        observations.stream()
                .sorted(Comparator.comparing(observation -> observation.uuid().toString()))
                .forEach(observation -> next.put(observation.uuid(), EntityTrack.of(
                        observation, dimension, EntityTrack.State.VISIBLE,
                        observedTick, revision)));
        tracks = next;
    }

    /** Apply verified entity facts that lie in loaded columns, and exact removals. */
    void apply(List<AttributableWorldUpdate.EntityFact> facts, List<UUID> removed,
               long revision, BiPredicate<String, BlockPos> covered) {
        removed.forEach(tracks::remove);
        for (AttributableWorldUpdate.EntityFact fact : facts) {
            EntityObservation observation = fact.observation();
            if (!covered.test(fact.dimension(), BlockPos.containing(observation.position()))) {
                continue;
            }
            tracks.put(observation.uuid(), EntityTrack.of(observation, fact.dimension(),
                    EntityTrack.State.VISIBLE, fact.observedTick(), revision));
        }
    }

    Optional<EntityTrack> get(UUID uuid) {
        return Optional.ofNullable(tracks.get(uuid));
    }

    List<EntityTrack> snapshot() {
        return List.copyOf(tracks.values());
    }
}
