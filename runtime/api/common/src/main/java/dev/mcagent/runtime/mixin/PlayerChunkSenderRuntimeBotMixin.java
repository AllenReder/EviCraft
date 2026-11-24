package dev.mcagent.runtime.mixin;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotChunkDeliveryView;
import dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTracker;
import dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTrackerAccess;
import it.unimi.dsi.fastutil.longs.LongSet;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.PlayerChunkSender;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Completes logical chunk delivery for a headless Runtime Bot after packets are discarded. */
@Mixin(PlayerChunkSender.class)
public abstract class PlayerChunkSenderRuntimeBotMixin
        implements RuntimeBotChunkDeliveryView, VirtualClientChunkTrackerAccess {

    @Shadow @Final private LongSet pendingChunks;
    @Shadow private int unacknowledgedBatches;

    private final VirtualClientChunkTracker mcagent$loadedChunks =
            new VirtualClientChunkTracker();

    @Inject(method = "markChunkPendingToSend", at = @At("HEAD"))
    private void mcagent$markChunkPending(LevelChunk chunk, CallbackInfo callback) {
        mcagent$loadedChunks.pending(chunk.getPos());
    }

    @Inject(method = "dropChunk", at = @At("HEAD"))
    private void mcagent$dropLoadedChunk(
            ServerPlayer player, ChunkPos position, CallbackInfo callback) {
        if (player instanceof BotPlayer) {
            mcagent$loadedChunks.unload(position);
        }
    }

    @Inject(method = "sendChunk", at = @At("TAIL"))
    private static void mcagent$loadDeliveredChunk(
            net.minecraft.server.network.ServerGamePacketListenerImpl connection,
            ServerLevel level, LevelChunk chunk, CallbackInfo callback) {
        if (connection.player instanceof BotPlayer
                && connection.player.getChunkTrackingView().contains(chunk.getPos())) {
            ((VirtualClientChunkTrackerAccess) connection.player.connection.chunkSender)
                    .mcagent$chunkLoaded(level, chunk);
        }
    }

    @Inject(method = "sendNextChunks", at = @At("TAIL"))
    private void mcagent$acknowledgeHeadlessChunkBatch(
            ServerPlayer player, CallbackInfo callback) {
        if (player instanceof BotPlayer && unacknowledgedBatches > 0) {
            ((PlayerChunkSender) (Object) this).onChunkBatchReceivedByClient(64.0F);
        }
    }

    @Override
    public int pendingChunkCount() {
        return pendingChunks.size();
    }

    @Override
    public int unacknowledgedBatchCount() {
        return unacknowledgedBatches;
    }

    @Override
    public void mcagent$chunkLoaded(ServerLevel level, LevelChunk chunk) {
        mcagent$loadedChunks.load(level, chunk);
    }

    @Override
    public void mcagent$blockUpdated(
            String dimension, net.minecraft.core.BlockPos position,
            net.minecraft.world.level.block.state.BlockState state) {
        mcagent$loadedChunks.update(dimension, position, state);
    }

    @Override
    public VirtualClientChunkTracker.Snapshot mcagent$loadedChunkSnapshot() {
        return mcagent$loadedChunks.snapshot();
    }
}
