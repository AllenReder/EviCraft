package dev.mcagent.runtime.knowledge;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class GroundedEvidencePolicyTest {

    @Test
    void defaultsForgetBlocksAndEntitiesAfterTheSameTimeAndSeeEveryDirection() {
        GroundedEvidencePolicy policy = GroundedEvidencePolicy.from(Map.of());

        assertEquals(400, policy.blockExpiryTicks());
        assertEquals(400, policy.entityExpiryTicks());
        assertEquals(360, policy.fieldOfViewDegrees());
    }

    @Test
    void readsAFieldOfViewFromOneThroughThreeHundredSixtyDegrees() {
        assertEquals(110, GroundedEvidencePolicy.from(Map.of(
                GroundedEvidencePolicy.FIELD_OF_VIEW_ENVIRONMENT_VARIABLE, "110"))
                .fieldOfViewDegrees());
        for (String value : new String[] {"0", "361", "-1"}) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                    () -> GroundedEvidencePolicy.from(Map.of(
                            GroundedEvidencePolicy.FIELD_OF_VIEW_ENVIRONMENT_VARIABLE, value)));
            assertEquals(GroundedEvidencePolicy.FIELD_OF_VIEW_ENVIRONMENT_VARIABLE
                    + " must be an integer from 1 through 360", error.getMessage());
        }
    }

    @Test
    void acceptsNeverPositiveAndMaximumLifetimes() {
        GroundedEvidencePolicy policy = GroundedEvidencePolicy.from(Map.of(
                GroundedEvidencePolicy.BLOCK_ENVIRONMENT_VARIABLE, "-1",
                GroundedEvidencePolicy.ENTITY_ENVIRONMENT_VARIABLE,
                Integer.toString(Integer.MAX_VALUE)));

        assertEquals(-1, policy.blockExpiryTicks());
        assertEquals(Integer.MAX_VALUE, policy.entityExpiryTicks());
    }

    @Test
    void rejectsZeroAndBelowNever() {
        assertInvalid(GroundedEvidencePolicy.BLOCK_ENVIRONMENT_VARIABLE, "0");
        assertInvalid(GroundedEvidencePolicy.BLOCK_ENVIRONMENT_VARIABLE, "-2");
    }

    @Test
    void rejectsBlankNonIntegerAndOverflow() {
        for (String value : new String[] {" ", "soon", "2147483648"}) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                    () -> GroundedEvidencePolicy.from(Map.of(
                            GroundedEvidencePolicy.ENTITY_ENVIRONMENT_VARIABLE, value)));
            assertEquals(GroundedEvidencePolicy.ENTITY_ENVIRONMENT_VARIABLE
                    + " must be an integer", error.getMessage());
        }
    }

    private static void assertInvalid(String name, String value) {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> GroundedEvidencePolicy.from(Map.of(name, value)));
        assertEquals(name + " must be -1 or an integer from 1 through 2147483647",
                error.getMessage());
    }
}
