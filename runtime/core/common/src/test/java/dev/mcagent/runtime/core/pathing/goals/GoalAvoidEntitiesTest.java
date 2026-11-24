package dev.mcagent.runtime.core.pathing.goals;

import dev.mcagent.runtime.core.pathing.goals.GoalAvoidEntities.Threat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Avoiding a set of threats. Pins three properties: <b>each threat uses its own danger radius</b>, <b>all
 * threats count together, not just the nearest</b>, and <b>real entity coordinates are compared with cell
 * centers</b>.
 */
class GoalAvoidEntitiesTest {

    /** Threats stand on cell centers so distances are easy to count. */
    private static Threat threat(double x, double z, double radius) {
        return new Threat(x + 0.5, 64.0, z + 0.5, radius);
    }

    private static GoalAvoidEntities avoid(Threat... threats) {
        return new GoalAvoidEntities(1.0, threats);
    }

    /** Clear only once outside the radius. */
    @Test
    void arrivalMeansOutsideEveryRadius() {
        GoalAvoidEntities goal = avoid(threat(0, 0, 3.0));
        assertFalse(goal.isInGoal(2, 64, 0));
        assertTrue(goal.isInGoal(3, 64, 0));
    }

    /**
     * Each threat uses <b>its own</b> radius. A single shared value would have to be the maximum, so the Bot
     * would keep spider distance from zombies and never reach them.
     */
    @Test
    void everyThreatBringsItsOwnRadius() {
        GoalAvoidEntities goal = avoid(threat(0, 0, 2.0), threat(10, 0, 6.0));
        assertTrue(goal.isInGoal(2, 64, 0));      // 2 blocks from the near one: enough
        assertFalse(goal.isInGoal(5, 64, 0));     // 5 blocks from the far one, which needs 6
        assertTrue(goal.isInGoal(3, 64, 0));      // clear of both
    }

    /** Height gives no exemption: explosions are spherical, so three blocks above is not safe. */
    @Test
    void heightIsNotSafety() {
        assertFalse(avoid(threat(0, 0, 3.0)).isInGoal(0, 70, 0));
    }

    /** The field counts every threat, so with one on each side the path does not go straight through either. */
    @Test
    void everyThreatCountsInTheField() {
        Threat left = threat(0, 0, 3.0);
        Threat right = threat(10, 0, 3.0);
        double between = avoid(left, right).heuristic(5, 64, 0);
        double outside = avoid(left, right).heuristic(20, 64, 0);
        assertTrue(between > outside);
    }

    @Test
    void closerIsAlwaysMoreExpensive() {
        GoalAvoidEntities goal = avoid(threat(0, 0, 3.0));
        assertTrue(goal.heuristic(1, 64, 0) > goal.heuristic(4, 64, 0));
        assertTrue(goal.heuristic(4, 64, 0) > goal.heuristic(12, 64, 0));
    }

    /**
     * Potential is measured in <b>multiples of the radius</b>, so two threats at the edge of their own radii
     * have equal potential; the danger level is already in the radius and needs no separate weight.
     */
    @Test
    void thePotentialScalesWithTheRadius() {
        double small = avoid(threat(0, 0, 2.0)).heuristic(2, 64, 0);
        double large = avoid(threat(0, 0, 6.0)).heuristic(6, 64, 0);
        assertEquals(small, large, 1e-9);
    }

    /**
     * Danger is <b>summed</b>, not averaged.
     *
     * <p>Averaging would make each threat less worth avoiding as the crowd grows: detouring around an
     * adjacent large slime costs about one extra block (about 4.6), while with four threats the averaged
     * saving is only 4.49, so the path would sometimes go straight through the slime, get blocked, and take
     * contact damage every tick.
     */
    @Test
    void dangerAddsUpInsteadOfAveragingOut() {
        Threat one = threat(0, 0, 3.0);
        Threat two = threat(0, 6, 3.0);
        double alone = avoid(one).heuristic(2, 64, 0);
        double crowded = avoid(one, two).heuristic(2, 64, 0);
        assertTrue(crowded > alone, "one more mob should not make this cell cheaper");

        // a threat's own contribution does not shrink because others are nearby
        double contribution = crowded - avoid(two).heuristic(2, 64, 0);
        assertEquals(alone, contribution, 1e-9);
    }

    /** The penalty factor scales costs without changing their order. */
    @Test
    void theExchangeRateScalesTheField() {
        Threat t = threat(0, 0, 3.0);
        double weak = new GoalAvoidEntities(1.0, t).heuristic(2, 64, 0);
        double strong = new GoalAvoidEntities(40.0, t).heuristic(2, 64, 0);
        assertEquals(weak * 40.0, strong, 1e-9);
    }

    @Test
    void aRadiusCannotBeNegative() {
        assertThrows(IllegalArgumentException.class, () -> new Threat(0, 0, 0, -1.0));
    }

    @Test
    void avoidingNothingIsNotAGoal() {
        assertThrows(IllegalArgumentException.class, () -> new GoalAvoidEntities(1.0));
    }
}
