package dev.mcagent.runtime.core.pathing.astar;

import org.junit.jupiter.api.Test;

import net.minecraft.core.BlockPos;

import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.NEVER_GOAL;
import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.line;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Favoring table: discount along the previous path, default value, and the empty-table check. */
class FavoringTableTest {

    @Test
    void emptyTableReturnsOne() {
        Favoring favoring = Favoring.empty();
        assertTrue(favoring.isEmpty());
        assertEquals(1.0, favoring.calculate(PathNode.longHash(1, 2, 3)));
    }

    @Test
    void previousPathPositionsGetCoefficient() {
        NavPath previous = line(0, 10, NEVER_GOAL);
        Favoring favoring = new Favoring(previous, 0.5);
        assertFalse(favoring.isEmpty());
        for (BlockPos pos : previous.positions()) {
            assertEquals(0.5, favoring.calculate(
                    PathNode.longHash(pos.getX(), pos.getY(), pos.getZ())));
        }
    }

    @Test
    void offPathPositionsKeepDefault() {
        NavPath previous = line(0, 10, NEVER_GOAL);
        Favoring favoring = new Favoring(previous, 0.5);
        assertEquals(1.0, favoring.calculate(PathNode.longHash(100, 64, 100)));
    }

    @Test
    void coefficientOneBuildsEmptyTable() {
        NavPath previous = line(0, 10, NEVER_GOAL);
        Favoring favoring = new Favoring(previous, 1.0);
        assertTrue(favoring.isEmpty());
    }

    @Test
    void nullPreviousBuildsEmptyTable() {
        Favoring favoring = new Favoring(null, 0.5);
        assertTrue(favoring.isEmpty());
    }
}
