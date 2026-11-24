package dev.mcagent.runtime.core.pathing.moves;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Pins key values of the cost constants and the fall table. These values are part of the behavioral
 * baseline; any formula change must show up here explicitly.
 */
class ActionCostsTest {

    private static final double EPS = 1e-3;

    @Test
    void fallTableHasFullRange() {
        assertEquals(4097, ActionCosts.FALL_N_BLOCKS_COST.length);
        assertEquals(0.0, ActionCosts.FALL_N_BLOCKS_COST[0]);
    }

    @Test
    void fallTableKeyValues() {
        assertEquals(5.6147, ActionCosts.FALL_N_BLOCKS_COST[1], EPS);
        assertEquals(9.4687, ActionCosts.FALL_N_BLOCKS_COST[3], EPS);
        assertEquals(17.2922, ActionCosts.FALL_N_BLOCKS_COST[10], EPS);
    }

    @Test
    void fallTableIsStrictlyIncreasing() {
        for (int i = 1; i < ActionCosts.FALL_N_BLOCKS_COST.length; i++) {
            assertTrue(ActionCosts.FALL_N_BLOCKS_COST[i] > ActionCosts.FALL_N_BLOCKS_COST[i - 1],
                    "fall table at n=" + i + " is not increasing");
        }
    }

    @Test
    void derivedConstants() {
        assertEquals(4.63285, ActionCosts.WALK_ONE_BLOCK_COST, EPS);
        assertEquals(3.56379, ActionCosts.SPRINT_ONE_BLOCK_COST, EPS);
        assertEquals(0.76924, ActionCosts.SPRINT_MULTIPLIER, EPS);
        assertEquals(3.16340, ActionCosts.JUMP_ONE_BLOCK_COST, EPS);
        assertEquals(3.70628, ActionCosts.WALK_OFF_BLOCK_COST, EPS);
        assertEquals(0.92657, ActionCosts.CENTER_AFTER_FALL_COST, EPS);
        assertEquals(1_000_000, ActionCosts.COST_INF);
    }
}
