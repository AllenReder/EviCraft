package dev.mcagent.runtime.core.pathing.bridge;

import dev.mcagent.runtime.core.pathing.calc.NavGoal;
import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.goals.GoalBlock;
import dev.mcagent.runtime.core.pathing.goals.GoalComposite;
import dev.mcagent.runtime.core.pathing.goals.GoalGetToBlock;
import dev.mcagent.runtime.core.pathing.goals.GoalNear;
import dev.mcagent.runtime.core.pathing.goals.GoalRunAway;
import dev.mcagent.runtime.core.pathing.goals.GoalTwoBlocks;
import dev.mcagent.runtime.core.pathing.goals.GoalXZ;
import dev.mcagent.runtime.core.pathing.goals.GoalYLevel;

import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Per-factory goal-mapping assertions (pure logic, no MC bootstrap): each NavGoal factory product maps to
 * the agreed engine goal type, and on a sampled grid its membership and heuristic match the source goal
 * (except the two marked, deliberate relaxations).
 */
class GoalAdapterTest {

    private static final BlockPos T = new BlockPos(11, 64, -7);
    private static final double EPS = 1e-9;

    /** Asserts identical membership on the grid within ±4 of T. */
    private static void assertSameMembership(NavGoal source, Goal mapped) {
        for (int dx = -4; dx <= 4; dx++) {
            for (int dy = -4; dy <= 4; dy++) {
                for (int dz = -4; dz <= 4; dz++) {
                    BlockPos p = T.offset(dx, dy, dz);
                    assertEquals(source.isAt(p), mapped.isInGoal(p.getX(), p.getY(), p.getZ()),
                            "membership at " + p + " for " + mapped);
                }
            }
        }
    }

    /** Asserts the heuristic matches point by point on the grid within ±4 of T. */
    private static void assertSameHeuristic(NavGoal source, Goal mapped) {
        for (int dx = -4; dx <= 4; dx++) {
            for (int dy = -4; dy <= 4; dy++) {
                for (int dz = -4; dz <= 4; dz++) {
                    BlockPos p = T.offset(dx, dy, dz);
                    assertEquals(source.heuristic(p), mapped.heuristic(p.getX(), p.getY(), p.getZ()),
                            EPS, "heuristic at " + p + " for " + mapped);
                }
            }
        }
    }

    @Test
    void exactMapsToGoalBlock() {
        NavGoal source = NavGoal.exact(T);
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalBlock.class, mapped);
        assertSameMembership(source, mapped);
        assertSameHeuristic(source, mapped);
    }

    @Test
    void columnMapsToGoalXZ() {
        NavGoal source = NavGoal.column(T.getX(), T.getZ());
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalXZ.class, mapped);
        assertSameMembership(source, mapped);
        assertSameHeuristic(source, mapped);
        assertTrue(mapped.isInGoal(T.getX(), -1000, T.getZ()), "column admits any height");
    }

    @Test
    void yLevelMapsToGoalYLevel() {
        NavGoal source = NavGoal.yLevel(T.getY());
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalYLevel.class, mapped);
        assertSameMembership(source, mapped);
        assertSameHeuristic(source, mapped);
    }

    @Test
    void nearKeepsFractionalRadius() {
        NavGoal source = NavGoal.near(T, 2.5);
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalNear.class, mapped);
        assertSameMembership(source, mapped);
        assertSameHeuristic(source, mapped);
        // A fractional radius must not be rounded: (2,1,1) from the center (distance squared 6 ≤ 6.25) is
        // inside, (2,2,1) (distance squared 9 > 6.25) is outside
        assertTrue(mapped.isInGoal(T.getX() + 2, T.getY() + 1, T.getZ() + 1));
        assertFalse(mapped.isInGoal(T.getX() + 2, T.getY() + 2, T.getZ() + 1));
    }

    @Test
    void nearGroundKeepsGroundBand() {
        NavGoal source = NavGoal.nearGround(T, 3.0);
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalNear.class, mapped);
        assertSameMembership(source, mapped);
        assertSameHeuristic(source, mapped);
        // Pillaring check: a cell within the radius but two blocks higher does not count as arrived
        assertFalse(mapped.isInGoal(T.getX() + 1, T.getY() + 2, T.getZ()));
        assertTrue(mapped.isInGoal(T.getX() + 1, T.getY() + 1, T.getZ()));
    }

    @Test
    void getToBlockKeepsMembership() {
        NavGoal source = NavGoal.getToBlock(T);
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalGetToBlock.class, mapped);
        // Membership matches cell by cell (same height-corrected Manhattan formula). The heuristic shape
        // differs on purpose: the NavGoal version subtracts a "one step + one jump" slack, while the engine
        // scores the corrected y difference. Both aim at the same target, so values are not asserted equal
        assertSameMembership(source, mapped);
        assertEquals(0.0, mapped.heuristic(T.getX(), T.getY(), T.getZ()), EPS,
                "heuristic at the target cell itself is zero (the engine aims at the block itself; adjacent members keep one step of slack)");
    }

    @Test
    void adjacentMapsToGetToBlockStance() {
        NavGoal source = NavGoal.adjacent(T);
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalGetToBlock.class, mapped);
        // Agreed membership change: the four orthogonal same-level neighbors (core stances) stay; the target
        // cell itself and the two cells directly below are added; the y+1 neighbors are no longer members
        for (BlockPos p : List.of(T.north(), T.south(), T.east(), T.west())) {
            assertTrue(source.isAt(p) && mapped.isInGoal(p.getX(), p.getY(), p.getZ()),
                    "same-level orthogonal neighbor kept " + p);
        }
        assertTrue(mapped.isInGoal(T.getX(), T.getY(), T.getZ()), "the target cell itself can be a path end");
        assertFalse(mapped.isInGoal(T.getX() + 2, T.getY(), T.getZ()), "two cells away does not count");
    }

    @Test
    void compositeMapsMembersRecursively() {
        NavGoal source = NavGoal.composite(List.of(
                NavGoal.exact(T), NavGoal.near(T.offset(6, 0, 2), 2.0)));
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalComposite.class, mapped);
        Goal[] members = ((GoalComposite) mapped).goals();
        assertEquals(2, members.length);
        assertInstanceOf(GoalBlock.class, members[0]);
        assertInstanceOf(GoalNear.class, members[1]);
        assertSameMembership(source, mapped);
        assertSameHeuristic(source, mapped);
    }

    @Test
    void mineColumnFamilyKeepsStanceBand() {
        // maxBelow=0 → one cell; =1 → two cells; =2 → two cells + filler; membership matches cell by cell
        NavGoal band0 = NavGoal.mineColumn(T, 0);
        Goal mapped0 = GoalAdapter.toEngineGoal(band0);
        assertInstanceOf(GoalBlock.class, mapped0);
        assertSameMembership(band0, mapped0);

        NavGoal band1 = NavGoal.mineColumn(T, 1);
        Goal mapped1 = GoalAdapter.toEngineGoal(band1);
        assertInstanceOf(GoalTwoBlocks.class, mapped1);
        assertSameMembership(band1, mapped1);

        NavGoal band2 = NavGoal.mineColumn(T, 2);
        Goal mapped2 = GoalAdapter.toEngineGoal(band2);
        assertInstanceOf(GoalComposite.class, mapped2);
        assertSameMembership(band2, mapped2);
        assertSameHeuristic(band2, mapped2);
    }

    @Test
    void runAwayMapsToGoalRunAway() {
        NavGoal source = NavGoal.runAway(T, T.getY());
        Goal mapped = GoalAdapter.toEngineGoal(source);
        assertInstanceOf(GoalRunAway.class, mapped);
        assertSameHeuristic(source, mapped);
        // NavGoal runAway never arrives; the engine goal likewise does not arrive at ordinary distances
        assertFalse(mapped.isInGoal(T.getX() + 500, T.getY(), T.getZ() + 500));
        assertFalse(mapped.isInGoal(T.getX(), T.getY(), T.getZ()));
    }

    @Test
    void anonymousNavGoalFallsBackToWrapper() {
        BlockPos c = T.above(3);
        NavGoal custom = new NavGoal() {
            @Override public boolean isAt(BlockPos feet) {
                return feet.getY() == c.getY() && feet.getX() % 2 == 0;
            }
            @Override public double heuristic(BlockPos from) {
                return Math.abs(from.getY() - c.getY()) * 7.0;
            }
            @Override public BlockPos center() {
                return c;
            }
        };
        Goal mapped = GoalAdapter.toEngineGoal(custom);
        assertSameMembership(custom, mapped);
        assertSameHeuristic(custom, mapped);
    }

    @Test
    void compiledContractCarriesMappedEngineGoal() {
        // The compiled contract's engineGoal matches the vocabulary mapping; sacred/arrival pass through as-is
        GoalCompiler.Compiled interact = GoalCompiler.interact(T);
        assertInstanceOf(GoalGetToBlock.class, interact.engineGoal());
        assertTrue(interact.sacred().contains(T.asLong()));

        GoalCompiler.Compiled standOn = GoalCompiler.block(true, T);
        assertInstanceOf(GoalBlock.class, standOn.engineGoal());
        assertTrue(standOn.sacred().isEmpty());

        GoalCompiler.Compiled occupied = GoalCompiler.block(false, T);
        assertInstanceOf(GoalGetToBlock.class, occupied.engineGoal());

        GoalCompiler.Compiled adjacent = GoalCompiler.standAdjacent(T);
        assertInstanceOf(GoalGetToBlock.class, adjacent.engineGoal());

        GoalCompiler.Compiled near = GoalCompiler.near(T, 4.0);
        assertInstanceOf(GoalNear.class, near.engineGoal());

        GoalCompiler.Compiled mine = GoalCompiler.mineField(
                List.of(T), List.of(T.offset(2, 0, 2)));
        assertInstanceOf(GoalComposite.class, mine.engineGoal());
        // Mining goals have no sacred set: the stance often lies inside the target column, and forbidding
        // breaking it en route would make the stance unreachable
        assertTrue(mine.sacred().isEmpty());
        // Membership matches the NavGoal (ore-column band + item-drop neighborhood)
        assertSameMembership(mine.goal(), mine.engineGoal());
    }
}
