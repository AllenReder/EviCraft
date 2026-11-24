package dev.mcagent.runtime.bot;

import net.minecraft.core.SectionPos;
import net.minecraft.world.level.ChunkPos;

import java.util.Objects;
import java.util.Optional;
import java.util.OptionalInt;

/** Machine-readable operator/test-only Runtime Bot Server Tracking diagnostics. */
public record RuntimeBotTrackingDiagnostics(
        OptionalInt configuredViewDistance,
        int requestedViewDistance,
        int effectiveViewDistance,
        Optional<TrackingState> tracking
) {
    public RuntimeBotTrackingDiagnostics {
        Objects.requireNonNull(configuredViewDistance, "configuredViewDistance");
        Objects.requireNonNull(tracking, "tracking");
    }

    public record TrackingState(
            String dimension,
            SectionPos section,
            ChunkPos center,
            int viewDistance,
            int pendingChunkCount,
            int unacknowledgedBatchCount
    ) {
        public TrackingState {
            Objects.requireNonNull(dimension, "dimension");
            Objects.requireNonNull(section, "section");
            Objects.requireNonNull(center, "center");
        }
    }
}
