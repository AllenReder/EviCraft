package dev.mcagent.runtime.core.task.combat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Bow draw and release rules (vanilla charge formula and release timing). */
class RangedShotRulesTest {

    /** Vanilla: a full draw takes one second; drawing longer adds nothing. */
    @Test
    void aBowReachesFullPowerAtOneSecond() {
        assertEquals(1.0, RangedShot.bowPowerForTicks(20), 1e-9);
        assertEquals(1.0, RangedShot.bowPowerForTicks(40), 1e-9, "overdrawing still means full");
    }

    @Test
    void aBarelyDrawnBowIsWeak() {
        assertTrue(RangedShot.bowPowerForTicks(3) < 0.4);
        assertEquals(0.0, RangedShot.bowPowerForTicks(0), 1e-9);
    }

    @Test
    void powerRisesWithTheDraw() {
        assertTrue(RangedShot.bowPowerForTicks(5) < RangedShot.bowPowerForTicks(10));
        assertTrue(RangedShot.bowPowerForTicks(10) < RangedShot.bowPowerForTicks(15));
    }

    /** Releasing on target but under-drawn fires a weak arrow; both conditions must hold. */
    @Test
    void bothAimAndDrawAreRequiredBeforeLoosing() {
        assertTrue(RangedShot.canRelease(0.5, 15, 15));
        assertFalse(RangedShot.canRelease(0.5, 10, 15), "not drawn enough");
        assertFalse(RangedShot.canRelease(20.0, 15, 15), "not aimed");
    }

    /** The angle threshold is inclusive: an angle exactly at it counts as aimed. */
    @Test
    void theAimThresholdItselfCounts() {
        assertTrue(RangedShot.canRelease(RangedShot.AIM_THRESHOLD_DEGREES, 15, 15));
    }
}
