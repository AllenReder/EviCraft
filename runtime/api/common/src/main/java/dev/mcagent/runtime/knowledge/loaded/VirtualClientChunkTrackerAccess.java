package dev.mcagent.runtime.knowledge.loaded;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;

/** Internal bridge from vanilla chunk delivery and packets to the virtual client cache. */
public interface VirtualClientChunkTrackerAccess {

    void mcagent$chunkLoaded(ServerLevel level, LevelChunk chunk);

    void mcagent$blockUpdated(String dimension, BlockPos position, BlockState state);

    VirtualClientChunkTracker.Snapshot mcagent$loadedChunkSnapshot();
}
