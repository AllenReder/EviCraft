package dev.mcagent.runtime.core.pathing.execute;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

import dev.mcagent.runtime.core.pathing.astar.NavPath;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementFall;

import net.minecraft.core.BlockPos;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Executor logic that can be verified offline: the backward/forward scan windows used for relocation
 * and the early-snap conditions. Driven by fake movements (a straight traverse chain) and fake feet
 * positions, without bootstrapping MC.
 *
 * <p>The full onTick flow needs a live entity and world (line of sight, feet position, block states)
 * and cannot be tested offline; it is covered in-game.
 */
class PathExecutorLogicTest {

    /** Fake movement with only src/dest and valid positions; configurable cost (default 1). */
    private static class FakeMovement extends Movement {

        private final double cost;

        FakeMovement(BlockPos src, BlockPos dest) {
            this(src, dest, 1.0);
        }

        FakeMovement(BlockPos src, BlockPos dest, double cost) {
            super(null, src, dest, new BlockPos[0], null);
            this.cost = cost;
        }

        @Override
        public double calculateCost(CalculationContext context, MutableMoveResult result) {
            return cost;
        }

        @Override
        protected Set<BlockPos> calculateValidPositions() {
            return Set.of(src, dest);
        }
    }

    /** Straight traverse chain along +X: (0,64,0) → (n,64,0), n movements. */
    private static List<Movement> straightLine(int n) {
        List<Movement> movements = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            movements.add(new FakeMovement(new BlockPos(i, 64, 0), new BlockPos(i + 1, 64, 0)));
        }
        return movements;
    }

    private static BlockPos at(int x) {
        return new BlockPos(x, 64, 0);
    }

    // ==================== Backward scan ====================

    /** Feet inside an already-executed movement → return to that step (earliest match). */
    @Test
    void backwardMatchFindsEarliestContaining() {
        List<Movement> movements = straightLine(10);
        // At step 6, knocked back to x=3: movement[2] (2→3) and movement[3] (3→4) both contain x=3;
        // the earliest, 2, wins
        assertEquals(2, PathExecutor.findBackwardMatch(movements, 6, at(3)));
    }

    /** Feet not in any already-executed movement → -1. */
    @Test
    void backwardMatchMissesWhenOffPath() {
        List<Movement> movements = straightLine(10);
        assertEquals(-1, PathExecutor.findBackwardMatch(movements, 6, new BlockPos(3, 65, 5)));
    }

    /**
     * The backward scan only checks [0, pathPosition): the current step's own valid positions do not
     * count.
     */
    @Test
    void backwardMatchExcludesCurrent() {
        List<Movement> movements = straightLine(10);
        // x=7 appears only in movement[6] (6→7, current step) and movement[7], outside the backward window
        assertEquals(-1, PathExecutor.findBackwardMatch(movements, 6, at(7)));
    }

    // ==================== Forward scan ====================

    /** The forward window starts at +3: valid positions of +1/+2 are deliberately ignored. */
    @Test
    void forwardSkipStartsAtPlusThree() {
        List<Movement> movements = straightLine(12);
        // At step 2 with feet x=4: movement[3] (3→4) contains it, but 3 = pathPosition+1 is outside the
        // window
        assertEquals(-1, PathExecutor.findForwardSkip(movements, 2, at(4)));
        // Feet x=6: movement[5] (5→6) is pathPosition+3, inside the window; returns 5
        assertEquals(5, PathExecutor.findForwardSkip(movements, 2, at(6)));
    }

    /** The forward scan reaches the last movement of the path. */
    @Test
    void forwardSkipReachesTail() {
        List<Movement> movements = straightLine(12);
        assertEquals(11, PathExecutor.findForwardSkip(movements, 2, at(12)));
    }

    /** Feet not in any later movement → -1. */
    @Test
    void forwardSkipMissesWhenOffPath() {
        List<Movement> movements = straightLine(12);
        assertEquals(-1, PathExecutor.findForwardSkip(movements, 2, new BlockPos(6, 70, 0)));
    }

    // ==================== Early snap (snipsnap) conditions ====================

    private static List<BlockPos> positions(int n) {
        List<BlockPos> list = new ArrayList<>();
        for (int i = 0; i <= n; i++) {
            list.add(at(i));
        }
        return list;
    }

    /** On the ground and exactly on a path position → return that index. */
    @Test
    void snipsnapSnapsWhenOnGroundAndOnPath() {
        assertEquals(4, PathExecutor.snipsnapIndex(positions(8), at(4), true, false, 0.0));
    }

    /** Airborne and not in liquid → no snap (momentum is uncontrollable). */
    @Test
    void snipsnapRefusesMidair() {
        assertEquals(-1, PathExecutor.snipsnapIndex(positions(8), at(4), false, false, 0.0));
    }

    /** Snapping is allowed in liquid (treated as on the ground). */
    @Test
    void snipsnapAllowsLiquid() {
        assertEquals(4, PathExecutor.snipsnapIndex(positions(8), at(4), false, true, 0.0));
    }

    /** Strictly sinking (vertical velocity < -0.1) → no snap (possibly falling through water). */
    @Test
    void snipsnapRefusesSinking() {
        assertEquals(-1, PathExecutor.snipsnapIndex(positions(8), at(4), false, true, -0.2));
        assertEquals(-1, PathExecutor.snipsnapIndex(positions(8), at(4), true, false, -0.2));
    }

    /** Feet not on any path position → -1. */
    @Test
    void snipsnapMissesWhenOffPath() {
        assertEquals(-1, PathExecutor.snipsnapIndex(positions(8), new BlockPos(3, 65, 2), true, false, 0.0));
    }

    // ==================== Off-path detection (pure logic) ====================

    /** Builds a straight NavPath: n traverses along +X, positions from (0,64,0) to (n,64,0). */
    private static NavPath straightPath(int n) {
        List<Movement> movements = straightLine(n);
        List<BlockPos> pos = new ArrayList<>();
        for (int i = 0; i <= n; i++) {
            pos.add(at(i));
        }
        return new NavPath() {
            @Override public List<Movement> movements() { return movements; }
            @Override public List<BlockPos> positions() { return pos; }
            @Override public dev.mcagent.runtime.core.pathing.goals.Goal getGoal() {
                throw new UnsupportedOperationException();
            }
            @Override public int getNumNodesConsidered() { return 0; }
        };
    }

    /**
     * Player at the horizontal projection of a position's center → minimum distance is the center's y
     * offset (the center is at y+0.5 within the block).
     */
    @Test
    void closestPathPosIsZeroAtCenter() {
        // Player at the horizontal center of (0,64,0), i.e. (0.5,64.0,0.5); center (0.5,64.5,0.5), 3D
        // distance 0.5
        assertEquals(0.5, PathExecutor.closestPathPosDist(
                straightLine(3), 0.5, 64.0, 0.5), 1e-6);
    }

    /** Player 3 blocks horizontally off the path → minimum distance > 2, off path. */
    @Test
    void offPathWhenFarFromAllValidPositions() {
        // Path runs along +X at y=64, player at z=3 (3 off horizontally): nearest center is > 2 away
        double dist = PathExecutor.closestPathPosDist(straightLine(3), 0.5, 64.0, 3.5);
        assertTrue(dist > 2, "3 blocks horizontal offset should be off path, got " + dist);
        NavPath path = straightPath(3);
        assertTrue(PathExecutor.possiblyOffPath(path, 0, dist, 2,
                0.5, 3.5, p -> PathExecutor.flatDistanceToCenter(p, 0.5, 3.5)));
    }

    /** Player on the path but slightly off a center (≤ 2) → not off path. */
    @Test
    void onPathWhenWithinLeniency() {
        double dist = PathExecutor.closestPathPosDist(straightLine(3), 0.7, 64.0, 0.5);
        assertTrue(dist <= 2, "close to the path should not be off path, got " + dist);
        NavPath path = straightPath(3);
        assertFalse(PathExecutor.possiblyOffPath(path, 0, dist, 2,
                0.7, 0.5, p -> PathExecutor.flatDistanceToCenter(p, 0.7, 0.5)));
    }

    /** During a fall only horizontal distance is used: vertical distance does not count as off path. */
    @Test
    void fallUsesFlatDistanceOnly() {
        // Build a path with one Fall: src (0,66,0) -> dest (0,64,0)
        List<Movement> movements = new ArrayList<>();
        movements.add(new MovementFall(null, new BlockPos(0, 66, 0), new BlockPos(0, 64, 0)));
        List<BlockPos> pos = List.of(new BlockPos(0, 66, 0), new BlockPos(0, 64, 0));
        NavPath path = new NavPath() {
            @Override public List<Movement> movements() { return movements; }
            @Override public List<BlockPos> positions() { return pos; }
            @Override public dev.mcagent.runtime.core.pathing.goals.Goal getGoal() { throw new UnsupportedOperationException(); }
            @Override public int getNumNodesConsidered() { return 0; }
        };
        // Player at y=65 mid-fall, horizontally above the landing → horizontal distance 0, not off path
        double flatDist = PathExecutor.flatDistanceToCenter(new BlockPos(0, 64, 0), 0.5, 0.5);
        assertEquals(0.0, flatDist, 1e-6);
        assertFalse(PathExecutor.possiblyOffPath(path, 0, 99.0, 2,
                0.5, 0.5, p -> PathExecutor.flatDistanceToCenter(p, 0.5, 0.5)));
        // Horizontally off by ≥ 2 → off path
        assertTrue(PathExecutor.possiblyOffPath(path, 0, 99.0, 2,
                3.5, 0.5, p -> PathExecutor.flatDistanceToCenter(p, 3.5, 0.5)));
    }

    // ==================== Cost increase / timeout (pure logic) ====================

    /** Cost increase ≤ tolerance → no abort. */
    @Test
    void costIncreaseWithinToleranceDoesNotTrigger() {
        assertFalse(PathExecutor.costIncreaseExceedsTolerance(10.0, 15.0, 10.0));
        assertFalse(PathExecutor.costIncreaseExceedsTolerance(10.0, 20.0, 10.0)); // exactly equal
    }

    /** Cost increase > tolerance → abort. */
    @Test
    void costIncreaseBeyondToleranceTriggers() {
        assertTrue(PathExecutor.costIncreaseExceedsTolerance(10.0, 20.01, 10.0));
    }

    /** Per-movement timeout threshold = estimate + grace. */
    @Test
    void timeoutIsCostPlusGrace() {
        assertEquals(110.0, PathExecutor.timedOutAt(10.0, 100));
        assertEquals(100.0, PathExecutor.timedOutAt(0.0, 100));
    }

    // ==================== Lookahead cost verification (pure logic; FakeMovement ignores context) ====

    /** Everything in the lookahead window is feasible → -1. */
    @Test
    void futureImpossibleReturnsMinusOneWhenAllFine() {
        List<Movement> movements = straightLine(6); // each step costs 1, all feasible
        assertEquals(-1, PathExecutor.firstFutureImpossible(movements, 0, 5, null));
    }

    /** First movement with INF cost in the lookahead window → its index. */
    @Test
    void futureImpossibleFindsFirstInf() {
        List<Movement> movements = new ArrayList<>();
        movements.add(new FakeMovement(at(0), at(1), 1.0));
        movements.add(new FakeMovement(at(1), at(2), 1.0));
        movements.add(new FakeMovement(at(2), at(3), COST_INF)); // index 2
        movements.add(new FakeMovement(at(3), at(4), 1.0));
        assertEquals(2, PathExecutor.firstFutureImpossible(movements, 0, 5, null));
    }

    /** The lookahead window excludes the current step (starts at +1) and the last path position. */
    @Test
    void futureImpossibleWindowExcludesCurrentAndTail() {
        List<Movement> movements = new ArrayList<>();
        movements.add(new FakeMovement(at(0), at(1), COST_INF)); // index 0 = current, not checked
        movements.add(new FakeMovement(at(1), at(2), 1.0));
        movements.add(new FakeMovement(at(2), at(3), COST_INF)); // index 2
        // lookahead=2 checks only i=1; index 2 is outside the window → -1
        assertEquals(-1, PathExecutor.firstFutureImpossible(movements, 0, 2, null));
        // lookahead=3 checks i=1,2; hits index 2
        assertEquals(2, PathExecutor.firstFutureImpossible(movements, 0, 3, null));
    }
}
