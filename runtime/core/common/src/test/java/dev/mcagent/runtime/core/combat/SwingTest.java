package dev.mcagent.runtime.core.combat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** When a swing may go out. */
class SwingTest {

    @Test
    void reachNeverFallsBelowTheVanillaFloor() {
        assertEquals(3.0, Swing.reachOf(2.5), 1e-9);   // vanilla ENTITY_INTERACTION_RANGE defaults to 3.0
        assertEquals(6.0, Swing.reachOf(6.0), 1e-9);
    }

    @Test
    void aFullyChargedSwingGoesOut() {
        assertTrue(Swing.mayStrike(false, false, 1.0f));
    }

    /** Swinging before the cooldown finishes scales damage by charge, wasting the swing. */
    @Test
    void anUnchargedSwingWaits() {
        assertFalse(Swing.mayStrike(false, false, 0.5f));
    }

    /** Damage during the target's invulnerability frames is absorbed; waiting for them to end deals more in total. */
    @Test
    void aTargetStillInItsInvulnerabilityWindowIsNotHit() {
        assertFalse(Swing.mayStrike(false, true, 1.0f));
    }

    /** No swing on the swap tick: attributes have not updated yet, so the hit would use the old weapon. */
    @Test
    void theTickAWeaponIsSwappedInIsSkipped() {
        assertFalse(Swing.mayStrike(true, false, 1.0f));
    }

    /**
     * The threshold must exceed vanilla's 0.9 critical-hit charge; otherwise "may swing" holds before
     * "can crit" and the Bot never lands a critical hit, losing that bonus damage.
     */
    @Test
    void theThresholdStaysAboveTheVanillaCriticalHitLine() {
        assertTrue(Swing.ATTACK_READY > 0.9f, "vanilla Player.attack requires charge > 0.9 for a critical hit");
        assertTrue(Swing.mayStrike(false, false, Swing.ATTACK_READY));
    }
}
