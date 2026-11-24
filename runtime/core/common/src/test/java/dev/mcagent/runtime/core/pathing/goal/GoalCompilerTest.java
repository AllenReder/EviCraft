package dev.mcagent.runtime.core.pathing.goal;

import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Headless mapping pins for {@link GoalCompiler}: each intent factory must
 * produce the right goal SHAPE and the right sacred set — together, from one
 * place. Uses the pure {@link GoalCompiler#block(boolean, BlockPos)} core
 * (no {@code Level}).
 */
class GoalCompilerTest {

    private static final BlockPos T = new BlockPos(7, 70, -12);

    @Test
    void walkableCellCompilesToStandOn() {
        GoalCompiler.Compiled c = GoalCompiler.block(true, T);
        assertTrue(c.goal().isAt(T), "exact membership at the cell");
        assertFalse(c.goal().isAt(T.north()), "no neighbour satisfies standOn");
        assertTrue(c.sacred().isEmpty(), "a place to stand is not a block to protect");
    }

    @Test
    void solidCellCompilesToInteract() {
        GoalCompiler.Compiled c = GoalCompiler.block(false, T);
        assertTrue(c.goal().isAt(T.north()), "touching cells satisfy");
        assertFalse(c.goal().isAt(T.above(2)), "no elevated cell satisfies — the pillaring pin");
        assertTrue(c.sacred().contains(T.asLong()), "the target itself is sacred");
        assertEquals(1, c.sacred().size());
    }

    @Test
    void unknownExactCoordinateRemainsSpeculativeInsteadOfRevealingLiveOccupancy() {
        GoalCompiler.Compiled unknown = GoalCompiler.blockKnowledge(false, false, T);
        GoalCompiler.Compiled knownAir = GoalCompiler.blockKnowledge(true, true, T);

        assertTrue(unknown.goal().isAt(T));
        assertTrue(knownAir.goal().isAt(T));
        assertFalse(unknown.goal().isAt(T.north()));
        assertTrue(unknown.sacred().isEmpty());
    }

    @Test
    void publishedPassableBlockPreservesTheExistingStandOnCandidateRule() {
        GoalCompiler.Compiled compiled = GoalCompiler.blockKnowledge(true, true, T);

        assertTrue(compiled.goal().isAt(T));
        assertTrue(compiled.sacred().isEmpty());
    }

    @Test
    void interactAndStandAdjacentProtectTheirTarget() {
        assertTrue(GoalCompiler.interact(T).sacred().contains(T.asLong()));
        GoalCompiler.Compiled adj = GoalCompiler.standAdjacent(T);
        assertTrue(adj.sacred().contains(T.asLong()),
                "the placement cell may not be scaffolded into");
        assertTrue(adj.goal().isAt(T.north()));
        assertFalse(adj.goal().isAt(T), "adjacent never ends IN the target cell");
    }

    @Test
    void interactionPoseSetProtectsTheExactTargetAcrossEveryCandidate() {
        BlockPos first = T.north(2);
        BlockPos second = T.above().east();
        BlockPos occluder = T.west();
        GoalCompiler.Compiled compiled = GoalCompiler.interactionPoses(
                List.of(first, second), List.of(T, occluder));

        assertTrue(compiled.goal().isAt(first));
        assertTrue(compiled.goal().isAt(second));
        assertTrue(compiled.goal().ordersEqualCostGoals());
        assertTrue(compiled.goal().compareEqualCostGoals(first, second) < 0,
                "equal path costs use stable x/y/z coordinate ordering");
        assertTrue(compiled.engineGoal().ordersEqualCostGoals());
        assertTrue(compiled.engineGoal().compareEqualCostGoals(first, second) < 0,
                "the pathfinder adapter must preserve equal-cost ordering");
        assertFalse(compiled.goal().isAt(T.north()),
                "only frozen exact Feet Cells satisfy the pose goal");
        assertEquals(2, compiled.sacred().size());
        assertTrue(compiled.sacred().contains(T.asLong()),
                "route BREAK and PLACE must remain forbidden at the exact target");
        assertTrue(compiled.sacred().contains(occluder.asLong()),
                "a proven raycast occluder cannot later be destroyed merely for line of sight");
    }

    @Test
    void nearUsesTheGroundBandNotTheSphere() {
        GoalCompiler.Compiled c = GoalCompiler.near(T, 3.0);
        assertTrue(c.goal().isAt(T.north(2)));
        assertFalse(c.goal().isAt(T.above(2)),
                "vicinity intent must not admit the pillar-top cell");
        assertTrue(c.sacred().isEmpty());
    }

    @Test
    void mineFieldKeepsNothingSacredSoEveryStanceStaysReachable() {
        BlockPos ore2 = T.east(4);
        BlockPos drop = T.north(2);
        GoalCompiler.Compiled c = GoalCompiler.mineField(List.of(T, ore2), List.of(drop));
        assertTrue(c.sacred().isEmpty(),
                "no target cell may be sacred — a stance inside the target's own column"
                        + " would become unsatisfiable");
        assertTrue(c.goal().isAt(T.north()), "standing next to it counts as arrived");
        assertTrue(c.goal().isAt(T.below()), "standing below it counts as arrived");
        assertTrue(c.goal().isAt(drop), "drop vicinity member satisfies");
    }

    @Test
    void mineFieldOnlyAdmitsCellsWhoseBodyTouchesTheOre() {
        GoalCompiler.Compiled c = GoalCompiler.mineField(List.of(T), List.of());
        assertTrue(c.goal().isAt(T.below(2)), "feet two cells below: ore touches the head");
        assertFalse(c.goal().isAt(T.below(3)), "one cell lower is out of reach");
        assertFalse(c.goal().isAt(T.north(2)), "one cell gap does not count as touching");
        // Standing on top of the block is not a stance: that cell is the Bot's own floor, which the mining
        // layer never touches. Admitting it causes an endless loop of "navigation says arrived, mining says
        // this cell cannot be mined".
        assertFalse(c.goal().isAt(T.above()), "standing on top does not count -- the cell underfoot is its own floor");
    }
}
