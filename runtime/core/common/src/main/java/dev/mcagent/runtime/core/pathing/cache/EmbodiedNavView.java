package dev.mcagent.runtime.core.pathing.cache;

import dev.mcagent.runtime.evidence.BlockEvidenceSnapshot;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;

import java.util.Objects;

/** Immutable Embodied Navigation View for pathing; UNKNOWN is optimistic AIR. */
public final class EmbodiedNavView implements BlockGetter, SpeculativeWorldView {

    private final BlockEvidenceSnapshot snapshot;
    private final int minBuildHeight;
    private final int height;
    private boolean unknownDependency;

    public EmbodiedNavView(
            BlockEvidenceSnapshot snapshot, int minBuildHeight, int height) {
        this.snapshot = Objects.requireNonNull(snapshot, "snapshot");
        this.minBuildHeight = minBuildHeight;
        this.height = height;
    }

    @Override
    public BlockState getBlockState(BlockPos position) {
        BlockState state = snapshot.knownState(position);
        if (state == null) {
            unknownDependency = true;
            return Blocks.AIR.defaultBlockState();
        }
        return state;
    }

    @Override
    public FluidState getFluidState(BlockPos position) {
        return getBlockState(position).getFluidState();
    }

    @Override public BlockEntity getBlockEntity(BlockPos position) { return null; }
    @Override public int getHeight() { return height; }
    @Override public int getMinBuildHeight() { return minBuildHeight; }

    @Override
    public void beginDependencyCapture() {
        unknownDependency = false;
    }

    @Override
    public boolean dependencyWasUnknown() {
        return unknownDependency;
    }

    @Override
    public boolean isKnown(BlockPos position) {
        return snapshot.isKnown(position);
    }

    @Override
    public boolean isKnownBlock(BlockPos position) {
        return snapshot.isKnownBlock(position);
    }
}
