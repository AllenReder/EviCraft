package dev.mcagent.runtime.mixin;

import net.minecraft.server.level.ChunkMap;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Reuse vanilla player tracking without ticking world simulation. */
@Mixin(ChunkMap.class)
public interface ChunkMapRuntimeMaintenanceAccess {
    @Invoker("updateChunkTracking")
    void mcagent$updateTracking(ServerPlayer player);
}
