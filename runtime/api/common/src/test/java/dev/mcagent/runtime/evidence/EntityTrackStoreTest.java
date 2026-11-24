package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.knowledge.EntityKnowledgeSelection;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EntityTrackStoreTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @Test
    void visibleTrackFreezesWhileHiddenAndExpiresAt400Ticks() {
        EntityTrackStore store = new EntityTrackStore();
        UUID uuid = UUID.fromString("00000000-0000-0000-0000-000000000243");
        store.publishVisibleFrame(OVERWORLD, 100L, 7L, List.of(
                EntityObservation.visible(uuid, "minecraft:zombie", null, null,
                        new Vec3(2.5, 64.0, 3.5), 20.0F, 20.0F, true)
        ));

        EntityTrack visible = store.get(uuid).orElseThrow();
        assertEquals(EntityTrack.State.VISIBLE, visible.state());
        assertTrue(EntityKnowledgeSelection.eligibleForTargeting(visible));
        assertEquals(new Vec3(2.5, 64.0, 3.5), visible.position());
        assertTrue(visible.hostile());

        store.publishVisibleFrame(OVERWORLD, 101L, 8L, List.of());
        EntityTrack known = store.get(uuid).orElseThrow();
        assertEquals(EntityTrack.State.KNOWN, known.state());
        assertEquals(new Vec3(2.5, 64.0, 3.5), known.position());
        assertEquals(20.0F, known.health());
        assertEquals(100L, known.observedTick());
        assertEquals(7L, known.observationRevision());
        assertTrue(known.hostile());

        store.publishVisibleFrame(OVERWORLD, 499L, 9L, List.of());
        assertTrue(store.get(uuid).isPresent());
        store.publishVisibleFrame(OVERWORLD, 500L, 10L, List.of());
        assertTrue(store.get(uuid).isEmpty());
    }

    @Test
    void configuredLifetimeExpiresAtBoundaryAndCurrentVisibilityRefreshesFirst() {
        EntityTrackStore store = new EntityTrackStore(5);
        UUID uuid = UUID.fromString("00000000-0000-0000-0000-000000000244");
        EntityObservation first = EntityObservation.visible(uuid, "minecraft:sheep", null, null,
                new Vec3(2.5, 64.0, 3.5), 8.0F, 8.0F, false);
        store.publishVisibleFrame(OVERWORLD, 100L, 1L, List.of(first));

        store.publishVisibleFrame(OVERWORLD, 104L, 2L, List.of());
        assertTrue(store.get(uuid).isPresent());
        store.publishVisibleFrame(OVERWORLD, 105L, 3L, List.of(first));
        EntityTrack refreshed = store.get(uuid).orElseThrow();
        assertEquals(EntityTrack.State.VISIBLE, refreshed.state());
        assertEquals(105L, refreshed.observedTick());

        store.publishVisibleFrame(OVERWORLD, 109L, 4L, List.of());
        assertTrue(store.get(uuid).isPresent());
        store.publishVisibleFrame(OVERWORLD, 110L, 5L, List.of());
        assertTrue(store.get(uuid).isEmpty());
    }

    @Test
    void neverLifetimeRetainsHiddenAndAttributableTracks() {
        EntityTrackStore store = new EntityTrackStore(-1);
        UUID visual = UUID.fromString("00000000-0000-0000-0000-000000000245");
        UUID attributable = UUID.fromString("00000000-0000-0000-0000-000000000246");
        store.publishVisibleFrame(OVERWORLD, 10L, 1L, List.of(
                EntityObservation.visible(visual, "minecraft:sheep", null, null,
                        new Vec3(1.5, 64.0, 1.5), 8.0F, 8.0F, false)));
        store.recordAttributable(OVERWORLD, 11L, 2L,
                EntityObservation.attributable(attributable, "minecraft:item",
                        "minecraft:apple", 1, new Vec3(2.5, 64.0, 2.5), null, null));

        store.publishVisibleFrame(OVERWORLD, Long.MAX_VALUE, 3L, List.of());

        assertTrue(store.get(visual).isPresent());
        assertTrue(store.get(attributable).isPresent());
    }

    @Test
    void actorAttributionSurvivesLaterVisionAndOcclusion() {
        EntityTrackStore store = new EntityTrackStore();
        UUID uuid = UUID.fromString("00000000-0000-0000-0000-000000000248");
        store.recordAttributable(OVERWORLD, 100L, 7L,
                EntityObservation.attributable(uuid, "minecraft:item",
                        "minecraft:rotten_flesh", 1, new Vec3(2.5, 64.0, 3.5),
                        null, null));

        store.publishVisibleFrame(OVERWORLD, 101L, 8L, List.of(
                EntityObservation.visible(uuid, "minecraft:item",
                        "minecraft:rotten_flesh", 1, new Vec3(2.75, 64.0, 3.5),
                        null, null, false)
        ));
        store.publishVisibleFrame(OVERWORLD, 102L, 9L, List.of());

        EntityTrack hiddenDrop = store.get(uuid).orElseThrow();
        assertEquals(EntityTrack.State.KNOWN, hiddenDrop.state());
        assertEquals(EntityEvidenceSource.ATTRIBUTABLE_ACTION, hiddenDrop.source());
        assertTrue(EntityKnowledgeSelection.eligibleForTargeting(hiddenDrop));
        assertEquals(new Vec3(2.75, 64.0, 3.5), hiddenDrop.position());
    }
}
