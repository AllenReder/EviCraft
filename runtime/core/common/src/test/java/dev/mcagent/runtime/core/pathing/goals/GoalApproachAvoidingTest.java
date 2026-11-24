package dev.mcagent.runtime.core.pathing.goals;

import dev.mcagent.runtime.core.pathing.goals.GoalAvoidEntities.Threat;

import org.junit.jupiter.api.Test;

import net.minecraft.core.BlockPos;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Approach a target while avoiding other threats on the way.
 *
 * <p>Pins two properties: <b>stance quality is part of membership</b> (a cell another mob can reach does not
 * count as arrived), and <b>walking next to a threat is more expensive</b>.
 */
class GoalApproachAvoidingTest {

    /** A threat with danger radius 0 only affects edge costs and does not block arrival. */
    private static Threat fieldOnly(int x, int z) {
        return new Threat(x + 0.5, 64.0, z + 0.5, 0.0);
    }

    private static Threat threat(int x, int z, double radius) {
        return new Threat(x + 0.5, 64.0, z + 0.5, radius);
    }

    private static Goal approachTo(int x, int y, int z) {
        return new GoalBlock(x, y, z);
    }

    /**
     * The heuristic is <b>pure distance</b>. Avoidance goes into edge costs ({@code Avoidance.forGoal}), not
     * the heuristic.
     *
     * <p>In the heuristic it would have to be both strong enough to detour and weak enough not to break the
     * search, which is impossible: the heuristic must be a lower bound on remaining cost for A* to prune, and
     * proximity to mobs does not decrease as the target gets closer.
     */
    @Test
    void theEstimateIsPureDistance() {
        Goal plain = approachTo(10, 64, 0);
        Goal wrapped = new GoalApproachAvoiding(plain,
                new GoalAvoidEntities(40.0, threat(5, 0, 3.0)));
        assertEquals(plain.heuristic(0, 64, 0), wrapped.heuristic(0, 64, 0), 1e-9);
        assertEquals(plain.heuristic(5, 64, 1), wrapped.heuristic(5, 64, 1), 1e-9);
    }

    /** The threat table must be exposed: the search builds edge-cost penalty spheres from it. */
    @Test
    void theThreatsAreReadableBySearch() {
        var field = new GoalAvoidEntities(40.0, threat(5, 0, 3.0));
        Goal wrapped = new GoalApproachAvoiding(approachTo(10, 64, 0), field);
        assertEquals(1, ((GoalApproachAvoiding) wrapped).repulsion().threats().length);
    }

    /**
     * No wrapper without threats: the field is evaluated at every node and an empty set should not pay for
     * it.
     */
    @Test
    void nothingToAvoidReturnsThePlainApproach() {
        Goal plain = approachTo(5, 64, 5);
        assertSame(plain, GoalApproachAvoiding.wrap(plain, 40.0));
    }

    /**
     * Arrival needs both parts: the Bot is at the target, and its cell is outside every other threat's danger
     * radius. If only the attraction term were checked, avoidance would affect the route but not the standing
     * cell; once arrived A* stops searching, and the Bot would stop in a surrounded cell.
     */
    @Test
    void arrivalAlsoNeedsRoomFromTheOthers() {
        Goal plain = new GoalNear(new BlockPos(10, 64, 0), 3);
        var crowded = new GoalApproachAvoiding(plain,
                new GoalAvoidEntities(40.0, threat(9, 0, 2.5)));

        assertTrue(plain.isInGoal(9, 64, 1));            // attraction alone: arrived
        assertFalse(crowded.isInGoal(9, 64, 1));         // but inside another threat's radius
        assertTrue(crowded.isInGoal(12, 64, 0));         // also reaches the target and is outside the radius
    }

    /** A zero-radius threat only affects cost, not arrival. */
    @Test
    void aFieldOnlyThreatDoesNotBlockArrival() {
        Goal plain = new GoalNear(new BlockPos(10, 64, 0), 3);
        var wrapped = new GoalApproachAvoiding(plain,
                new GoalAvoidEntities(40.0, fieldOnly(9, 0)));
        assertTrue(wrapped.isInGoal(9, 64, 1));
    }
}
