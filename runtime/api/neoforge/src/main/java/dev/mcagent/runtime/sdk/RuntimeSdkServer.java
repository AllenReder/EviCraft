package dev.mcagent.runtime.sdk;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.transport.LoopbackRpcServer;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.damagesource.DamageSource;

import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;

/** Runtime SDK endpoint composed from the shared loopback RPC transport. */
public final class RuntimeSdkServer implements AutoCloseable {

    private final MinecraftServer minecraftServer;
    private final RuntimeRpcDispatcher dispatcher;
    private final LoopbackRpcServer transport;
    private final AtomicLong occurrenceSequence = new AtomicLong();
    private String lastLifecycle;
    private RuntimeBodyStateSnapshot lastBodyState;
    private long lastBodyStateTick = Long.MIN_VALUE;

    public RuntimeSdkServer(MinecraftServer minecraftServer, RuntimeSdkConfig config,
                            RuntimeRpcDispatcher dispatcher) {
        this.minecraftServer = Objects.requireNonNull(minecraftServer, "minecraftServer");
        Objects.requireNonNull(config, "config");
        this.dispatcher = Objects.requireNonNull(dispatcher, "dispatcher");
        this.transport = new LoopbackRpcServer(minecraftServer, config.host(), config.port(),
                config.bearerToken(), "SDK", (frame, receivedNanos) -> dispatcher.dispatchAsync(frame),
                new LoopbackRpcServer.SessionListener() {
                    @Override public void opened(long sessionId) { RuntimeSdkServer.this.dispatcher.sessionOpened(sessionId); }
                    @Override public void closed(long sessionId) { RuntimeSdkServer.this.dispatcher.sessionClosed(sessionId); }
                });
    }

    public void start() throws InterruptedException {
        transport.start();
    }


    /** Publish live factual Runtime Occurrences from the server thread. */
    public void tick() {
        RuntimeActorView actor = RuntimeBotManager.view(minecraftServer);
        if (actor == null) {
            lastLifecycle = null;
            lastBodyState = null;
            lastBodyStateTick = Long.MIN_VALUE;
            return;
        }
        long serverTick = minecraftServer.getTickCount();
        String lifecycle = actor.lifecycle().name().toLowerCase(java.util.Locale.ROOT);
        if (!Objects.equals(lastLifecycle, lifecycle)) {
            JsonObject data = new JsonObject();
            data.addProperty("uuid", actor.uuid().toString());
            data.addProperty("name", actor.name());
            data.addProperty("lifecycle_state", lifecycle);
            publishOccurrence("actor_lifecycle_changed", serverTick, data);
            lastLifecycle = lifecycle;
        }

        BotPlayer body = RuntimeBotManager.current(minecraftServer).orElse(null);
        if (body == null) return;
        RuntimeBodyStateSnapshot currentBodyState = RuntimeBodyStateSnapshot.capture(body);
        if (lastBodyState == null || !currentBodyState.equals(lastBodyState)
                && (!currentBodyState.differsOnlyInHealthOrAir(lastBodyState)
                || serverTick - lastBodyStateTick >= 20)) {
            if (publishOccurrence("body_state_changed", serverTick, currentBodyState.toJson())) {
                lastBodyState = currentBodyState;
                lastBodyStateTick = serverTick;
            }
        }
    }

    public void recordDamage(float amount, DamageSource source, float health, float maxHealth,
                             long serverTick) {
        if (amount <= 0.0F) return;
        JsonObject data = new JsonObject();
        data.addProperty("amount", amount);
        data.addProperty("health", health);
        data.addProperty("max_health", maxHealth);
        data.addProperty("damage_type", damageType(source));
        publishOccurrence("damage_received", serverTick, data);
    }

    @Override public void close() {
        transport.close();
    }

    private boolean publishOccurrence(String type, long serverTick, JsonObject data) {
        JsonObject params = new JsonObject();
        params.addProperty("type", type);
        params.addProperty("sequence", occurrenceSequence.incrementAndGet());
        params.addProperty("server_tick", serverTick);
        params.add("data", data);
        JsonObject notification = new JsonObject();
        notification.addProperty("jsonrpc", "2.0");
        notification.addProperty("method", "runtime.occurrence");
        notification.add("params", params);
        return transport.send(notification);
    }

    private static String damageType(DamageSource source) {
        if (source == null) return "minecraft:generic";
        return source.typeHolder().unwrapKey()
                .map(key -> key.location().toString())
                .orElse("minecraft:generic");
    }
}
