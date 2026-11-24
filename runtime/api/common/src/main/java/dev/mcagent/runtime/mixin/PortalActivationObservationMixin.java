package dev.mcagent.runtime.mixin;

import dev.mcagent.runtime.benchmark.WorldEventCounters;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.LevelAccessor;
import net.minecraft.world.level.portal.PortalShape;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Native frame activation; PortalForcer's generated destination portal is a different path. */
@Mixin(PortalShape.class)
public abstract class PortalActivationObservationMixin {
    @Shadow @Final private LevelAccessor level;

    @Inject(method = "createPortalBlocks", at = @At("RETURN"))
    private void mcagent$recordPortalActivation(CallbackInfo callback) {
        if (level instanceof ServerLevel serverLevel) WorldEventCounters.recordPortalActivation(serverLevel.getServer());
    }
}
