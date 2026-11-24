package dev.mcagent.runtime.core.mixin;

import dev.mcagent.runtime.bot.RuntimeBotManager;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/** Exact terminal attribution for one Runtime-Bot-launched Eye; no nearby entity matching. */
@Mixin(EyeOfEnder.class)
public abstract class EyeOfEnderAttributionMixin {

    @Redirect(method = "tick", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/world/entity/projectile/EyeOfEnder;discard()V"))
    private void mcAgent$recordDiscard(EyeOfEnder eye) {
        eye.discard();
        RuntimeBotManager.recordAttributableEnderEyeDiscard(eye);
    }

    @Redirect(method = "tick", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/world/level/Level;addFreshEntity(Lnet/minecraft/world/entity/Entity;)Z"))
    private boolean mcAgent$recordDrop(Level level, Entity entity) {
        boolean added = level.addFreshEntity(entity);
        if (added && entity instanceof ItemEntity item) {
            RuntimeBotManager.recordAttributableEnderEyeDrop(
                    (EyeOfEnder) (Object) this, item);
        }
        return added;
    }
}
