package dev.mcagent.runtime.evidence;

/** Provenance for one Entity Track snapshot. */
public enum EntityEvidenceSource {
    VISION("vision"),
    LOADED_WORLD_STATE("loaded_world_state"),
    ATTRIBUTABLE_ACTION("attributable_action");

    private final String wireValue;

    EntityEvidenceSource(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }
}
