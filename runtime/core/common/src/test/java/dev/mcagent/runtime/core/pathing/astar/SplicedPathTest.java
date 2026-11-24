package dev.mcagent.runtime.core.pathing.astar;

import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.Test;

import dev.mcagent.runtime.core.pathing.moves.Movement;

import net.minecraft.core.BlockPos;

import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.FakePath;
import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.NEVER_GOAL;
import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.TestMovement;
import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.line;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** SplicedPath splicing and rejection criteria. */
class SplicedPathTest {

    @Test
    void spliceOnMatchingSeam() {
        // first: x 0..9, second: x 9..14, seam at (9,64,0)
        NavPath first = line(0, 10, NEVER_GOAL);
        NavPath second = line(9, 6, NEVER_GOAL);
        Optional<SplicedPath> spliced = SplicedPath.trySplice(first, second, false);
        assertTrue(spliced.isPresent());
        SplicedPath path = spliced.get();
        assertEquals(15, path.length());
        assertEquals(14, path.movements().size());
        assertEquals(new BlockPos(0, 64, 0), path.getSrc());
        assertEquals(new BlockPos(14, 64, 0), path.getDest());
    }

    @Test
    void rejectWhenSeamDoesNotMatch() {
        NavPath first = line(0, 10, NEVER_GOAL);
        NavPath second = line(20, 6, NEVER_GOAL);
        assertTrue(SplicedPath.trySplice(first, second, false).isEmpty());
    }

    @Test
    void rejectNulls() {
        NavPath first = line(0, 10, NEVER_GOAL);
        assertTrue(SplicedPath.trySplice(first, null, false).isEmpty());
        assertTrue(SplicedPath.trySplice(null, first, false).isEmpty());
    }

    @Test
    void rejectOverlapWhenNotAllowed() {
        // second starts at first's end but doubles back through first's middle → overlap, rejected
        NavPath first = line(0, 10, NEVER_GOAL); // 0..9
        List<BlockPos> positions = List.of(
                new BlockPos(9, 64, 0),
                new BlockPos(8, 64, 0),
                new BlockPos(7, 64, 0));
        List<Movement> movements = List.of(
                new TestMovement(positions.get(0), positions.get(1), 1),
                new TestMovement(positions.get(1), positions.get(2), 1));
        NavPath second = new FakePath(positions, movements, NEVER_GOAL);
        assertTrue(SplicedPath.trySplice(first, second, false).isEmpty());
    }

    @Test
    void overlapCutoffWhenAllowed() {
        // Overlap truncation allowed: first yields to second at the first shared cell
        NavPath first = line(0, 10, NEVER_GOAL); // 0..9
        List<BlockPos> positions = List.of(
                new BlockPos(9, 64, 0),
                new BlockPos(8, 64, 0),
                new BlockPos(8, 65, 0));
        List<Movement> movements = List.of(
                new TestMovement(positions.get(0), positions.get(1), 1),
                new TestMovement(positions.get(1), positions.get(2), 1));
        NavPath second = new FakePath(positions, movements, NEVER_GOAL);
        Optional<SplicedPath> spliced = SplicedPath.trySplice(first, second, true);
        assertTrue(spliced.isPresent());
        // first is cut at (8,64,0) (index 8); second continues from it with (8,65,0)
        assertEquals(new BlockPos(0, 64, 0), spliced.get().getSrc());
        assertEquals(new BlockPos(8, 65, 0), spliced.get().getDest());
        assertEquals(10, spliced.get().length());
    }

    @Test
    void numNodesAccumulates() {
        NavPath first = line(0, 10, NEVER_GOAL);
        NavPath second = line(9, 6, NEVER_GOAL);
        SplicedPath path = SplicedPath.trySplice(first, second, false).orElseThrow();
        assertEquals(0, path.getNumNodesConsidered());
    }
}
