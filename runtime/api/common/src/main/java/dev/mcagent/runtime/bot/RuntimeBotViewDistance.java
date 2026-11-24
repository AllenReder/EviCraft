package dev.mcagent.runtime.bot;

import java.util.Map;
import java.util.Objects;
import java.util.OptionalInt;

/** World Run-fixed Runtime Bot view distance in vanilla chunk-column radius units. */
public record RuntimeBotViewDistance(
        OptionalInt configured,
        int requested,
        int effective
) {
    public static final String ENVIRONMENT_VARIABLE = "EVICRAFT_RUNTIME_VIEW_DISTANCE";
    public static final int VANILLA_MINIMUM = 2;

    public RuntimeBotViewDistance {
        Objects.requireNonNull(configured, "configured");
        if (requested < VANILLA_MINIMUM || effective < VANILLA_MINIMUM
                || effective > requested) {
            throw new IllegalArgumentException("invalid Runtime Bot view distance");
        }
        if (configured.isPresent() && configured.getAsInt() != requested) {
            throw new IllegalArgumentException("configured view distance must equal requested");
        }
    }

    public static RuntimeBotViewDistance from(
            Map<String, String> environment, int serverViewDistance) {
        Objects.requireNonNull(environment, "environment");
        int serverLimit = Math.max(VANILLA_MINIMUM, serverViewDistance);
        String raw = environment.get(ENVIRONMENT_VARIABLE);
        if (raw == null || raw.isBlank()) {
            return new RuntimeBotViewDistance(
                    OptionalInt.empty(), serverLimit, serverLimit);
        }
        int requested;
        try {
            requested = Integer.parseInt(raw.trim());
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(
                    ENVIRONMENT_VARIABLE + " must be an integer", error);
        }
        if (requested < VANILLA_MINIMUM) {
            throw new IllegalArgumentException(
                    ENVIRONMENT_VARIABLE + " must be at least 2");
        }
        return new RuntimeBotViewDistance(
                OptionalInt.of(requested), requested,
                Math.min(requested, serverLimit));
    }
}
