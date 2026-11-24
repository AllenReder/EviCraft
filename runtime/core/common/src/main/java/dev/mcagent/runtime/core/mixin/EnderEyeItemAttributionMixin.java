package dev.mcagent.runtime.core.mixin;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.item.EnderEyeItem;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/** Exact synchronous binding from a Runtime Bot's native Ender Eye use to its spawned Eye. */
@Mixin(EnderEyeItem.class)
public abstract class EnderEyeItemAttributionMixin {

    @Redirect(method = "use", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/world/level/Level;addFreshEntity(Lnet/minecraft/world/entity/Entity;)Z"))
    private boolean mcAgent$bindLaunchedEye(
            Level targetLevel, Entity entity,
            Level level, Player player, InteractionHand hand) {
        boolean added = targetLevel.addFreshEntity(entity);
        if (added && player instanceof BotPlayer bot && entity instanceof EyeOfEnder eye
                && RuntimeBotManager.isRuntimeBot(bot)) {
            RuntimeBotManager.recordAttributableEnderEyeLaunch(bot, eye);
        }
        return added;
    }
}
