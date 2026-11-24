package dev.mcagent.runtime.core.pathing.astar;

import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.ChunkLoadedTest;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;

/** Shared truncation logic for path implementations: loaded-boundary cutoff and partial-path trimming. */
public abstract class PathBase implements NavPath {

    /**
     * Finds the first cell in an unloaded chunk and truncates there. {@code cutoffAtLoadBoundary} is off by
     * default; when off, the path is returned unchanged.
     */
    @Override
    public NavPath cutoffAtLoadedChunks(ChunkLoadedTest loadedTest) {
        if (!NavSettings.get().cutoffAtLoadBoundary) {
            return this;
        }
        for (int i = 0; i < positions().size(); i++) {
            BlockPos pos = positions().get(i);
            if (!loadedTest.isLoaded(pos.getX(), pos.getZ())) {
                return new CutoffPath(this, i);
            }
        }
        return this;
    }

    /**
     * Partial-path trimming: no trim when shorter than {@code pathCutoffMinimumLength} (30) or when the end is
     * already in the goal; otherwise {@code pathCutoffFactor} (0.9) drops the last tenth. The segment tail is
     * low quality and will be replanned anyway.
     */
    @Override
    public NavPath staticCutoff(Goal destination) {
        int min = NavSettings.get().pathCutoffMinimumLength;
        if (length() < min) {
            return this;
        }
        BlockPos dest = getDest();
        if (destination == null || destination.isInGoal(dest.getX(), dest.getY(), dest.getZ())) {
            return this;
        }
        double factor = NavSettings.get().pathCutoffFactor;
        int newLength = (int) ((length() - min) * factor) + min - 1;
        return new CutoffPath(this, newLength);
    }
}
