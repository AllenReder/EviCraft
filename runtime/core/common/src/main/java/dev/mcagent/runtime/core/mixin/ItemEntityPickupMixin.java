package dev.mcagent.runtime.core.mixin;

import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/** Observe the native transfer even when Inventory.add partially inserts and returns false. */
@Mixin(ItemEntity.class)
public abstract class ItemEntityPickupMixin {
    @Redirect(method = "playerTouch", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/world/entity/player/Inventory;add(Lnet/minecraft/world/item/ItemStack;)Z"))
    private boolean mcAgent$recordPickup(Inventory inventory, ItemStack stack, Player player) {
        int before = stack.getCount();
        boolean added = inventory.add(stack);
        int taken = before - stack.getCount();
        if (taken > 0 && player instanceof BotPlayer bot && RuntimeBotManager.isRuntimeBot(bot)) {
            PhysicalVerificationAuthority.publishEntityPickup(bot, (ItemEntity) (Object) this, taken);
        }
        return added;
    }
}
