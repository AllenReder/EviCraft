package dev.mcagent.camera.mixin;

import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.world.level.GameType;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * The server keeps the camera player in spectator mode so it has no world footprint. The client
 * presents the survival view the Runtime Bot would see: hand, hotbar, hearts, food and XP. Physics
 * keep following the server-sent spectator abilities and player info, so the camera never falls.
 */
@Mixin(MultiPlayerGameMode.class)
public abstract class MultiPlayerGameModeMixin {

    @Inject(method = "getPlayerMode", at = @At("HEAD"), cancellable = true)
    private void mcagentCamera$presentSurvival(CallbackInfoReturnable<GameType> callback) {
        callback.setReturnValue(GameType.SURVIVAL);
    }

    @Inject(method = "canHurtPlayer", at = @At("HEAD"), cancellable = true)
    private void mcagentCamera$showSurvivalStatus(CallbackInfoReturnable<Boolean> callback) {
        callback.setReturnValue(true);
    }

    @Inject(method = "hasExperience", at = @At("HEAD"), cancellable = true)
    private void mcagentCamera$showExperience(CallbackInfoReturnable<Boolean> callback) {
        callback.setReturnValue(true);
    }
}
