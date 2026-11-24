package dev.mcagent.camera.mixin;

import dev.mcagent.camera.CameraState;
import net.minecraft.client.multiplayer.ClientCommonPacketListenerImpl;
import net.minecraft.network.protocol.common.ClientboundPingPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The server ends each camera state update with a ping. Packets are applied in order on the client
 * thread, so once that ping is handled, every earlier state packet is visible to the renderer.
 * TAIL only runs on the client thread: the network-thread call leaves through the reschedule throw.
 */
@Mixin(ClientCommonPacketListenerImpl.class)
public abstract class ClientPingBarrierMixin {

    @Inject(method = "handlePing", at = @At("TAIL"))
    private void mcagentCamera$recordBarrier(ClientboundPingPacket packet, CallbackInfo callback) {
        CameraState.pingHandled(packet.getId());
    }
}
