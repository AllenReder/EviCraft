package dev.mcagent.runtime.core.pathing.astar;

import org.junit.jupiter.api.Test;

import dev.mcagent.runtime.core.pathing.moves.ChunkLoadedTest;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;

import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.ALWAYS_GOAL;
import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.NEVER_GOAL;
import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.line;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** staticCutoff boundaries and the cutoffAtLoadedChunks switch. */
class StaticCutoffTest {

    @Test
    void shorterThanMinimumIsUntouched() {
        NavPath path = line(0, 29, NEVER_GOAL);
        assertSame(path, path.staticCutoff(NEVER_GOAL));
    }

    @Test
    void exactlyMinimumLosesNothing() {
        // length=30: newLength=(30-30)*0.9+30-1=29; cutting at index 29 still keeps all 30 cells
        NavPath path = line(0, 30, NEVER_GOAL);
        NavPath cut = path.staticCutoff(NEVER_GOAL);
        assertEquals(30, cut.length());
    }

    @Test
    void thirtyOneLosesOne() {
        // length=31: newLength=(1)*0.9+29=29 → keeps 30 cells
        NavPath path = line(0, 31, NEVER_GOAL);
        NavPath cut = path.staticCutoff(NEVER_GOAL);
        assertEquals(30, cut.length());
        assertEquals(new BlockPos(29, 64, 0), cut.getDest());
    }

    @Test
    void longPathLosesTenPercentOfExcess() {
        // length=50: newLength=(20)*0.9+29=47 → keeps 48 cells
        NavPath path = line(0, 50, NEVER_GOAL);
        NavPath cut = path.staticCutoff(NEVER_GOAL);
        assertEquals(48, cut.length());
        assertEquals(new BlockPos(0, 64, 0), cut.getSrc());
        assertEquals(new BlockPos(47, 64, 0), cut.getDest());
        assertEquals(47, cut.movements().size());
    }

    @Test
    void destInGoalIsNeverCut() {
        NavPath path = line(0, 100, ALWAYS_GOAL);
        assertSame(path, path.staticCutoff(ALWAYS_GOAL));
    }

    @Test
    void nullGoalIsNeverCut() {
        NavPath path = line(0, 100, NEVER_GOAL);
        assertSame(path, path.staticCutoff(null));
    }

    @Test
    void loadBoundaryCutoffDisabledByDefault() {
        NavPath path = line(0, 50, NEVER_GOAL);
        // Switch is off by default: no cut even if the predicate reports everything unloaded
        assertSame(path, path.cutoffAtLoadedChunks((x, z) -> false));
    }

    @Test
    void loadBoundaryCutoffWhenEnabled() {
        NavSettings settings = NavSettings.get();
        boolean saved = settings.cutoffAtLoadBoundary;
        settings.cutoffAtLoadBoundary = true;
        try {
            NavPath path = line(0, 50, NEVER_GOAL);
            // Unloaded from x≥20: cut at the first unloaded cell (index 20, inclusive)
            ChunkLoadedTest test = (x, z) -> x < 20;
            NavPath cut = path.cutoffAtLoadedChunks(test);
            assertEquals(21, cut.length());
            assertEquals(new BlockPos(20, 64, 0), cut.getDest());
        } finally {
            settings.cutoffAtLoadBoundary = saved;
        }
    }

    @Test
    void cutoffPathKeepsMovementAlignment() {
        NavPath path = line(0, 40, NEVER_GOAL);
        CutoffPath cut = new CutoffPath(path, 5, 15);
        assertEquals(11, cut.length());
        assertEquals(10, cut.movements().size());
        assertEquals(new BlockPos(5, 64, 0), cut.getSrc());
        assertEquals(new BlockPos(15, 64, 0), cut.getDest());
        // sanityCheck already ran in the constructor; check the start/end join explicitly once more
        cut.sanityCheck();
        assertTrue(cut.movements().get(0).getSrc().equals(cut.positions().get(0)));
    }
}
