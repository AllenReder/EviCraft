package dev.mcagent.runtime.evidence;

import java.util.Locale;

/** Provenance that admitted one block fact into the selected Block Knowledge provider. */
public enum BlockEvidenceSource {
    VISION,
    CONTACT,
    ATTRIBUTABLE_ACTION,
    MISMATCH,
    LOADED_WORLD_STATE;

    public String wireValue() {
        return name().toLowerCase(Locale.ROOT);
    }
}
