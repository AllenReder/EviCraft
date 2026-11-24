package dev.mcagent.runtime.knowledge.loaded;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VirtualClientChunkTrackerTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @BeforeAll
    static void bootMinecraftRegistries() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void pendingAndViewExitRemoveCoverageBeforeServerResidencyChanges() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        ChunkPos position = new ChunkPos(0, 0);
        BlockPos block = new BlockPos(1, 64, 1);
        tracker.loadFixtureColumn(OVERWORLD, position, 0, 16,
                Map.of(block, Blocks.STONE.defaultBlockState()));

        tracker.pending(position);
        assertNull(tracker.snapshot().column(position),
                "pending client delivery must be UNKNOWN even if the server chunk is resident");

        tracker.loadFixtureColumn(OVERWORLD, position, 0, 16,
                Map.of(block, Blocks.STONE.defaultBlockState()));
        tracker.unload(position);
        assertNull(tracker.snapshot().column(position),
                "logical view exit must evict without waiting for server chunk unload");
    }

    @Test
    void blockUpdatesReplaceOnlyTheAffectedImmutablePages() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        ChunkPos position = new ChunkPos(0, 0);
        BlockPos lower = new BlockPos(1, 64, 1);
        BlockPos upper = new BlockPos(1, 80, 1);
        tracker.loadFixtureColumn(OVERWORLD, position, 0, 16, Map.of(
                lower, Blocks.STONE.defaultBlockState(),
                upper, Blocks.OAK_LOG.defaultBlockState()));
        VirtualClientChunkTracker.Snapshot before = tracker.snapshot();

        tracker.update(OVERWORLD, lower, Blocks.DIRT.defaultBlockState());
        VirtualClientChunkTracker.Snapshot after = tracker.snapshot();

        assertNotSame(before.column(position), after.column(position));
        assertNotSame(before.column(position).sectionPage(lower.getY() >> 4),
                after.column(position).sectionPage(lower.getY() >> 4));
        assertSame(before.column(position).sectionPage(upper.getY() >> 4),
                after.column(position).sectionPage(upper.getY() >> 4));
        assertSame(after.column(position), tracker.snapshot().column(position),
                "capturing a snapshot must structurally reuse unchanged pages");
    }

    @Test
    void blockUpdatesKeepSectionBlockSetsExactAndSnapshotsImmutable() {
        VirtualClientChunkTracker tracker = new VirtualClientChunkTracker();
        ChunkPos chunk = new ChunkPos(0, 0);
        BlockPos firstStone = new BlockPos(1, 64, 1);
        BlockPos secondStone = firstStone.east();
        tracker.loadFixtureColumn(OVERWORLD, chunk, 4, 1, Map.of(
                firstStone, Blocks.STONE.defaultBlockState(),
                secondStone, Blocks.STONE.defaultBlockState()));
        VirtualClientChunkTracker.SectionPage original =
                tracker.snapshot().column(chunk).sectionPage(4);

        tracker.update(OVERWORLD, firstStone, Blocks.DIRT.defaultBlockState());
        VirtualClientChunkTracker.SectionPage oneStone =
                tracker.snapshot().column(chunk).sectionPage(4);
        tracker.update(OVERWORLD, secondStone, Blocks.DIRT.defaultBlockState());
        VirtualClientChunkTracker.SectionPage noStone =
                tracker.snapshot().column(chunk).sectionPage(4);

        assertTrue(List.of(original.blocks()).contains(Blocks.STONE));
        assertFalse(List.of(original.blocks()).contains(Blocks.DIRT));
        assertTrue(List.of(oneStone.blocks()).contains(Blocks.STONE));
        assertTrue(List.of(oneStone.blocks()).contains(Blocks.DIRT));
        assertFalse(List.of(noStone.blocks()).contains(Blocks.STONE));
        assertTrue(List.of(noStone.blocks()).contains(Blocks.DIRT));
    }
}
