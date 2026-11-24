package dev.mcagent.runtime.core.task.interact;

import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.shapes.Shapes;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class InteractionPoseCandidatesTest {

    @Test
    void freezesStandableFeetCellsAcrossVerticalOffsetsWithinNativeReach() {
        BlockPos target = new BlockPos(0, 64, 0);
        Set<BlockPos> standable = Set.of(
                new BlockPos(2, 64, 0),
                new BlockPos(1, 65, 0),
                new BlockPos(0, 61, 0),
                new BlockPos(5, 64, 0));

        List<BlockPos> candidates = InteractionPoseCandidates.freeze(
                target, new BlockPos(4, 64, 0), 4.5, 1.62,
                Shapes.block(), standable::contains);

        assertTrue(candidates.contains(new BlockPos(2, 64, 0)));
        assertTrue(candidates.contains(new BlockPos(1, 65, 0)),
                "candidate generation must not be limited to same-height neighbours");
        assertTrue(candidates.contains(new BlockPos(0, 61, 0)),
                "lower standable poses within the eye-to-outline reach sphere remain eligible");
        assertFalse(candidates.contains(new BlockPos(5, 64, 0)),
                "an eye outside vanilla interaction reach is excluded");
        assertTrue(candidates.size() < 512, "the frozen search must stay finite and bounded");
    }

    @Test
    void ordersByNavigationEstimateThenStableCoordinates() {
        BlockPos target = new BlockPos(0, 64, 0);
        BlockPos west = new BlockPos(-2, 64, 0);
        BlockPos east = new BlockPos(2, 64, 0);

        List<BlockPos> candidates = InteractionPoseCandidates.freeze(
                target, new BlockPos(0, 64, 2), 4.5, 1.62,
                Shapes.block(), Set.of(east, west)::contains);

        assertEquals(List.of(west, east), candidates,
                "equal navigation estimates use x/y/z coordinate tie-breaking");
    }
}
