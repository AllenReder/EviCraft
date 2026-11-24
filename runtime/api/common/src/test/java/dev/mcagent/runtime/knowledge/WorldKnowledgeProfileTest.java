package dev.mcagent.runtime.knowledge;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class WorldKnowledgeProfileTest {

    @Test
    void defaultsToGroundedEvidence() {
        assertEquals(WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                WorldKnowledgeProfile.from(Map.of()));
    }

    @Test
    void acceptsOnlyCanonicalProfileValues() {
        assertEquals(WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                WorldKnowledgeProfile.from(Map.of(
                        WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "grounded_evidence")));
        assertEquals(WorldKnowledgeProfile.LOADED_WORLD_STATE,
                WorldKnowledgeProfile.from(Map.of(
                        WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "loaded_world_state")));

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> WorldKnowledgeProfile.from(Map.of(
                        WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "loaded")));
        assertEquals("EVICRAFT_WORLD_KNOWLEDGE_PROFILE must be grounded_evidence or loaded_world_state",
                error.getMessage());
        assertThrows(IllegalArgumentException.class,
                () -> WorldKnowledgeProfile.from(Map.of(
                        WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "  ")));
        assertThrows(IllegalArgumentException.class,
                () -> WorldKnowledgeProfile.from(Map.of(
                        WorldKnowledgeProfile.ENVIRONMENT_VARIABLE,
                        " grounded_evidence ")));
    }
}
