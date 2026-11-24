package dev.mcagent.runtime.mixin;

import dev.mcagent.runtime.entity.BotPlayer;
import com.mojang.authlib.GameProfile;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.PlayerList;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

import java.util.Optional;

/** Preserve the Runtime Bot body subtype while leaving vanilla respawn policy intact. */
@Mixin(PlayerList.class)
public abstract class PlayerListRuntimeBotRespawnMixin {

    @Redirect(
            method = "placeNewPlayer",
            at = @At(
                    value = "INVOKE",
                    target = "Lnet/minecraft/server/players/PlayerList;load(Lnet/minecraft/server/level/ServerPlayer;)Ljava/util/Optional;"
            )
    )
    private Optional<CompoundTag> mcagent$skipRuntimeBotPlayerData(
            PlayerList playerList, ServerPlayer joining
    ) {
        return joining instanceof BotPlayer ? Optional.empty() : playerList.load(joining);
    }

    @Redirect(
            method = "respawn",
            at = @At(value = "NEW", target = "net/minecraft/server/level/ServerPlayer")
    )
    private ServerPlayer mcagent$createRespawnBody(
            MinecraftServer server,
            ServerLevel level,
            GameProfile profile,
            ClientInformation clientInformation,
            ServerPlayer oldBody,
            boolean keepEverything,
            Entity.RemovalReason reason
    ) {
        return oldBody instanceof BotPlayer
                ? new BotPlayer(server, level, profile, clientInformation)
                : new ServerPlayer(server, level, profile, clientInformation);
    }
}
