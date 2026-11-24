package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BlockEvidenceStoreTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @BeforeAll
    static void bootMinecraftRegistries() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void framesPreserveThreeStateEvidenceAndOnlyOverwriteObservedCells() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos position = new BlockPos(10, 64, -3);
        BlockPos untouched = position.east();
        assertEquals(BlockEvidenceCell.State.UNKNOWN, store.cell(OVERWORLD, position).state());

        assertEquals(1L, store.publishFrame(OVERWORLD, 120L, List.of(
                BlockObservation.knownAir(position, BlockEvidenceSource.VISION))));
        BlockEvidenceCell air = store.cell(OVERWORLD, position);
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, air.state());
        assertEquals(BlockEvidenceSource.VISION, air.source());
        assertEquals(120L, air.observedTick());
        assertEquals(1L, air.observationRevision());

        store.publishFrame(OVERWORLD, 121L, List.of());
        assertEquals(air, store.cell(OVERWORLD, position));
        assertEquals(BlockEvidenceCell.State.UNKNOWN, store.cell(OVERWORLD, untouched).state());

        store.publishFrame(OVERWORLD, 122L, List.of(BlockObservation.of(
                position, Blocks.STONE.defaultBlockState(), BlockEvidenceSource.CONTACT)));
        BlockEvidenceCell block = store.cell(OVERWORLD, position);
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, block.state());
        assertEquals("minecraft:stone", block.blockState());
        assertEquals("minecraft:empty", block.fluid());
        assertEquals(BlockEvidenceSource.CONTACT, block.source());
        assertEquals(3L, block.observationRevision());

        assertEquals(4L, store.publishAttributable(List.of(
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 123L,
                        BlockObservation.knownAir(untouched, BlockEvidenceSource.MISMATCH)))));
        assertEquals(BlockEvidenceSource.MISMATCH, store.cell(OVERWORLD, untouched).source());
        assertEquals(block, store.cell(OVERWORLD, position));
    }

    @Test
    void anAirStateIsRememberedAsAir() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos position = new BlockPos(0, 0, 0);
        store.publishFrame(OVERWORLD, 1L, List.of(BlockObservation.of(
                position, Blocks.CAVE_AIR.defaultBlockState(), BlockEvidenceSource.VISION)));
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, store.cell(OVERWORLD, position).state());
    }

    @Test
    void boundedSnapshotsStayFrozenAcrossLaterFramesAndChunkBoundaries() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos west = new BlockPos(-17, 64, 0);
        BlockPos east = new BlockPos(17, 64, 0);
        store.publishFrame(OVERWORLD, 10L, List.of(BlockObservation.of(
                west, Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION)));

        BlockEvidenceSnapshot before = store.snapshot(OVERWORLD, new BlockPos(0, 64, 0), 32);
        long beforeVersion = before.contentVersion();

        store.publishFrame(OVERWORLD, 11L, List.of(
                BlockObservation.knownAir(west, BlockEvidenceSource.VISION),
                BlockObservation.of(east, Blocks.DIRT.defaultBlockState(),
                        BlockEvidenceSource.VISION)));
        BlockEvidenceSnapshot after = store.snapshot(OVERWORLD, new BlockPos(0, 64, 0), 32);

        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, before.block(west).state());
        assertEquals("minecraft:stone", before.block(west).blockState());
        assertEquals(BlockEvidenceCell.State.UNKNOWN, before.block(east).state());
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, after.block(west).state());
        assertEquals("minecraft:dirt", after.block(east).blockState());
        assertTrue(after.contentVersion() > beforeVersion);
    }

    @Test
    void contentVersionTracksWorldFactsWhileObservationRevisionTracksFrames() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos position = new BlockPos(4, 70, -5);
        store.publishFrame(OVERWORLD, 20L, List.of(BlockObservation.of(
                position, Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION)));
        BlockEvidenceSnapshot first = store.snapshot(OVERWORLD, position, 16);

        store.publishFrame(OVERWORLD, 21L, List.of(BlockObservation.of(
                position, Blocks.STONE.defaultBlockState(), BlockEvidenceSource.CONTACT)));
        BlockEvidenceSnapshot repeated = store.snapshot(OVERWORLD, position, 16);

        assertEquals(first.contentVersion(), repeated.contentVersion());
        assertEquals(20L, first.block(position).observedTick());
        assertEquals(1L, first.block(position).observationRevision());
        assertEquals(21L, repeated.block(position).observedTick());
        assertEquals(2L, repeated.block(position).observationRevision());

        store.publishAttributable(List.of(new AttributableWorldUpdate.BlockFact(
                OVERWORLD, 22L, BlockObservation.knownAir(position, BlockEvidenceSource.MISMATCH))));
        BlockEvidenceSnapshot changed = store.snapshot(OVERWORLD, position, 16);

        assertTrue(changed.contentVersion() > repeated.contentVersion());
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, changed.block(position).state());
    }

    @Test
    void finiteExpiryRemovesDueCellsAcrossDimensionsAndPreservesFrozenSnapshots() {
        BlockEvidenceStore store = new BlockEvidenceStore(5);
        BlockPos overworld = new BlockPos(1, 64, 1);
        BlockPos nether = new BlockPos(2, 70, 2);
        store.publishFrame(OVERWORLD, 100L, List.of(BlockObservation.of(
                overworld, Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION)));
        store.publishFrame("minecraft:the_nether", 101L, List.of(
                BlockObservation.knownAir(nether, BlockEvidenceSource.VISION)));
        BlockEvidenceSnapshot before = store.snapshot(OVERWORLD, overworld, 16);

        store.publishFrame(OVERWORLD, 104L, List.of());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, store.cell(OVERWORLD, overworld).state());
        store.publishFrame(OVERWORLD, 105L, List.of());

        assertEquals(BlockEvidenceCell.State.UNKNOWN, store.cell(OVERWORLD, overworld).state());
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR,
                store.cell("minecraft:the_nether", nether).state());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, before.block(overworld).state());

        store.publishFrame(OVERWORLD, 106L, List.of());
        assertEquals(BlockEvidenceCell.State.UNKNOWN,
                store.cell("minecraft:the_nether", nether).state());
    }

    @Test
    void refreshAtBoundaryKeepsTheCellForAnotherExpiryPeriod() {
        BlockEvidenceStore store = new BlockEvidenceStore(5);
        BlockPos position = new BlockPos(1, 64, 1);
        BlockObservation stone = BlockObservation.of(
                position, Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION);
        store.publishFrame(OVERWORLD, 100L, List.of(stone));

        store.publishFrame(OVERWORLD, 105L, List.of(stone));
        assertEquals(105L, store.cell(OVERWORLD, position).observedTick());
        store.publishFrame(OVERWORLD, 109L, List.of());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, store.cell(OVERWORLD, position).state());
        store.publishFrame(OVERWORLD, 110L, List.of());
        assertEquals(BlockEvidenceCell.State.UNKNOWN, store.cell(OVERWORLD, position).state());
    }

    @Test
    void neverExpiryRetainsEvidenceAtAnyLaterTick() {
        BlockEvidenceStore store = new BlockEvidenceStore(-1);
        BlockPos position = new BlockPos(1, 64, 1);
        store.publishFrame(OVERWORLD, 1L, List.of(
                BlockObservation.knownAir(position, BlockEvidenceSource.VISION)));

        store.publishFrame(OVERWORLD, Long.MAX_VALUE, List.of());

        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, store.cell(OVERWORLD, position).state());
    }

    @Test
    void sightFramesMergeSeenCellsRefreshClocksAndLeaveSnapshotsFrozen() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos stone = new BlockPos(17, 70, -3);
        BlockPos above = stone.above();
        OneSectionSight sight = new OneSectionSight(stone);
        sight.block(stone, Blocks.STONE.defaultBlockState());
        sight.air(above);

        assertEquals(1L, store.publishFrame(OVERWORLD, 5L, sight, List.of()));
        BlockEvidenceCell seen = store.cell(OVERWORLD, stone);
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, seen.state());
        assertEquals("minecraft:stone", seen.blockState());
        assertEquals("minecraft:empty", seen.fluid());
        assertEquals(BlockEvidenceSource.VISION, seen.source());
        assertEquals(5L, seen.observedTick());
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, store.cell(OVERWORLD, above).state());
        assertEquals(BlockEvidenceCell.State.UNKNOWN, store.cell(OVERWORLD, stone.below()).state());

        BlockEvidenceSnapshot before = store.snapshot(OVERWORLD, stone, 16);
        long version = store.contentVersion();
        store.publishFrame(OVERWORLD, 6L, sight, List.of(BlockObservation.of(
                stone, Blocks.STONE.defaultBlockState(), BlockEvidenceSource.CONTACT)));
        assertEquals(version, store.contentVersion());
        assertEquals(6L, store.cell(OVERWORLD, stone).observedTick());
        assertEquals(2L, store.cell(OVERWORLD, above).observationRevision());
        assertEquals(BlockEvidenceSource.CONTACT, store.cell(OVERWORLD, stone).source());
        assertEquals(5L, before.block(stone).observedTick());
        assertEquals(BlockEvidenceSource.VISION, before.block(stone).source());

        OneSectionSight mined = new OneSectionSight(stone);
        mined.air(stone);
        store.publishFrame(OVERWORLD, 7L, mined, List.of());
        assertTrue(store.contentVersion() > version);
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, store.cell(OVERWORLD, stone).state());
        assertEquals(BlockEvidenceSource.VISION, store.cell(OVERWORLD, stone).source());
        assertEquals(6L, store.cell(OVERWORLD, above).observedTick());
        assertEquals(Blocks.STONE.defaultBlockState(), before.knownState(stone));
        assertTrue(store.find(OVERWORLD,
                dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob.compile("minecraft:stone"), null, BlockKnowledge.MAX_FIND_RESULTS)
                .matches().isEmpty());
    }

    @Test
    void expiryForgetsOnlyTheCellsASightFrameStoppedRefreshing() {
        BlockEvidenceStore store = new BlockEvidenceStore(5);
        BlockPos stays = new BlockPos(1, 64, 1);
        BlockPos fades = new BlockPos(2, 64, 1);
        OneSectionSight both = new OneSectionSight(stays);
        both.block(stays, Blocks.STONE.defaultBlockState());
        both.block(fades, Blocks.DIRT.defaultBlockState());
        OneSectionSight one = new OneSectionSight(stays);
        one.block(stays, Blocks.STONE.defaultBlockState());

        store.publishFrame(OVERWORLD, 100L, both, List.of());
        for (long tick = 101L; tick <= 104L; tick++) store.publishFrame(OVERWORLD, tick, one, List.of());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, store.cell(OVERWORLD, fades).state());
        store.publishFrame(OVERWORLD, 105L, one, List.of());

        assertEquals(BlockEvidenceCell.State.UNKNOWN, store.cell(OVERWORLD, fades).state());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, store.cell(OVERWORLD, stays).state());
        store.publishFrame(OVERWORLD, 110L, List.of());
        assertEquals(BlockEvidenceCell.State.UNKNOWN, store.cell(OVERWORLD, stays).state());
    }

    /** A sight frame confined to the chunk section holding its first position. */
    private static final class OneSectionSight implements SightFrame {
        private final BlockPos anchor;
        private final long[] air = new long[64];
        private final long[] block = new long[64];
        private final Map<Integer, BlockState> states = new HashMap<>();

        private OneSectionSight(BlockPos anchor) {
            this.anchor = anchor;
        }

        private void air(BlockPos position) {
            int index = BlockKnowledge.localIndex(position);
            air[index >>> 6] |= 1L << index;
        }

        private void block(BlockPos position, BlockState state) {
            int index = BlockKnowledge.localIndex(position);
            block[index >>> 6] |= 1L << index;
            states.put(index, state);
        }

        @Override
        public int sectionCount() {
            return 1;
        }

        @Override
        public int sectionX(int section) {
            return anchor.getX() >> 4;
        }

        @Override
        public int sectionY(int section) {
            return anchor.getY() >> 4;
        }

        @Override
        public int sectionZ(int section) {
            return anchor.getZ() >> 4;
        }

        @Override
        public long[] air(int section) {
            return air;
        }

        @Override
        public long[] block(int section) {
            return block;
        }

        @Override
        public BlockState state(int section, int localIndex) {
            return states.get(localIndex);
        }
    }
}
