package dev.mcagent.runtime.entity;

import com.mojang.authlib.GameProfile;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.level.GameType;
import net.minecraft.world.phys.Vec3;

import java.util.UUID;

/**
 * Spawns and despawns bot {@link BotPlayer} bodies through the vanilla
 * player-join path — entirely public API, no loader-specific construction needed
 * (the only fake piece is {@link FakeConnection}, which is common).
 *
 * <p>The Runtime always creates a fresh random profile and never asks the player
 * list to load an earlier profile's data.
 */
@dev.mcagent.runtime.api.Internal
public final class BotFactory {

    private BotFactory() {}

    /** Bring a new Runtime Bot body into the world with fixed client tracking options. */
    public static BotPlayer spawnFresh(MinecraftServer server, UUID botUuid, String name,
                                         ServerLevel level, Vec3 pos,
                                         ClientInformation clientInformation) {
        GameProfile profile = new GameProfile(botUuid, name);
        BotPlayer player = new BotPlayer(server, level, profile, clientInformation);
        // Vanilla establishes tracking during placeNewPlayer, so the final safe spawn must already
        // be authoritative before the join lifecycle adds this player to DistanceManager/ChunkMap.
        player.moveTo(pos.x, pos.y, pos.z, player.getYRot(), player.getXRot());
        FakeConnection connection = new FakeConnection();
        server.getPlayerList().placeNewPlayer(connection, player,
                CommonListenerCookie.createInitial(profile, false));
        // placeNewPlayer establishes the vanilla connection/player-list state. The Runtime Bot
        // mixin suppresses its playerdata load; repeat the same final pose for lifecycle hooks that
        // may have adjusted the body without changing the already-correct first tracking center.
        player.moveTo(pos.x, pos.y, pos.z, player.getYRot(), player.getXRot());
        // A fake player has no client-reported model customisation: enable every skin layer and the cape,
        // or only the base skin layer is shown. Reset on every spawn: the byte is synced entity data and
        // is not saved with playerdata.
        player.showAllSkinLayers();
        // The first baseline always starts in survival and inherits no previous game mode.
        player.setGameMode(GameType.SURVIVAL);
        return player;
    }

    /** Remove a Runtime Bot body from the world without defining a restore path. */
    public static void despawn(MinecraftServer server, BotPlayer player) {
        // Tell tool packs the body is leaving so they can finalize their own
        // per-bot work (e.g. clear a mining crack overlay) instead of leaving
        // it orphaned once the body drops out of the tick loop's player list.
        BotLifecycle.fireRemove(player);
        server.getPlayerList().remove(player);
    }
}
