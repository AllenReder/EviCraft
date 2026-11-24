package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockEvidenceStore;
import dev.mcagent.runtime.evidence.BlockObservation;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class PlacementKnowledgeTest {
    private static final String DIMENSION = "minecraft:overworld";
    private static final BlockPos TARGET = new BlockPos(8, 64, 0);

    @BeforeAll
    static void bootstrap() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void unknownMayBeApproachedWithoutBecomingKnownAir() {
        var snapshot = new BlockEvidenceStore().snapshot(DIMENSION, TARGET, 8);
        assertNull(PlacementContextResolver.refuseTarget(snapshot, TARGET));
        assertFalse(snapshot.isKnown(TARGET));
        assertThrows(IllegalArgumentException.class,
                () -> new PhysicalVerificationAuthority.BoundBlock(TARGET, snapshot.block(TARGET)));
    }

    @Test
    void onlyPublishedNonReplaceableBlocksRefusePlacement() {
        var store = new BlockEvidenceStore();
        store.publishFrame(DIMENSION, 1L, List.of(BlockObservation.of(
                TARGET, Blocks.STONE.defaultBlockState(), BlockEvidenceSource.MISMATCH)));
        var stone = store.snapshot(DIMENSION, TARGET, 8);
        assertEquals("target_occupied", PlacementContextResolver.refuseTarget(stone, TARGET).failureType());
        store.publishFrame(DIMENSION, 2L, List.of(BlockObservation.of(
                TARGET, Blocks.SHORT_GRASS.defaultBlockState(), BlockEvidenceSource.MISMATCH)));
        assertNull(PlacementContextResolver.refuseTarget(store.snapshot(DIMENSION, TARGET, 8), TARGET));
        assertEquals("target_occupied", PlacementContextResolver.refuseTarget(stone, TARGET).failureType());
        store.publishFrame(DIMENSION, 3L, List.of(BlockObservation.knownAir(TARGET, BlockEvidenceSource.VISION)));
        assertNull(PlacementContextResolver.refuseTarget(store.snapshot(DIMENSION, TARGET, 8), TARGET));
    }
}
