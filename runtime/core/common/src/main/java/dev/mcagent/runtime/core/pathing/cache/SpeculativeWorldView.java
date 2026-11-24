package dev.mcagent.runtime.core.pathing.cache;

import net.minecraft.core.BlockPos;

/** Evidence-aware navigation view that records UNKNOWN reads for one movement dependency. */
public interface SpeculativeWorldView {
    void beginDependencyCapture();
    boolean dependencyWasUnknown();
    boolean isKnown(BlockPos position);
    boolean isKnownBlock(BlockPos position);
}
