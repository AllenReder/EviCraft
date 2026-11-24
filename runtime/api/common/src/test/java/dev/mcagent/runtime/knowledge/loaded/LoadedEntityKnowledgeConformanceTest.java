package dev.mcagent.runtime.knowledge.loaded;

import dev.mcagent.runtime.evidence.EntityEvidenceSource;
import dev.mcagent.runtime.evidence.EntityObservation;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.evidence.EntityTrackQuery;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LoadedEntityKnowledgeConformanceTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @BeforeAll
    static void bootMinecraftRegistries() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void onePublicationSharesOneRevisionAcrossBlocksAndLoadedEntities() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        BlockPos stone = new BlockPos(1, 64, 1);
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 0, 16,
                Map.of(stone, Blocks.STONE.defaultBlockState()));
        UUID zombie = new UUID(0L, 2L);
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();

        loaded.publishSnapshot(tracker.snapshot(), 20L, List.of(
                loaded(zombie, "minecraft:zombie", null, null, new Vec3(2, 64, 2))));

        EntityTrack track = loaded.entity(zombie).orElseThrow();
        assertEquals("minecraft:stone", loaded.blocks().cell(OVERWORLD, stone).blockState());
        assertEquals(EntityTrack.State.VISIBLE, track.state());
        assertEquals(EntityEvidenceSource.LOADED_WORLD_STATE, track.source());
        assertEquals(20L, track.observedTick());
        assertEquals(loaded.revision().value(), track.observationRevision());
        assertEquals(loaded.revision().value(),
                loaded.blocks().cell(OVERWORLD, stone).observationRevision());
    }

    @Test
    void laterPublicationsDropMissingIdentitiesAndLeaveEarlierReadsAlone() {
        UUID first = new UUID(0L, 1L);
        UUID replacement = new UUID(0L, 2L);
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(emptySnapshot(), 20L, List.of(
                loaded(first, "minecraft:zombie", null, null, new Vec3(1, 64, 1))));

        List<EntityTrack> earlier = loaded.entities();
        assertSame(earlier.getFirst(), loaded.entity(first).orElseThrow());
        assertTrue(loaded.entity(replacement).isEmpty(),
                "an exact UUID must never substitute another entity");

        loaded.publishSnapshot(emptySnapshot(), 21L, List.of(
                loaded(replacement, "minecraft:zombie", null, null, new Vec3(1, 64, 1))));

        assertEquals(List.of(first), earlier.stream().map(EntityTrack::uuid).toList());
        assertTrue(loaded.entity(first).isEmpty());
        assertEquals(replacement, loaded.entity(replacement).orElseThrow().uuid());
    }

    @Test
    void entityListKeepsUuidOrderingFiltersBoundAndHasMore() {
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        List<EntityObservation> observations = new ArrayList<>();
        for (int i = 300; i >= 1; i--) {
            observations.add(loaded(new UUID(0L, i), "minecraft:item",
                    i % 2 == 0 ? "minecraft:stone" : "minecraft:dirt", 1,
                    new Vec3(i, 64, 0)));
        }
        loaded.publishSnapshot(emptySnapshot(), 20L, observations);

        EntityTrackQuery.ListResult bounded = EntityTrackQuery.list(loaded.entities(),
                OVERWORLD, CanonicalIdentifierGlob.compile("minecraft:item"), null);
        EntityTrackQuery.ListResult filtered = EntityTrackQuery.list(loaded.entities(),
                OVERWORLD, null, CanonicalIdentifierGlob.compile("minecraft:stone"));

        assertEquals(EntityTrackQuery.MAX_LIST_RESULTS, bounded.tracks().size());
        assertTrue(bounded.hasMore());
        assertEquals(new UUID(0L, 1L), bounded.tracks().getFirst().uuid());
        assertEquals(new UUID(0L, 256L), bounded.tracks().getLast().uuid());
        assertEquals(150, filtered.tracks().size());
        assertFalse(filtered.hasMore());
        assertTrue(filtered.tracks().stream().allMatch(
                track -> "minecraft:stone".equals(track.itemId())));
    }

    @Test
    void publicationsReplaceTracksAndEveryPublicationAdvancesTheRevision() {
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        UUID entity = new UUID(0L, 42L);

        loaded.publishSnapshot(emptySnapshot(), 20L, List.of(
                loaded(entity, "minecraft:zombie", null, null, new Vec3(1, 64, 1))));
        assertEquals(1L, loaded.revision().value());
        assertEquals(1L, loaded.entity(entity).orElseThrow().observationRevision());

        assertEquals(2L, loaded.apply(
                new AttributableWorldUpdate(List.of(), List.of(), List.of())).value());

        loaded.publishBodyUnavailable("minecraft:the_nether", 21L);
        assertEquals(3L, loaded.revision().value());
        assertTrue(loaded.entities().isEmpty(),
                "ordinary publications must replace rather than retain loaded tracks");
    }

    private static VirtualClientChunkTracker.Snapshot emptySnapshot() {
        return new VirtualClientChunkTracker.Snapshot(OVERWORLD, Map.of(), 0L);
    }

    private static EntityObservation loaded(
            UUID uuid, String entityId, String itemId, Integer itemCount, Vec3 position) {
        return EntityObservation.loaded(uuid, entityId, itemId, itemCount,
                position, entityId.equals("minecraft:zombie") ? 20.0f : null,
                entityId.equals("minecraft:zombie") ? 20.0f : null,
                entityId.equals("minecraft:zombie"));
    }
}
