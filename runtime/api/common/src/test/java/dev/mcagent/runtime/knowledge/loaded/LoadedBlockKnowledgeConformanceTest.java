package dev.mcagent.runtime.knowledge.loaded;

import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSnapshot;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockObservation;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LoadedBlockKnowledgeConformanceTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @BeforeAll
    static void bootMinecraftRegistries() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    private static final CanonicalIdentifierMatcher STONE =
            CanonicalIdentifierGlob.compile("minecraft:stone");

    private static List<BlockPos> positions(List<BlockKnowledge.LocatedCell> cells) {
        return cells.stream().map(BlockKnowledge.LocatedCell::position).toList();
    }

    @Test
    void exactLookupDistinguishesCachedAirBlockAndUnknownWithLoadedProvenance() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        BlockPos stone = new BlockPos(1, 64, 1);
        BlockPos air = stone.east();
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 0, 16,
                Map.of(stone, Blocks.STONE.defaultBlockState()));
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        BlockKnowledge blocks = loaded.blocks();

        loaded.publishSnapshot(tracker.snapshot(), 20L);

        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, blocks.cell(OVERWORLD, stone).state());
        assertEquals("minecraft:stone", blocks.cell(OVERWORLD, stone).blockState());
        assertEquals("loaded_world_state", blocks.cell(OVERWORLD, stone).source().wireValue());
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, blocks.cell(OVERWORLD, air).state());
        assertEquals("loaded_world_state", blocks.cell(OVERWORLD, air).source().wireValue());
        assertEquals(BlockEvidenceCell.State.UNKNOWN,
                blocks.cell(OVERWORLD, new BlockPos(16, 64, 1)).state());

        tracker.pending(new ChunkPos(0, 0));
        loaded.publishSnapshot(tracker.snapshot(), 21L);
        assertEquals(BlockEvidenceCell.State.UNKNOWN, blocks.cell(OVERWORLD, stone).state(),
                "pending delivery must remain UNKNOWN through World Knowledge");
    }

    @Test
    void findAndRegionKeepOrderingBoundsAndIncompleteCoverage() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        BlockPos first = new BlockPos(-15, 64, 1);
        BlockPos second = new BlockPos(1, 64, 1);
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(-1, 0), 0, 16,
                Map.of(first, Blocks.STONE.defaultBlockState()));
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 0, 16,
                Map.of(second, Blocks.STONE.defaultBlockState()));
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);
        BlockKnowledge blocks = loaded.blocks();

        var find = blocks.find(OVERWORLD, STONE, null, 1);
        var near = blocks.find(OVERWORLD, STONE, new BlockPos(0, 64, 0), 2);
        var region = blocks.region(OVERWORLD, BlockKnowledge.RegionBounds.between(
                new BlockPos(15, 64, 0), new BlockPos(16, 64, 0)));
        var completeRegion = blocks.region(OVERWORLD,
                BlockKnowledge.RegionBounds.between(second, second.east()));

        assertEquals(List.of(first), positions(find.matches()));
        assertTrue(find.hasMore());
        assertEquals(List.of(second, first), positions(near.matches()));
        assertFalse(near.hasMore());
        assertEquals(new BlockPos(2, 1, 1), region.size());
        assertEquals(2, region.cells().size());
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, region.cells().get(0).cell().state());
        assertEquals(BlockEvidenceCell.State.UNKNOWN, region.cells().get(1).cell().state());
        assertFalse(region.complete());
        assertEquals(2, completeRegion.cells().size());
        assertTrue(completeRegion.complete());
        assertTrue(blocks.find(OVERWORLD,
                CanonicalIdentifierGlob.compile("minecraft:diamond_block"), null, 2)
                .matches().isEmpty());
    }

    @Test
    void blockFindMatchesEachDistinctLoadedBlockIdOncePerQuery() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        Map<BlockPos, net.minecraft.world.level.block.state.BlockState> blocks =
                new LinkedHashMap<>();
        for (int y = 64; y < 80; y++) {
            for (int z = 0; z < 16; z++) {
                for (int x = 0; x < 16; x++) {
                    blocks.put(new BlockPos(x, y, z), Blocks.STONE.defaultBlockState());
                }
            }
        }
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 4, 1, blocks);
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);
        AtomicInteger matcherCalls = new AtomicInteger();

        assertTrue(loaded.blocks().find(OVERWORLD, blockId -> {
            matcherCalls.incrementAndGet();
            return false;
        }, new BlockPos(0, 64, 0), 32).matches().isEmpty());
        assertEquals(1, matcherCalls.get(), "one query must test each block id once");
    }

    @Test
    void findSectionPruningKeepsGlobalOrderingAndHasMore() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        BlockPos farthest = new BlockPos(0, 64, 0);
        BlockPos farther = farthest.east();
        BlockPos nearest = new BlockPos(16, 64, 0);
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 4, 1, Map.of(
                farthest, Blocks.STONE.defaultBlockState(),
                farther, Blocks.STONE.defaultBlockState()));
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(1, 0), 4, 1,
                Map.of(nearest, Blocks.STONE.defaultBlockState()));
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);

        var coordinate = loaded.blocks().find(OVERWORLD, STONE, null, 1);
        var near = loaded.blocks().find(OVERWORLD, STONE, new BlockPos(15, 64, 0), 1);

        assertEquals(List.of(farthest), positions(coordinate.matches()));
        assertTrue(coordinate.hasMore());
        assertEquals(List.of(nearest), positions(near.matches()));
        assertTrue(near.hasMore());
    }

    @Test
    void knownBlocksWithinDoesNotInspectColumnsOutsideItsRadius() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 4, 1,
                Map.of(new BlockPos(1, 64, 1), Blocks.DIRT.defaultBlockState()));
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(10, 0), 4, 1,
                Map.of(new BlockPos(160, 64, 1), Blocks.STONE.defaultBlockState()));
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);
        AtomicInteger matcherCalls = new AtomicInteger();

        assertTrue(loaded.blocks().knownWithin(OVERWORLD, blockId -> {
            matcherCalls.incrementAndGet();
            return false;
        }, new BlockPos(1, 64, 1), 1).isEmpty());
        assertEquals(1, matcherCalls.get(),
                "columns outside the requested radius must not reach the matcher");
    }

    @Test
    void knownBlocksWithinIsNotCappedAtTheFindLimit() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        Map<BlockPos, net.minecraft.world.level.block.state.BlockState> blocks =
                new LinkedHashMap<>();
        for (int y = 0; y < 300; y++) {
            blocks.put(new BlockPos(1, y, 1), Blocks.SPAWNER.defaultBlockState());
        }
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 0, 24, blocks);
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);

        assertEquals(300, loaded.blocks().knownWithin(OVERWORLD,
                CanonicalIdentifierGlob.compile("minecraft:spawner"),
                new BlockPos(1, 64, 1), 256).size());
    }

    @Test
    void snapshotsStayFrozenAcrossUpdateUnloadAndLaterLoad() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        BlockPos target = new BlockPos(1, 64, 1);
        ChunkPos column = new ChunkPos(0, 0);
        tracker.loadFixtureColumn(OVERWORLD, column, 0, 16,
                Map.of(target, Blocks.STONE.defaultBlockState()));
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);
        BlockEvidenceSnapshot old = loaded.blocks().snapshot(OVERWORLD, target, 16);
        long revision = loaded.revision().value();

        tracker.update(OVERWORLD, target, Blocks.DIRT.defaultBlockState());
        loaded.publishSnapshot(tracker.snapshot(), 21L);
        tracker.unload(column);
        loaded.publishSnapshot(tracker.snapshot(), 22L);
        tracker.loadFixtureColumn(OVERWORLD, column, 0, 16,
                Map.of(target, Blocks.GOLD_BLOCK.defaultBlockState()));
        loaded.publishSnapshot(tracker.snapshot(), 23L);

        assertEquals("minecraft:stone", old.block(target).blockState());
        assertEquals(revision, old.block(target).observationRevision());
        assertEquals(Blocks.STONE.defaultBlockState(), old.knownState(target));
        assertNull(old.knownState(new BlockPos(1, 64, 400)),
                "cells outside the frozen columns are unknown");
        assertEquals("minecraft:gold_block",
                loaded.blocks().cell(OVERWORLD, target).blockState());
        assertEquals(Blocks.GOLD_BLOCK.defaultBlockState(),
                loaded.blocks().snapshot(OVERWORLD, target, 16).knownState(target));
    }

    @Test
    void attributableBlockReplacesCoveredPageWithoutCreatingCoverage() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        BlockPos covered = new BlockPos(1, 64, 1);
        BlockPos unchanged = covered.east();
        BlockPos outside = new BlockPos(16, 64, 1);
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 0, 16,
                Map.of(covered, Blocks.STONE.defaultBlockState()));
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);
        BlockKnowledge blocks = loaded.blocks();
        long before = loaded.revision().value();

        var published = loaded.apply(new AttributableWorldUpdate(List.of(
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 20L,
                        BlockObservation.of(covered, Blocks.DIRT.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION)),
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 20L,
                        BlockObservation.of(outside, Blocks.GOLD_BLOCK.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION))
        ), List.of(), List.of()));

        assertEquals(before + 1L, published.value());
        assertEquals("minecraft:dirt", blocks.cell(OVERWORLD, covered).blockState());
        assertEquals(BlockEvidenceSource.ATTRIBUTABLE_ACTION,
                blocks.cell(OVERWORLD, covered).source());
        assertEquals(published.value(), blocks.cell(OVERWORLD, covered).observationRevision());
        assertEquals(Blocks.DIRT.defaultBlockState(),
                blocks.snapshot(OVERWORLD, covered, 1).knownState(covered));
        assertEquals(before, blocks.cell(OVERWORLD, unchanged).observationRevision(),
                "unaffected cells in the replaced page retain their prior observation clock");
        assertEquals(BlockEvidenceCell.State.UNKNOWN, blocks.cell(OVERWORLD, outside).state(),
                "an attributable update outside loaded coverage must not create membership");

        loaded.publishSnapshot(tracker.snapshot(), 20L);
        assertEquals(published.value() + 1L, loaded.revision().value(),
                "a same-tick ordinary frame remains a separate publication");
        assertEquals("minecraft:stone", blocks.cell(OVERWORLD, covered).blockState(),
                "the next publication shows the tracker's page again");
    }

    @Test
    void identicalCoveredAttributableFactAdvancesRevisionWithoutContentChange() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        BlockPos target = new BlockPos(1, 64, 1);
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 0, 16,
                Map.of(target, Blocks.STONE.defaultBlockState()));
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);
        var fact = new AttributableWorldUpdate.BlockFact(OVERWORLD, 21L,
                BlockObservation.of(target, Blocks.DIRT.defaultBlockState(),
                        BlockEvidenceSource.ATTRIBUTABLE_ACTION));

        loaded.apply(new AttributableWorldUpdate(List.of(fact), List.of(), List.of()));
        long revision = loaded.revision().value();
        long content = loaded.blocks().contentVersion();
        var repeated = loaded.apply(new AttributableWorldUpdate(List.of(fact), List.of(), List.of()));

        assertEquals(revision + 1L, repeated.value());
        assertEquals(content, loaded.blocks().contentVersion());
        assertEquals(repeated.value(),
                loaded.blocks().cell(OVERWORLD, target).observationRevision());
    }

    @Test
    void unchangedColumnsKeepTheirClocksAndContentVersion() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        BlockPos target = new BlockPos(1, 64, 1);
        tracker.loadFixtureColumn(OVERWORLD, new ChunkPos(0, 0), 0, 16,
                Map.of(target, Blocks.STONE.defaultBlockState()));
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);
        long content = loaded.blocks().contentVersion();

        loaded.publishSnapshot(tracker.snapshot(), 21L);

        assertEquals(2L, loaded.revision().value());
        assertEquals(content, loaded.blocks().contentVersion());
        assertEquals(20L, loaded.blocks().cell(OVERWORLD, target).observedTick());
        tracker.update(OVERWORLD, target, Blocks.DIRT.defaultBlockState());
        loaded.publishSnapshot(tracker.snapshot(), 22L);
        assertEquals(content + 1L, loaded.blocks().contentVersion());
        assertEquals(22L, loaded.blocks().cell(OVERWORLD, target).observedTick());
    }

    @Test
    void readsDoNotChangeCoverageOrRevision() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        LoadedWorldKnowledge loaded = new LoadedWorldKnowledge();
        loaded.publishSnapshot(tracker.snapshot(), 20L);
        long revision = loaded.revision().value();

        for (int i = 0; i < 3; i++) {
            assertEquals(BlockEvidenceCell.State.UNKNOWN,
                    loaded.blocks().cell(OVERWORLD, new BlockPos(512, 64, 512)).state());
        }

        assertEquals(revision, loaded.revision().value());
        assertTrue(tracker.snapshot().columns().isEmpty());
    }
}
