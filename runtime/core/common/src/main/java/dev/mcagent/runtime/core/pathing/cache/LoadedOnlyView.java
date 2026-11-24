package dev.mcagent.runtime.core.pathing.cache;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;

/**
 * "Loaded only" read view of the live world: reads in unloaded chunks always return air / empty fluid and
 * <b>never trigger synchronous chunk loading or generation</b> ({@code getChunkNow} only checks memory).
 * Reads in loaded chunks are identical to reading the level directly; this view is not part of
 * WorldKnowledge. Navigation currently uses it only for chunk readiness checks; costs and cell sets are
 * computed through the knowledge view.
 */
public final class LoadedOnlyView implements BlockGetter {

    private static final BlockState AIR = Blocks.AIR.defaultBlockState();

    private final ServerLevel level;

    private LoadedOnlyView(ServerLevel level) {
        this.level = level;
    }

    /**
     * Wraps the level in the clamped view; a non-server level (test harness) is returned unchanged.
     */
    public static BlockGetter of(Level level) {
        return level instanceof ServerLevel server ? new LoadedOnlyView(server) : level;
    }

    /** Whether the chunk containing these block coordinates is currently loaded in memory. */
    public boolean isLoaded(int x, int z) {
        return chunkAt(x, z) != null;
    }

    private LevelChunk chunkAt(int blockX, int blockZ) {
        return level.getChunkSource().getChunkNow(blockX >> 4, blockZ >> 4);
    }

    @Override
    public BlockState getBlockState(BlockPos pos) {
        if (level.isOutsideBuildHeight(pos)) {
            return AIR;
        }
        LevelChunk chunk = chunkAt(pos.getX(), pos.getZ());
        return chunk == null ? AIR : chunk.getBlockState(pos);
    }

    @Override
    public FluidState getFluidState(BlockPos pos) {
        if (level.isOutsideBuildHeight(pos)) {
            return Fluids.EMPTY.defaultFluidState();
        }
        LevelChunk chunk = chunkAt(pos.getX(), pos.getZ());
        return chunk == null ? Fluids.EMPTY.defaultFluidState() : chunk.getFluidState(pos);
    }

    @Override
    public BlockEntity getBlockEntity(BlockPos pos) {
        LevelChunk chunk = chunkAt(pos.getX(), pos.getZ());
        return chunk == null ? null : chunk.getBlockEntity(pos);
    }

    @Override
    public int getHeight() {
        return level.getHeight();
    }

    @Override
    public int getMinBuildHeight() {
        return level.getMinBuildHeight();
    }
}
