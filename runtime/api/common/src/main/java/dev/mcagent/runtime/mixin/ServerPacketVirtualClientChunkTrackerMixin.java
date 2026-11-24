package dev.mcagent.runtime.mixin;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTrackerAccess;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundSectionBlocksUpdatePacket;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.level.ChunkPos;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Applies block packets before the headless connection intentionally discards them. */
@Mixin(value = ServerCommonPacketListenerImpl.class, priority = 1100)
public abstract class ServerPacketVirtualClientChunkTrackerMixin {

    @Inject(method = "send(Lnet/minecraft/network/protocol/Packet;)V", at = @At("HEAD"))
    private void mcagent$applyLoadedBlockPacket(Packet<?> packet, CallbackInfo callback) {
        if (!((Object) this instanceof ServerGamePacketListenerImpl listener)
                || !(listener.player instanceof BotPlayer)) {
            return;
        }
        VirtualClientChunkTrackerAccess tracker =
                (VirtualClientChunkTrackerAccess) listener.player.connection.chunkSender;
        String dimension = listener.player.level().dimension().location().toString();
        if (packet instanceof ClientboundBlockUpdatePacket update) {
            applyIfTracked(listener, tracker, dimension,
                    update.getPos(), update.getBlockState());
        } else if (packet instanceof ClientboundSectionBlocksUpdatePacket updates) {
            updates.runUpdates((position, state) -> applyIfTracked(
                    listener, tracker, dimension, position, state));
        }
    }

    private static void applyIfTracked(
            ServerGamePacketListenerImpl listener,
            VirtualClientChunkTrackerAccess tracker,
            String dimension,
            net.minecraft.core.BlockPos position,
            net.minecraft.world.level.block.state.BlockState state) {
        if (listener.player.getChunkTrackingView().contains(new ChunkPos(position))) {
            tracker.mcagent$blockUpdated(dimension, position, state);
        }
    }
}
