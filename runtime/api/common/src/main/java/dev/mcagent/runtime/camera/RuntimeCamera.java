package dev.mcagent.runtime.camera;

import dev.mcagent.runtime.Constants;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.mixin.ChunkMapRuntimeMaintenanceAccess;
import dev.mcagent.runtime.mixin.SynchedEntityDataAccess;
import dev.mcagent.runtime.sdk.RuntimeCameraCapture;
import dev.mcagent.runtime.sdk.RuntimeCameraRequest;
import dev.mcagent.runtime.sdk.RuntimeCameraUnavailableException;
import dev.mcagent.runtime.sdk.RuntimeSimulationControl;
import net.minecraft.core.Holder;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.common.ClientboundPingPacket;
import net.minecraft.network.protocol.game.ClientboundContainerSetContentPacket;
import net.minecraft.network.protocol.game.ClientboundRemoveMobEffectPacket;
import net.minecraft.network.protocol.game.ClientboundSetCarriedItemPacket;
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket;
import net.minecraft.network.protocol.game.ClientboundSetExperiencePacket;
import net.minecraft.network.protocol.game.ClientboundSetHealthPacket;
import net.minecraft.network.protocol.game.ClientboundUpdateMobEffectPacket;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerConnectionListener;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.util.Mth;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.GameType;
import net.minecraft.world.phys.Vec3;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * First-person camera for the Runtime Bot.
 *
 * <p>A separate camera client logs in as a configured player. The server keeps that player in spectator
 * mode, so it adds no chunk tickets, spawning, sleeping or targeting, and keeps it at the Bot's eye.
 * Before a capture the Bot's inventory, selected slot, health, food, experience, effects and synced
 * entity data are sent to the camera client under the camera's own entity id, followed by a ping that
 * the client uses as an ordering barrier. The client renders the survival view from that state.
 *
 * <p>Configuration: {@code EVICRAFT_CAMERA_USERNAME} names the camera player and
 * {@code EVICRAFT_CAMERA_PORT} is the camera client's loopback control port. Both or neither are set.
 */
public final class RuntimeCamera {

    private static final Map<MinecraftServer, RuntimeCamera> CAMERAS = new IdentityHashMap<>();
    private static final long CLIENT_CAPTURE_TIMEOUT_MILLIS = 20_000;

    private final MinecraftServer server;
    private final String username;
    private final URI endpoint;
    private final HttpClient http = HttpClient.newBuilder()
            .proxy(HttpClient.Builder.NO_PROXY)
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final Set<Holder<MobEffect>> mirroredEffects = new HashSet<>();
    private ServerPlayer mirroredCamera;
    private int nextBarrier = 1;

    private RuntimeCamera(MinecraftServer server, String username, int port) {
        this.server = server;
        this.username = username;
        this.endpoint = URI.create("http://127.0.0.1:" + port + "/");
    }

    public static void start(MinecraftServer server, Map<String, String> environment) {
        String username = environment.get("EVICRAFT_CAMERA_USERNAME");
        String port = environment.get("EVICRAFT_CAMERA_PORT");
        boolean named = username != null && !username.isBlank();
        boolean ported = port != null && !port.isBlank();
        if (!named && !ported) return;
        if (!named || !ported) {
            throw new IllegalArgumentException("EVICRAFT_CAMERA_USERNAME and EVICRAFT_CAMERA_PORT must be set together");
        }
        RuntimeCamera camera = new RuntimeCamera(server, username.trim(), Integer.parseInt(port.trim()));
        // A spectator outside generated chunks must never create or keep them loaded.
        server.getGameRules().getRule(GameRules.RULE_SPECTATORSGENERATECHUNKS).set(false, server);
        synchronized (CAMERAS) { CAMERAS.put(server, camera); }
        Constants.LOG.info("[mc_agent-runtime] camera enabled for player {} via {}", camera.username, camera.endpoint);
    }

    public static void stop(MinecraftServer server) {
        synchronized (CAMERAS) { CAMERAS.remove(server); }
    }

    public static Optional<RuntimeCamera> of(MinecraftServer server) {
        synchronized (CAMERAS) { return Optional.ofNullable(CAMERAS.get(server)); }
    }

    /** True for the configured camera player; the Bot is never sent to it, so it cannot occlude the view. */
    public static boolean isCamera(ServerPlayer player) {
        MinecraftServer server = player.getServer();
        if (server == null || player instanceof BotPlayer) return false;
        return of(server).map(camera -> camera.matches(player)).orElse(false);
    }

    private boolean matches(ServerPlayer player) {
        return player.getGameProfile().getName().toLowerCase(Locale.ROOT).equals(username.toLowerCase(Locale.ROOT));
    }

    private Optional<ServerPlayer> cameraPlayer() {
        return Optional.ofNullable(server.getPlayerList().getPlayerByName(username))
                .filter(player -> !(player instanceof BotPlayer));
    }

    /**
     * Server thread, at every Runtime maintenance point. Keeps the camera a spectator at the Bot's eye and,
     * while simulation is suspended, keeps its chunk and entity tracking current without ticking the world.
     */
    public void maintain(boolean simulationSuspended) {
        if (simulationSuspended) tickConnectionsExceptOtherPlayers();
        ServerPlayer camera = cameraPlayer().orElse(null);
        if (camera == null) { mirroredCamera = null; return; }
        if (camera != mirroredCamera) {
            mirroredCamera = camera;
            mirroredEffects.clear();
        }
        if (camera.gameMode.getGameModeForPlayer() != GameType.SPECTATOR) camera.setGameMode(GameType.SPECTATOR);
        BotPlayer bot = RuntimeBotManager.current(server).orElse(null);
        if (bot == null || !bot.isAlive()) return;
        follow(camera, bot, bot.getYRot(), bot.getXRot());
        if (simulationSuspended) {
            ((ChunkMapRuntimeMaintenanceAccess) camera.serverLevel().getChunkSource().chunkMap).mcagent$updateTracking(camera);
            camera.connection.chunkSender.sendNextChunks(camera);
        }
    }

    /**
     * Login, configuration and keepalive progress only in connection ticks, which suspension skips with the
     * rest of tickServer. This is ServerConnectionListener.tick without play connections of other players:
     * a play tick runs the full player tick, so any other real player stays frozen with the world. The Bot's
     * in-memory connection is not registered with the listener.
     */
    private void tickConnectionsExceptOtherPlayers() {
        ServerConnectionListener listener = server.getConnection();
        if (listener == null) return;
        List<Connection> connections = listener.getConnections();
        synchronized (connections) {
            for (Iterator<Connection> iterator = connections.iterator(); iterator.hasNext(); ) {
                Connection connection = iterator.next();
                if (connection.isConnecting()) continue;
                if (!connection.isConnected()) {
                    iterator.remove();
                    connection.handleDisconnection();
                    continue;
                }
                if (connection.getPacketListener() instanceof ServerGamePacketListenerImpl game && !matches(game.player)) continue;
                connection.tick();
            }
        }
    }

    /**
     * Turns the Bot to the requested direction, mirrors its state onto the camera client, and fetches the
     * next frame rendered after that state applied. The preparation runs on the server thread; only the
     * client request is asynchronous.
     */
    public CompletionStage<RuntimeCameraCapture> capture(RuntimeCameraRequest view) {
        ServerPlayer camera = cameraPlayer().orElse(null);
        if (camera == null) return CompletableFuture.failedFuture(new RuntimeCameraUnavailableException("Camera client is not connected"));
        BotPlayer bot = RuntimeBotManager.current(server).orElse(null);
        if (bot == null || !bot.isAlive()) return CompletableFuture.failedFuture(new RuntimeCameraUnavailableException("Runtime Bot is unavailable"));
        Float yaw = view.yaw();
        Float pitch = view.pitch();
        if (view.targetBlock() != null) {
            // Only the direction to the block center is used, as in vanilla LookControl; the block need not be
            // known, loaded or visible.
            Vec3 from = bot.getEyePosition();
            var target = view.targetBlock();
            double dx = target.x() + 0.5 - from.x;
            double dy = target.y() + 0.5 - from.y;
            double dz = target.z() + 0.5 - from.z;
            double horizontal = Math.sqrt(dx * dx + dz * dz);
            yaw = (float) (Mth.atan2(dz, dx) * Mth.RAD_TO_DEG) - 90.0F;
            pitch = (float) -(Mth.atan2(dy, horizontal) * Mth.RAD_TO_DEG);
        }
        if (yaw != null) {
            float wrapped = Mth.wrapDegrees(yaw);
            bot.setYRot(wrapped);
            bot.setYHeadRot(wrapped);
        }
        if (pitch != null) bot.setXRot(pitch);
        maintain(RuntimeSimulationControl.suspended(server));
        mirror(camera, bot);
        int barrier = nextBarrier++;
        camera.connection.send(new ClientboundPingPacket(barrier));
        Vec3 eye = bot.getEyePosition();
        String dimension = bot.level().dimension().location().toString();
        float capturedYaw = bot.getYRot();
        float capturedPitch = bot.getXRot();
        long tick = server.getTickCount();
        HttpRequest request = HttpRequest.newBuilder(endpoint.resolve(
                        "capture?barrier=" + barrier + "&timeout_ms=" + CLIENT_CAPTURE_TIMEOUT_MILLIS))
                .timeout(Duration.ofMillis(CLIENT_CAPTURE_TIMEOUT_MILLIS + 5_000))
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        return http.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray()).thenApply(response -> {
            if (response.statusCode() != 200) {
                throw new IllegalStateException("Camera capture failed with HTTP " + response.statusCode() + ": "
                        + new String(response.body(), java.nio.charset.StandardCharsets.UTF_8));
            }
            int width = Integer.parseInt(response.headers().firstValue("X-Image-Width").orElseThrow());
            int height = Integer.parseInt(response.headers().firstValue("X-Image-Height").orElseThrow());
            return new RuntimeCameraCapture(response.body(), width, height, dimension, eye.x, eye.y, eye.z, capturedYaw, capturedPitch, tick,
                    view.targetBlock());
        });
    }

    /** Places the camera's eye exactly at the Bot's eye with the given view direction. */
    private static void follow(ServerPlayer camera, BotPlayer bot, float yaw, float pitch) {
        Vec3 eye = bot.getEyePosition();
        double y = eye.y - camera.getEyeHeight();
        ServerLevel level = bot.serverLevel();
        if (camera.serverLevel() != level) {
            camera.teleportTo(level, eye.x, y, eye.z, yaw, pitch);
            return;
        }
        boolean moved = camera.position().distanceToSqr(eye.x, y, eye.z) > 1.0E-6;
        boolean turned = Math.abs(Mth.wrapDegrees(camera.getYRot() - yaw)) > 0.01F || Math.abs(camera.getXRot() - pitch) > 0.01F;
        if (moved || turned) camera.connection.teleport(eye.x, y, eye.z, yaw, pitch);
    }

    /** Sends the Bot's player state to the camera client as if it were the camera's own. */
    private void mirror(ServerPlayer camera, BotPlayer bot) {
        var menu = bot.inventoryMenu;
        camera.connection.send(new ClientboundContainerSetContentPacket(
                menu.containerId, menu.getStateId(), menu.getItems(), ItemStack.EMPTY));
        camera.connection.send(new ClientboundSetCarriedItemPacket(bot.getInventory().selected));
        camera.connection.send(new ClientboundSetHealthPacket(
                bot.getHealth(), bot.getFoodData().getFoodLevel(), bot.getFoodData().getSaturationLevel()));
        camera.connection.send(new ClientboundSetExperiencePacket(
                bot.experienceProgress, bot.totalExperience, bot.experienceLevel));
        Set<Holder<MobEffect>> current = new HashSet<>();
        for (MobEffectInstance effect : bot.getActiveEffects()) {
            current.add(effect.getEffect());
            camera.connection.send(new ClientboundUpdateMobEffectPacket(camera.getId(), effect, false));
        }
        for (Holder<MobEffect> stale : mirroredEffects) {
            if (!current.contains(stale)) camera.connection.send(new ClientboundRemoveMobEffectPacket(camera.getId(), stale));
        }
        mirroredEffects.clear();
        mirroredEffects.addAll(current);
        List<SynchedEntityData.DataValue<?>> values = new ArrayList<>();
        for (SynchedEntityData.DataItem<?> item : ((SynchedEntityDataAccess) bot.getEntityData()).mcagent$itemsById()) {
            values.add(item.value());
        }
        camera.connection.send(new ClientboundSetEntityDataPacket(camera.getId(), values));
    }
}
