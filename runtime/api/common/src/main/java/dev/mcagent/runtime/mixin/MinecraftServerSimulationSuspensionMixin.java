package dev.mcagent.runtime.mixin;

import dev.mcagent.runtime.sdk.RuntimeSimulationControl;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import java.util.function.BooleanSupplier;

/** Stops the vanilla simulation loop while leaving the server task queue available to the SDK. */
@Mixin(MinecraftServer.class)
public abstract class MinecraftServerSimulationSuspensionMixin {

    @Inject(method = "tickServer", at = @At("HEAD"), cancellable = true)
    private void mcagent$suspendSimulation(BooleanSupplier hasTimeLeft, CallbackInfo callback) {
        RuntimeSimulationControl lifecycle = RuntimeSimulationControl.forServer((MinecraftServer) (Object) this);
        lifecycle.beforeTick();
        if (lifecycle.simulationSuspended()) {
            callback.cancel();
        }
    }
}
