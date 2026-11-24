package dev.mcagent.runtime.bot;

import dev.mcagent.runtime.Constants;
import dev.mcagent.runtime.entity.BotPlayer;
import net.minecraft.core.SectionPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ChunkTrackingView;
import net.minecraft.server.level.ClientInformation;

import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/** Owns World Run-fixed Runtime Bot Server Tracking configuration and diagnostics. */
public final class RuntimeBotTracking {

    private static final Map<MinecraftServer, RuntimeBotViewDistance> VIEW_DISTANCES =
            new IdentityHashMap<>();

    private RuntimeBotTracking() {}

    public static void start(MinecraftServer server, Map<String, String> environment) {
        Objects.requireNonNull(server, "server");
        Objects.requireNonNull(environment, "environment");
        if (VIEW_DISTANCES.containsKey(server)) return;
        RuntimeBotViewDistance distance = RuntimeBotViewDistance.from(
                environment, server.getPlayerList().getViewDistance());
        VIEW_DISTANCES.put(server, distance);
        Constants.LOG.info(
                "[mc_agent-runtime] Runtime Bot tracking configured_view_distance={} "
                        + "requested_view_distance={} effective_view_distance={}",
                distance.configured().isPresent()
                        ? distance.configured().getAsInt() : "default",
                distance.requested(), distance.effective());
    }

    public static ClientInformation clientInformation(MinecraftServer server) {
        RuntimeBotViewDistance distance = distance(server);
        ClientInformation defaults = ClientInformation.createDefault();
        return new ClientInformation(defaults.language(), distance.requested(),
                defaults.chatVisibility(), defaults.chatColors(),
                defaults.modelCustomisation(), defaults.mainHand(),
                defaults.textFilteringEnabled(), defaults.allowsListing());
    }

    /** Synchronize vanilla tracking immediately after any externally or physically changed SectionPos. */
    public static void sync(BotPlayer body) {
        Objects.requireNonNull(body, "body");
        if (body.level() instanceof net.minecraft.server.level.ServerLevel level
                && SectionPos.of(body).asLong() != body.getLastSectionPos().asLong()) {
            body.connection.resetPosition();
            level.getChunkSource().move(body);
        }
    }

    public static Optional<RuntimeBotTrackingDiagnostics> diagnostics(
            MinecraftServer server, BotPlayer body) {
        RuntimeBotViewDistance distance = VIEW_DISTANCES.get(
                Objects.requireNonNull(server, "server"));
        if (distance == null) return Optional.empty();
        Optional<RuntimeBotTrackingDiagnostics.TrackingState> tracking = Optional.empty();
        if (body != null
                && body.getChunkTrackingView() instanceof ChunkTrackingView.Positioned positioned) {
            RuntimeBotChunkDeliveryView delivery =
                    (RuntimeBotChunkDeliveryView) body.connection.chunkSender;
            tracking = Optional.of(new RuntimeBotTrackingDiagnostics.TrackingState(
                    body.level().dimension().location().toString(),
                    SectionPos.of(body), positioned.center(), positioned.viewDistance(),
                    delivery.pendingChunkCount(), delivery.unacknowledgedBatchCount()));
        }
        int effective = tracking.map(
                RuntimeBotTrackingDiagnostics.TrackingState::viewDistance)
                .orElse(distance.effective());
        return Optional.of(new RuntimeBotTrackingDiagnostics(distance.configured(),
                distance.requested(), effective, tracking));
    }

    public static void stop(MinecraftServer server) {
        VIEW_DISTANCES.remove(Objects.requireNonNull(server, "server"));
    }

    private static RuntimeBotViewDistance distance(MinecraftServer server) {
        RuntimeBotViewDistance distance = VIEW_DISTANCES.get(
                Objects.requireNonNull(server, "server"));
        if (distance == null) {
            throw new IllegalStateException("Runtime Bot tracking has not started for this World Run");
        }
        return distance;
    }
}
