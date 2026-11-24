package dev.mcagent.runtime.core.pathing.goals;

import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Ring stance band. <b>Pins the heuristic, not membership</b>: membership is one sphere minus another; the
 * heuristic is what positioning actually needs.
 */
class GoalRingTest {

    private static final BlockPos CENTRE = new BlockPos(0, 64, 0);

    @Test
    void onlyTheBandCounts() {
        var ring = new GoalRing(CENTRE, 8.0, 12.0);
        assertTrue(ring.isInGoal(10, 64, 0));
        assertFalse(ring.isInGoal(3, 64, 0), "closer than the inner edge does not count as arrived");
        assertFalse(ring.isInGoal(20, 64, 0), "farther than the outer edge does not count as arrived");
    }

    /**
     * <b>When too close, moving outward must lower the estimate.</b>
     *
     * <p>A spherical goal (estimate = distance to center) does the opposite: the valid bow positions are eight
     * blocks out while a mob may be 0.7 blocks away, so every step outward raises the estimate. The search
     * digs toward the mob, and {@code bestSoFar} picks the lowest-estimate node, the cell right next to it.
     */
    @Test
    void tooCloseMeansOutwardIsCheaper() {
        var ring = new GoalRing(CENTRE, 8.0, 12.0);
        double atOne = ring.heuristic(1, 64, 0);
        double atFour = ring.heuristic(4, 64, 0);
        double atNine = ring.heuristic(9, 64, 0);
        assertTrue(atFour < atOne, "moved outward but the estimate got more expensive");
        assertTrue(atNine < atFour, "estimate should keep dropping on reaching the band edge");
        assertEquals(0.0, atNine, 1e-9, "should be zero inside the band");
    }

    /** When too far, moving inward must lower the estimate: both directions need a gradient. */
    @Test
    void tooFarMeansInwardIsCheaper() {
        var ring = new GoalRing(CENTRE, 8.0, 12.0);
        assertTrue(ring.heuristic(14, 64, 0) < ring.heuristic(20, 64, 0));
        assertEquals(0.0, ring.heuristic(12, 64, 0), 1e-9);
    }

    /**
     * Inner edge beyond the outer edge (a large slime outreaches the player): degenerates to a solid disc,
     * since no safe band exists.
     */
    @Test
    void animpossibleBandFallsBackToASphere() {
        var ring = new GoalRing(CENTRE, 12.0, 8.0);
        assertTrue(ring.isInGoal(0, 64, 0));
        assertTrue(ring.isInGoal(7, 64, 0));
        assertFalse(ring.isInGoal(20, 64, 0));
    }

    /** Height is ignored: three blocks above is not backed off, and three blocks below is not in contact. */
    @Test
    void heightDoesNotCount() {
        var ring = new GoalRing(CENTRE, 8.0, 12.0);
        assertTrue(ring.isInGoal(10, 90, 0));
        assertFalse(ring.isInGoal(0, 90, 0));
    }
}
