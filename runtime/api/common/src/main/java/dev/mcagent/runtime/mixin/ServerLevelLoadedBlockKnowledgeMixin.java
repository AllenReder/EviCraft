package dev.mcagent.runtime.mixin;

import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.VisibilityGrid;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Feeds successful server block mutations into the loaded profile's client-owned cache and the
 * grounded profile's sight cache.
 */
@Mixin(ServerLevel.class)
public abstract class ServerLevelLoadedBlockKnowledgeMixin {

    @Inject(method = "onBlockStateChange", at = @At("HEAD"))
    private void mcagent$updateLoadedBlockKnowledge(
            BlockPos position, BlockState oldState, BlockState newState, CallbackInfo callback) {
        ServerLevel level = (ServerLevel) (Object) this;
        RuntimeBotManager.recordLoadedBlockChange(level, position, newState);
        VisibilityGrid.blockChanged(level, position, newState);
    }
}
