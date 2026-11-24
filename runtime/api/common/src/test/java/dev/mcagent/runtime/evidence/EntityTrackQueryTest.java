package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EntityTrackQueryTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @Test
    void exactUuidAndCanonicalFiltersReadOnlyRememberedTracks() {
        EntityTrackStore store = new EntityTrackStore();
        UUID zombie = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID item = UUID.fromString("00000000-0000-0000-0000-000000000002");
        store.publishVisibleFrame(OVERWORLD, 10L, 3L, List.of(
                EntityObservation.visible(zombie, "minecraft:zombie", null, null,
                        new Vec3(1, 64, 0), 20.0F, 20.0F, true),
                EntityObservation.visible(item, "minecraft:item", "minecraft:diamond", 2,
                        new Vec3(2, 64, 0), null, null, false)
        ));

        assertEquals(zombie, store.get(zombie).orElseThrow().uuid());
        assertTrue(store.get(UUID.randomUUID()).isEmpty());
        assertEquals(List.of(zombie), EntityTrackQuery.list(store.snapshot(), null,
                        CanonicalIdentifierGlob.compile("minecraft:zombie"), null)
                .tracks().stream().map(EntityTrack::uuid).toList());
        assertEquals(List.of(item), EntityTrackQuery.list(store.snapshot(), null,
                        CanonicalIdentifierGlob.compile("minecraft:item"),
                        CanonicalIdentifierGlob.compile("minecraft:diamond"))
                .tracks().stream().map(EntityTrack::uuid).toList());
        assertTrue(EntityTrackQuery.list(store.snapshot(), null,
                CanonicalIdentifierGlob.compile("zombie"), null).tracks().isEmpty(),
                "entity filters must use full-match semantics");
    }

    @Test
    void listIsDeterministicAndCapsResultsAt256() {
        EntityTrackStore store = new EntityTrackStore();
        List<EntityObservation> observations = new ArrayList<>();
        for (int value = 256; value >= 0; value--) {
            observations.add(EntityObservation.visible(new UUID(0L, value + 1L),
                    "minecraft:zombie", null, null, new Vec3(value, 64, 0),
                    20.0F, 20.0F, true));
        }
        store.publishVisibleFrame(OVERWORLD, 10L, 3L, observations);

        EntityTrackQuery.ListResult result = EntityTrackQuery.list(store.snapshot(), 
                OVERWORLD, CanonicalIdentifierGlob.compile("*"), null);

        assertEquals(256, result.tracks().size());
        assertEquals(new UUID(0L, 1L), result.tracks().getFirst().uuid());
        assertEquals(new UUID(0L, 256L), result.tracks().getLast().uuid());
        assertTrue(result.hasMore());
    }

    @Test
    void attributableUpdatesAndRemovalUseOnlyTheExactUuid() {
        EntityTrackStore store = new EntityTrackStore();
        UUID dropped = UUID.fromString("00000000-0000-0000-0000-000000000003");
        UUID other = UUID.fromString("00000000-0000-0000-0000-000000000004");
        store.recordAttributable(OVERWORLD, 20L, 5L, EntityObservation.attributable(
                dropped, "minecraft:item", "minecraft:ender_eye", 1,
                new Vec3(4, 65, 6), null, null));
        store.recordAttributable(OVERWORLD, 20L, 5L, EntityObservation.attributable(
                other, "minecraft:item", "minecraft:stick", 1,
                new Vec3(5, 65, 6), null, null));

        EntityTrack track = store.get(dropped).orElseThrow();
        assertEquals(EntityTrack.State.KNOWN, track.state());
        assertEquals(EntityEvidenceSource.ATTRIBUTABLE_ACTION, track.source());
        assertTrue(store.removeAttributable(dropped));
        assertFalse(store.removeAttributable(dropped));
        assertTrue(store.get(dropped).isEmpty());
        assertTrue(store.get(other).isPresent());
    }
}
