package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BlockKnowledgeTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @BeforeAll
    static void bootMinecraftRegistries() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void findUsesRe2FullMatchAndReturnsOnlyRememberedKnownBlocks() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos stone = new BlockPos(1, 64, 0);
        BlockPos diamond = new BlockPos(2, 12, 0);
        store.publishFrame(OVERWORLD, 10L, List.of(
                BlockObservation.of(stone, Blocks.STONE.defaultBlockState(),
                        BlockEvidenceSource.VISION),
                BlockObservation.of(diamond, Blocks.DIAMOND_ORE.defaultBlockState(),
                        BlockEvidenceSource.VISION),
                BlockObservation.knownAir(new BlockPos(3, 64, 0), BlockEvidenceSource.VISION)
        ));

        BlockKnowledge.FindResult ores = store.find(OVERWORLD,
                CanonicalIdentifierGlob.compile("minecraft:*_ore"), null, BlockKnowledge.MAX_FIND_RESULTS);
        assertEquals(List.of(diamond), ores.matches().stream()
                .map(BlockKnowledge.LocatedCell::position).toList());
        assertFalse(ores.hasMore());
        assertTrue(store.find(OVERWORLD,
                CanonicalIdentifierGlob.compile("stone"), null, BlockKnowledge.MAX_FIND_RESULTS).matches().isEmpty(),
                "canonical id Glob must use full-match semantics");
        assertEquals(List.of(stone, diamond), store.find(OVERWORLD,
                        CanonicalIdentifierGlob.compile("*"), null, BlockKnowledge.MAX_FIND_RESULTS).matches().stream()
                .map(BlockKnowledge.LocatedCell::position).toList());
    }

    @Test
    void findIsDeterministicAndCapsResultsAt256() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        List<BlockObservation> observations = new ArrayList<>();
        for (int x = 256; x >= 0; x--) {
            observations.add(BlockObservation.of(new BlockPos(x, 64, 0),
                    Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION));
        }
        store.publishFrame(OVERWORLD, 10L, observations);

        BlockKnowledge.FindResult result = store.find(OVERWORLD,
                CanonicalIdentifierGlob.compile("*"), null, BlockKnowledge.MAX_FIND_RESULTS);

        assertEquals(256, result.matches().size());
        assertEquals(new BlockPos(0, 64, 0), result.matches().get(0).position());
        assertEquals(new BlockPos(255, 64, 0), result.matches().get(255).position());
        assertTrue(result.hasMore());
    }

    @Test
    void findOrdersMatchingEvidenceByDistanceBeforeApplyingTheRequestedLimit() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos origin = new BlockPos(10, 64, 10);
        BlockPos fartherWithLowerCoordinates = new BlockPos(8, 64, 10);
        BlockPos nearestFirstByTieBreak = new BlockPos(10, 64, 11);
        BlockPos nearestSecondByTieBreak = new BlockPos(11, 64, 10);
        BlockPos farthest = new BlockPos(20, 64, 10);
        store.publishFrame(OVERWORLD, 10L, List.of(
                BlockObservation.of(fartherWithLowerCoordinates,
                        Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION),
                BlockObservation.of(nearestFirstByTieBreak,
                        Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION),
                BlockObservation.of(nearestSecondByTieBreak,
                        Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION),
                BlockObservation.of(farthest,
                        Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION)
        ));

        BlockKnowledge.FindResult result = store.find(
                OVERWORLD, CanonicalIdentifierGlob.compile("minecraft:stone"), origin, 2);

        assertEquals(List.of(nearestFirstByTieBreak, nearestSecondByTieBreak),
                result.matches().stream().map(BlockKnowledge.LocatedCell::position).toList());
        assertTrue(result.hasMore());
    }

    @Test
    void findKeepsCoordinateOrderWhenOnlyTheRequestedLimitChanges() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        store.publishFrame(OVERWORLD, 10L, List.of(
                BlockObservation.of(new BlockPos(3, 64, 0),
                        Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION),
                BlockObservation.of(new BlockPos(1, 64, 0),
                        Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION),
                BlockObservation.of(new BlockPos(2, 64, 0),
                        Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION)
        ));

        BlockKnowledge.FindResult result = store.find(
                OVERWORLD, CanonicalIdentifierGlob.compile("minecraft:stone"), null, 2);

        assertEquals(List.of(new BlockPos(1, 64, 0), new BlockPos(2, 64, 0)),
                result.matches().stream().map(BlockKnowledge.LocatedCell::position).toList());
        assertTrue(result.hasMore());
    }

    @Test
    void regionIsInclusiveXFastestAndCompleteOnlyWhenEveryCellIsKnown() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos min = new BlockPos(4, 60, 8);
        store.publishFrame(OVERWORLD, 91L, List.of(
                BlockObservation.of(min, Blocks.STONE.defaultBlockState(),
                        BlockEvidenceSource.CONTACT)
        ));

        BlockKnowledge.RegionResult partial = store.region(OVERWORLD,
                BlockKnowledge.RegionBounds.between(min, min.east()));
        assertEquals(List.of(min, min.east()), partial.cells().stream()
                .map(BlockKnowledge.LocatedCell::position).toList());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, partial.cells().get(0).cell().state());
        assertEquals(BlockEvidenceCell.State.UNKNOWN, partial.cells().get(1).cell().state());
        assertFalse(partial.complete());

        store.publishAttributable(List.of(new AttributableWorldUpdate.BlockFact(OVERWORLD, 92L,
                BlockObservation.knownAir(min.east(), BlockEvidenceSource.MISMATCH))));
        assertTrue(store.region(OVERWORLD,
                BlockKnowledge.RegionBounds.between(min, min.east())).complete());
    }

    @Test
    void chunkedQueriesPreserveNegativeChunkAndSectionCoordinates() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        BlockPos far = new BlockPos(-17, -17, -17);
        BlockPos near = new BlockPos(-1, -1, -1);
        store.publishFrame(OVERWORLD, 12L, List.of(
                BlockObservation.of(near, Blocks.STONE.defaultBlockState(),
                        BlockEvidenceSource.VISION),
                BlockObservation.of(far, Blocks.DIRT.defaultBlockState(),
                        BlockEvidenceSource.VISION)
        ));

        assertEquals(List.of(far, near), store.find(OVERWORLD,
                        CanonicalIdentifierGlob.compile("*"), null, BlockKnowledge.MAX_FIND_RESULTS).matches().stream()
                .map(BlockKnowledge.LocatedCell::position).toList());
        assertEquals("minecraft:dirt", store.region(OVERWORLD,
                        BlockKnowledge.RegionBounds.between(far, far))
                .cells().getFirst().cell().blockState());
    }

    @Test
    void regionEnforcesAxisAndVolumeBoundsAtTheEvidenceSeam() {
        assertEquals(new BlockPos(2, 1, 1),
                new BlockKnowledge.RegionBounds(BlockPos.ZERO, BlockPos.ZERO.east()).size());
        assertThrows(IllegalArgumentException.class, () -> BlockKnowledge.RegionBounds.between(
                BlockPos.ZERO, new BlockPos(128, 0, 0)));
        assertThrows(IllegalArgumentException.class, () -> new BlockKnowledge.RegionBounds(
                BlockPos.ZERO, new BlockPos(128, 0, 0)));
        assertThrows(IllegalArgumentException.class, () -> BlockKnowledge.RegionBounds.between(
                BlockPos.ZERO, new BlockPos(63, 31, 32)));
        assertThrows(IllegalArgumentException.class, () -> BlockKnowledge.RegionBounds.between(
                BlockPos.ZERO, new BlockPos(-1, 0, 0)));
    }
}
