package dev.mcagent.runtime.mixin;

import net.minecraft.network.syncher.SynchedEntityData;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Reads every synced value, including ones back at their default, to mirror a body onto the camera. */
@Mixin(SynchedEntityData.class)
public interface SynchedEntityDataAccess {
    @Accessor("itemsById")
    SynchedEntityData.DataItem<?>[] mcagent$itemsById();
}
