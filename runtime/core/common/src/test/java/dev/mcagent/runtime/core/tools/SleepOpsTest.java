package dev.mcagent.runtime.core.tools;

import net.minecraft.world.entity.player.Player;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * How bed rejection reasons reach the model.
 *
 * <p>Vanilla's messages are already specific ("there are monsters nearby", "the bed is too far away"),
 * so they are forwarded verbatim rather than rewritten; a rewrite would have to track vanilla wording and
 * would go stale. These tests pin "vanilla wording arrives unchanged" and "the two problems without a
 * message do not crash".
 */
@Tag("mc")
class SleepOpsTest {

    private static boolean booted;

    @BeforeAll
    static void boot() {
        try {
            net.minecraft.SharedConstants.tryDetectVersion();
            net.minecraft.server.Bootstrap.bootStrap();
            booted = true;
        } catch (Throwable t) {
            booted = false;
        }
    }

    /** Problems with a vanilla message are forwarded verbatim. */
    @Test
    void vanillaWordingIsPassedThroughUntouched() {
        assumeTrue(booted);
        for (Player.BedSleepingProblem problem : Player.BedSleepingProblem.values()) {
            if (problem.getMessage() == null) {
                continue;
            }
            assertEquals(problem.getMessage().getString(), SleepOps.explain(problem), problem.name());
        }
    }

    /**
     * {@code NOT_POSSIBLE_HERE} and {@code OTHER_PROBLEM} have no vanilla message. Unguarded, they NPE,
     * turning "the Bot cannot sleep" into "the tool errored", which the model cannot act on.
     */
    @Test
    void aRejectionWithNoVanillaWordingStillSaysSomethingUsable() {
        assumeTrue(booted);
        int checked = 0;
        for (Player.BedSleepingProblem problem : Player.BedSleepingProblem.values()) {
            if (problem.getMessage() != null) {
                continue;
            }
            checked++;
            String text = SleepOps.explain(problem);
            assertFalse(text.isBlank(), problem.name());
            assertTrue(text.contains(problem.name().toLowerCase(Locale.ROOT)), text);
        }
        assertTrue(checked > 0, "vanilla no longer has refusals without wording? Then this guard can be retired");
    }

    /** Every problem must produce text; none may fall through to an empty string. */
    @Test
    void everyRejectionHasWords() {
        assumeTrue(booted);
        for (Player.BedSleepingProblem problem : Player.BedSleepingProblem.values()) {
            assertFalse(SleepOps.explain(problem).isBlank(), problem.name());
        }
    }

    @Test
    void everyVanillaRejectionHasAStableEnterBedFailureType() {
        assumeTrue(booted);
        Map<Player.BedSleepingProblem, String> expected = Map.of(
                Player.BedSleepingProblem.NOT_POSSIBLE_HERE, "bed_not_usable_in_dimension",
                Player.BedSleepingProblem.NOT_POSSIBLE_NOW, "not_sleep_time",
                Player.BedSleepingProblem.TOO_FAR_AWAY, "out_of_reach",
                Player.BedSleepingProblem.OBSTRUCTED, "obstructed",
                Player.BedSleepingProblem.OTHER_PROBLEM, "occupied",
                Player.BedSleepingProblem.NOT_SAFE, "unsafe_nearby_monster");

        for (Player.BedSleepingProblem problem : Player.BedSleepingProblem.values()) {
            assertEquals(expected.get(problem), SleepOps.failureType(problem, false), problem.name());
        }
    }

    @Test
    void acceptedRequestMustStillBecomeSleeping() {
        assertEquals("accepted_but_not_sleeping", SleepOps.failureType(null, false));
        assertEquals(null, SleepOps.failureType(null, true));
    }
}
