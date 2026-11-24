package dev.mcagent.runtime.core.combat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The danger-radius ruler. Only the rules that need no entity are pinned here. */
class MenaceTest {

    /** Vanilla {@code Mob.DEFAULT_ATTACK_REACH}. */
    private static final double ATTACK_REACH = Math.sqrt(2.04) - 0.6;

    /** The {@code Menace.strikeRangeOf} formula computed from widths, so the test needs no entities. */
    private static double strikeRange(double attackerWidth, double victimWidth) {
        return (attackerWidth / 2.0 + ATTACK_REACH + victimWidth / 2.0) * Math.sqrt(2.0);
    }

    /**
     * The safe circle must be the <b>circumscribed circle</b> of the box check. The inscribed circle (without
     * √2) is wrong: at a center distance of 1.43 on the diagonal, each axis gap is 1.01 and the hit lands.
     */
    @Test
    void theSafeCircleCircumscribesTheAttackBox() {
        double perAxis = 0.3 + ATTACK_REACH + 0.3;      // zombie vs. player, per axis
        double radius = strikeRange(0.6, 0.6);
        assertEquals(perAxis * Math.sqrt(2.0), radius, 1e-9);
        // the farthest reachable point on the diagonal lies exactly on the circle
        assertEquals(Math.hypot(perAxis, perAxis), radius, 1e-9);
    }

    /** Wider mobs reach farther, which is why the radius cannot be a constant. */
    @Test
    void widerMobsReachFurther() {
        double zombie = strikeRange(0.6, 0.6);
        double spider = strikeRange(1.4, 0.6);
        double bigSlime = strikeRange(2.04, 0.6);
        assertTrue(zombie < spider);
        assertTrue(spider < bigSlime);
    }

    /**
     * <b>Reach &gt; danger radius</b>: backing off to the edge still allows hitting. This inequality is the
     * whole reason no hysteresis is needed.
     *
     * <p>Reach must include the target's half-width: vanilla's 3.0 runs from the eyes to the <b>hitbox</b>,
     * not to the center. A large slime is 2.04 wide; without the half-width it would be judged out of reach,
     * although a vanilla player can hit it.
     */
    @Test
    void herReachBeatsTheirDangerRadius() {
        double slack = Math.sqrt(2.0) / 2.0;            // Menace.CELL_SLACK
        for (double width : new double[] {0.6, 1.4, 2.04}) {
            double reach = Swing.reachTo(3.0, width);
            double danger = strikeRange(width, 0.6) + slack;
            assertTrue(reach > danger,
                    "mob of width " + width + " leaves no window: reach " + reach + ", danger " + danger);
        }
    }
}
