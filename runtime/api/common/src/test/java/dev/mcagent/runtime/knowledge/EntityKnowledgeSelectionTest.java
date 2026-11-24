package dev.mcagent.runtime.knowledge;

import dev.mcagent.runtime.evidence.EntityEvidenceSource;
import dev.mcagent.runtime.evidence.EntityTrack;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

class EntityKnowledgeSelectionTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @Test
    void automaticSelectionUsesOnlyDeclaredFiltersAndOrdersByDistanceThenUuid() {
        EntityTrack nearerHighUuid = track(new UUID(0L, 9L), "minecraft:zombie",
                new Vec3(2, 64, 0), EntityEvidenceSource.VISION);
        EntityTrack nearerLowUuid = track(new UUID(0L, 3L), "minecraft:zombie",
                new Vec3(-2, 64, 0), EntityEvidenceSource.LOADED_WORLD_STATE);
        EntityTrack farther = track(new UUID(0L, 1L), "minecraft:zombie",
                new Vec3(70, 64, 0), EntityEvidenceSource.LOADED_WORLD_STATE);
        EntityTrack wrongType = track(new UUID(0L, 2L), "minecraft:cow",
                new Vec3(1, 64, 0), EntityEvidenceSource.VISION);

        List<EntityTrack> selected = EntityKnowledgeSelection.selectTargets(
                List.of(farther, nearerHighUuid, wrongType, nearerLowUuid),
                OVERWORLD, CanonicalIdentifierGlob.compile("minecraft:zombie"), null,
                new Vec3(0, 64, 0), null);

        assertEquals(List.of(nearerLowUuid.uuid(), nearerHighUuid.uuid(), farther.uuid()),
                selected.stream().map(EntityTrack::uuid).toList());
    }

    @Test
    void declaredRadiusIsTheOnlyDistanceConstraint() {
        EntityTrack inside = track(new UUID(0L, 1L), "minecraft:item",
                new Vec3(8, 64, 0), EntityEvidenceSource.VISION);
        EntityTrack outside = track(new UUID(0L, 2L), "minecraft:item",
                new Vec3(9, 64, 0), EntityEvidenceSource.LOADED_WORLD_STATE);

        List<EntityTrack> selected = EntityKnowledgeSelection.selectTargets(
                List.of(outside, inside), OVERWORLD,
                CanonicalIdentifierGlob.compile("minecraft:item"), null,
                new Vec3(0, 64, 0), 8.0);

        assertEquals(List.of(inside.uuid()), selected.stream().map(EntityTrack::uuid).toList());
    }

    @Test
    void automaticSelectionPreservesGroundedKnownTracksForReacquisition() {
        EntityTrack known = new EntityTrack(new UUID(0L, 5L), OVERWORLD,
                "minecraft:item", "minecraft:nautilus_shell", 1,
                new Vec3(2, 64, 0), null, null, false, EntityTrack.State.KNOWN,
                EntityEvidenceSource.VISION, 20L, 1L);

        assertEquals(List.of(known.uuid()), EntityKnowledgeSelection.selectTargets(
                        List.of(known), OVERWORLD,
                        CanonicalIdentifierGlob.compile("minecraft:item"),
                        CanonicalIdentifierGlob.compile("minecraft:nautilus_shell"),
                        new Vec3(0, 64, 0), 8.0).stream()
                .map(EntityTrack::uuid).toList());
    }

    @Test
    void automaticSelectionExcludesLoadedOnlyKnownTracks() {
        EntityTrack loadedOnly = new EntityTrack(new UUID(0L, 6L), OVERWORLD,
                "minecraft:item", "minecraft:nautilus_shell", 1,
                new Vec3(2, 64, 0), null, null, false, EntityTrack.State.KNOWN,
                EntityEvidenceSource.LOADED_WORLD_STATE, 20L, 1L);

        assertEquals(List.of(), EntityKnowledgeSelection.selectTargets(
                List.of(loadedOnly), OVERWORLD,
                CanonicalIdentifierGlob.compile("minecraft:item"),
                CanonicalIdentifierGlob.compile("minecraft:nautilus_shell"),
                new Vec3(0, 64, 0), 8.0));
    }

    @Test
    void providerProvenanceDoesNotChangeSelectionForTheSamePublishedFacts() {
        UUID uuid = new UUID(0L, 7L);
        EntityTrack grounded = track(uuid, "minecraft:zombie",
                new Vec3(4, 64, 0), EntityEvidenceSource.VISION);
        EntityTrack loaded = track(uuid, "minecraft:zombie",
                new Vec3(4, 64, 0), EntityEvidenceSource.LOADED_WORLD_STATE);

        List<UUID> groundedSelection = EntityKnowledgeSelection.selectTargets(
                        List.of(grounded), OVERWORLD, null, null,
                        new Vec3(0, 64, 0), null).stream()
                .map(EntityTrack::uuid).toList();
        List<UUID> loadedSelection = EntityKnowledgeSelection.selectTargets(
                        List.of(loaded), OVERWORLD, null, null,
                        new Vec3(0, 64, 0), null).stream()
                .map(EntityTrack::uuid).toList();

        assertEquals(groundedSelection, loadedSelection);
        assertEquals(EntityKnowledgeSelection.avoidanceCenters(
                        List.of(grounded), OVERWORLD),
                EntityKnowledgeSelection.avoidanceCenters(
                        List.of(loaded), OVERWORLD));

        assertEquals(EntityKnowledgeSelection.selectTargets(
                        List.of(grounded), OVERWORLD,
                        CanonicalIdentifierGlob.compile("minecraft:cow"), null,
                        new Vec3(0, 64, 0), null),
                EntityKnowledgeSelection.selectTargets(
                        List.of(loaded), OVERWORLD,
                        CanonicalIdentifierGlob.compile("minecraft:cow"), null,
                        new Vec3(0, 64, 0), null));
    }

    private static EntityTrack track(
            UUID uuid, String entityId, Vec3 position, EntityEvidenceSource source) {
        return new EntityTrack(uuid, OVERWORLD, entityId, null, null, position,
                20.0f, 20.0f, entityId.equals("minecraft:zombie"),
                EntityTrack.State.VISIBLE, source, 20L, 1L);
    }
}
