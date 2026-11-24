package dev.mcagent.runtime.sdk;

import java.util.Objects;

/** Position-free palette entry used by a flattened block-region result. */
public record RuntimeBlockPaletteEntry(
        RuntimeBlockEvidence.State state,
        String blockState,
        String fluid,
        String source,
        Long observedTick,
        Long observationRevision
) {
    public RuntimeBlockPaletteEntry {
        Objects.requireNonNull(state, "state");
        boolean known = state != RuntimeBlockEvidence.State.UNKNOWN;
        if (known != (source != null && observedTick != null && observationRevision != null)) {
            throw new IllegalArgumentException("known palette entries require provenance");
        }
        if (state == RuntimeBlockEvidence.State.KNOWN_BLOCK) {
            Objects.requireNonNull(blockState, "blockState");
            Objects.requireNonNull(fluid, "fluid");
        } else if (blockState != null || fluid != null) {
            throw new IllegalArgumentException("only KNOWN_BLOCK carries block state and fluid");
        }
    }

    public static RuntimeBlockPaletteEntry unknown() {
        return new RuntimeBlockPaletteEntry(RuntimeBlockEvidence.State.UNKNOWN,
                null, null, null, null, null);
    }

    public static RuntimeBlockPaletteEntry knownAir(
            String source, long observedTick, long observationRevision) {
        return new RuntimeBlockPaletteEntry(RuntimeBlockEvidence.State.KNOWN_AIR,
                null, null, source, observedTick, observationRevision);
    }

    public static RuntimeBlockPaletteEntry knownBlock(
            String blockState, String fluid, String source,
            long observedTick, long observationRevision) {
        return new RuntimeBlockPaletteEntry(RuntimeBlockEvidence.State.KNOWN_BLOCK,
                blockState, fluid, source, observedTick, observationRevision);
    }
}
