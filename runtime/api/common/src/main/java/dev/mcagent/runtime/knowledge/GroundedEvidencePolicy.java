package dev.mcagent.runtime.knowledge;

import java.util.Map;
import java.util.Objects;

/**
 * World Run-fixed settings of the grounded knowledge provider: how long unobserved evidence is
 * kept, and how wide the Actor sees.
 *
 * @param fieldOfViewDegrees full angle of the cone of sight around the look direction;
 *                           {@link #FULL_FIELD_OF_VIEW_DEGREES} sees in every direction
 */
public record GroundedEvidencePolicy(
        int blockExpiryTicks,
        int entityExpiryTicks,
        int fieldOfViewDegrees
) {
    public static final String BLOCK_ENVIRONMENT_VARIABLE =
            "EVICRAFT_GROUNDED_BLOCK_EXPIRY_TICKS";
    public static final String ENTITY_ENVIRONMENT_VARIABLE =
            "EVICRAFT_GROUNDED_ENTITY_EXPIRY_TICKS";
    public static final String FIELD_OF_VIEW_ENVIRONMENT_VARIABLE =
            "EVICRAFT_GROUNDED_FIELD_OF_VIEW_DEGREES";
    public static final int NEVER = -1;
    public static final int DEFAULT_BLOCK_EXPIRY_TICKS = 400;
    public static final int DEFAULT_ENTITY_EXPIRY_TICKS = 400;
    public static final int FULL_FIELD_OF_VIEW_DEGREES = 360;

    public GroundedEvidencePolicy {
        validateExpiry(BLOCK_ENVIRONMENT_VARIABLE, blockExpiryTicks);
        validateExpiry(ENTITY_ENVIRONMENT_VARIABLE, entityExpiryTicks);
        if (fieldOfViewDegrees < 1 || fieldOfViewDegrees > FULL_FIELD_OF_VIEW_DEGREES) {
            throw new IllegalArgumentException(FIELD_OF_VIEW_ENVIRONMENT_VARIABLE
                    + " must be an integer from 1 through 360");
        }
    }

    public static GroundedEvidencePolicy defaults() {
        return from(Map.of());
    }

    public static GroundedEvidencePolicy from(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        return new GroundedEvidencePolicy(
                parse(environment, BLOCK_ENVIRONMENT_VARIABLE, DEFAULT_BLOCK_EXPIRY_TICKS),
                parse(environment, ENTITY_ENVIRONMENT_VARIABLE, DEFAULT_ENTITY_EXPIRY_TICKS),
                parse(environment, FIELD_OF_VIEW_ENVIRONMENT_VARIABLE,
                        FULL_FIELD_OF_VIEW_DEGREES));
    }

    private static int parse(Map<String, String> environment, String name, int defaultValue) {
        String raw = environment.get(name);
        if (raw == null) return defaultValue;
        try {
            return Integer.parseInt(raw);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(name + " must be an integer", error);
        }
    }

    private static void validateExpiry(String name, int value) {
        if (value == NEVER || value > 0) return;
        throw new IllegalArgumentException(
                name + " must be -1 or an integer from 1 through 2147483647");
    }
}
