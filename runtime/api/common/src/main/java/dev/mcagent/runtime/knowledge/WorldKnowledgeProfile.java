package dev.mcagent.runtime.knowledge;

import java.util.Map;
import java.util.Objects;

/** Immutable selection of the one World Knowledge provider owned by a World Run. */
public enum WorldKnowledgeProfile {
    GROUNDED_EVIDENCE("grounded_evidence"),
    LOADED_WORLD_STATE("loaded_world_state");

    public static final String ENVIRONMENT_VARIABLE = "EVICRAFT_WORLD_KNOWLEDGE_PROFILE";

    private final String wireValue;

    WorldKnowledgeProfile(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }

    public static WorldKnowledgeProfile from(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        String configured = environment.get(ENVIRONMENT_VARIABLE);
        if (configured == null) return GROUNDED_EVIDENCE;
        for (WorldKnowledgeProfile profile : values()) {
            if (profile.wireValue.equals(configured)) return profile;
        }
        throw new IllegalArgumentException(
                ENVIRONMENT_VARIABLE + " must be grounded_evidence or loaded_world_state");
    }
}
