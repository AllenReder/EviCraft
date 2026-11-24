package dev.mcagent.runtime.sdk;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.bot.RuntimeBotTracking;
import dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTrackerAccess;
import dev.mcagent.runtime.camera.RuntimeCamera;
import dev.mcagent.runtime.mixin.ChunkMapRuntimeMaintenanceAccess;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ChunkTrackingView;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** World Run owner of simulation, explicit observations and control-plane progress.
 * Every entrypoint runs on the Minecraft server thread; no wait blocks that thread. */
final class RuntimeWorldLifecycle implements RuntimeSimulationControl {
    private static final long OBSERVATION_DELIVERY_NANOS = 30_000_000_000L;
    private final MinecraftServer server;
    private final java.util.ArrayDeque<StableOperation<?>> stableOperations = new java.util.ArrayDeque<>();
    private boolean drainingStableOperations;
    private final List<TickWait> ticks = new ArrayList<>();
    private final List<ObservationWait> observations = new ArrayList<>();
    private final List<java.util.function.BooleanSupplier> demand = new ArrayList<>();
    private final List<Runnable> restListeners = new ArrayList<>();
    /** A tick ran or a tool call finished since the World Run last came to rest. */
    private boolean unsettled;
    private final boolean pauseWhenIdle;
    private boolean held;
    private boolean suspended;
    private boolean inTick;
    private boolean closed;

    RuntimeWorldLifecycle(MinecraftServer server) {
        this(server, Boolean.parseBoolean(System.getenv(PAUSE_WHEN_IDLE_ENV)));
    }

    RuntimeWorldLifecycle(MinecraftServer server, boolean pauseWhenIdle) {
        this.server = server;
        this.pauseWhenIdle = pauseWhenIdle;
        this.suspended = pauseWhenIdle;
    }

    @Override public boolean simulationSuspended() { return suspended; }
    @Override public boolean pausesWhenIdle() { return pauseWhenIdle; }
    @Override public long serverTick() { return server.getTickCount(); }
    @Override public void addDemand(java.util.function.BooleanSupplier source) { demand.add(source); }
    @Override public void onRest(Runnable listener) { restListeners.add(listener); }
    @Override public void toolCallFinished() { unsettled = true; }
    @Override public boolean suspend() {
        if (inTick) throw new IllegalStateException("Pause must settle after the simulation step");
        held = true;
        suspended = true;
        return true;
    }
    @Override public boolean resume() {
        if (inTick) throw new IllegalStateException("Resume must settle after the simulation step");
        held = false;
        // What happened under the hold belongs to its holder: the World Run starts settled.
        unsettled = false;
        suspended = idle();
        return suspended;
    }
    /** An idle World Run has nothing that needs game time: no tool call, no tick wait, and a living or absent Bot. */
    private boolean idle() {
        if (!pauseWhenIdle) return false;
        ticks.removeIf(wait -> wait.result.isDone());
        for (TickWait wait : ticks) if (wait.demand) return false;
        for (var source : demand) if (source.getAsBoolean()) return false;
        var actor = RuntimeBotManager.view(server);
        return actor == null || (actor.lifecycle() != RuntimeActorView.Lifecycle.DEAD
                && actor.lifecycle() != RuntimeActorView.Lifecycle.RESPAWNING);
    }
    @Override public CompletionStage<RuntimeObservation> observe() {
        CompletableFuture<RuntimeObservation> result = new CompletableFuture<>();
        if (closed) result.completeExceptionally(new IllegalStateException("World Run closed"));
        else observations.add(new ObservationWait(result, System.nanoTime() + OBSERVATION_DELIVERY_NANOS));
        return result;
    }
    @Override public CompletionStage<Long> waitTicks(long ticks) {
        return tickWait(server.getTickCount() + ticks - 1, true);
    }
    @Override public CompletionStage<Long> waitForTick(long afterTick) {
        return tickWait(afterTick, false);
    }
    private CompletionStage<Long> tickWait(long afterTick, boolean demand) {
        if (closed) return CompletableFuture.failedFuture(new IllegalStateException("World Run closed"));
        if (!inTick && server.getTickCount() > afterTick) return CompletableFuture.completedFuture((long) server.getTickCount());
        CompletableFuture<Long> result = new CompletableFuture<>();
        ticks.add(new TickWait(afterTick, result, demand));
        return result;
    }

    @Override public <T> CompletionStage<T> atStablePoint(java.util.function.Supplier<T> operation) {
        CompletableFuture<T> result = new CompletableFuture<>();
        if (closed) result.completeExceptionally(new IllegalStateException("World Run closed"));
        else {
            stableOperations.addLast(new StableOperation<>(operation, result));
            drainStableOperations();
        }
        return result;
    }

    private void drainStableOperations() {
        if (inTick || drainingStableOperations) return;
        drainingStableOperations = true;
        try {
            StableOperation<?> operation;
            while ((operation = stableOperations.pollFirst()) != null) operation.execute();
        } finally { drainingStableOperations = false; }
    }

    @Override public void beforeTick() {
        maintain();
        // The one place that decides whether this tick runs.
        suspended = held || idle();
        inTick = !suspended;
        if (inTick) unsettled = true;
        else if (unsettled && !held) {
            unsettled = false;
            restListeners.forEach(Runnable::run);
        }
    }
    @Override public void afterTick() {
        // The ordinary frame describes the completed step, before any pause acknowledgement.
        RuntimeBotManager.tick(server);
        inTick = false;
        List<TickWait> completed = new ArrayList<>();
        ticks.removeIf(wait -> { if (wait.result.isDone() || server.getTickCount() > wait.afterTick) { completed.add(wait); return true; } return false; });
        completed.forEach(wait -> wait.result.complete((long) server.getTickCount()));
        maintain();
    }

    private void maintain() {
        drainStableOperations();
        if (closed) return;
        BotPlayer body = RuntimeBotManager.current(server).orElse(null);
        if (body != null && !body.isAlive()) RuntimeBotManager.onDeath(body);
        if (body != null && body.isAlive()) {
            RuntimeBotTracking.sync(body);
            var chunks = body.serverLevel().getChunkSource();
            ((ChunkMapRuntimeMaintenanceAccess) chunks.chunkMap).mcagent$updateTracking(body);
            // pollTask advances loading/generation/light jobs, not ticket age or gameplay.
            for (int i = 0; i < 16 && chunks.pollTask(); i++) { }
            body.connection.chunkSender.sendNextChunks(body);
        }
        RuntimeCamera.of(server).ifPresent(camera -> camera.maintain(suspended));
        for (ObservationWait wait : List.copyOf(observations)) {
            if (wait.result.isDone()) { observations.remove(wait); continue; }
            if (body == null) {
                observations.remove(wait);
                wait.result.completeExceptionally(new IllegalStateException("Runtime Bot is unavailable"));
                continue;
            }
            // A dead Bot is replaced a few ticks later, and the World Run advances meanwhile (idle() is false while
            // DEAD or RESPAWNING). The observation describes the respawned body; its chunk-delivery deadline
            // starts once that body exists.
            if (!body.isAlive()) { wait.deadline = System.nanoTime() + OBSERVATION_DELIVERY_NANOS; continue; }
            if (System.nanoTime() >= wait.deadline) {
                observations.remove(wait);
                wait.result.completeExceptionally(new IllegalStateException("Observation timed out waiting for chunk delivery"));
                continue;
            }
            if (inTick || !delivered(body)) continue;
            observations.remove(wait);
            try {
                long revision = RuntimeBotManager.observe(server);
                wait.result.complete(new RuntimeObservation(revision, server.getTickCount(), body.level().getGameTime()));
            } catch (RuntimeException failure) { wait.result.completeExceptionally(failure); }
        }
    }

    private boolean delivered(BotPlayer body) {
        if (!(body.getChunkTrackingView() instanceof ChunkTrackingView.Positioned view)
                || !view.center().equals(body.chunkPosition())) return false;
        var cache = ((VirtualClientChunkTrackerAccess) body.connection.chunkSender).mcagent$loadedChunkSnapshot();
        if (!body.level().dimension().location().toString().equals(cache.dimension())) return false;
        boolean[] complete = { true };
        view.forEach(position -> { if (!cache.contains(position)) complete[0] = false; });
        return complete[0];
    }

    @Override public Diagnostics diagnostics() {
        var body = RuntimeBotManager.current(server).orElse(null);
        int delivered = body == null ? 0 : ((VirtualClientChunkTrackerAccess) body.connection.chunkSender).mcagent$loadedChunkSnapshot().columns().size();
        int pending = body == null ? 0 : ((dev.mcagent.runtime.bot.RuntimeBotChunkDeliveryView) body.connection.chunkSender).pendingChunkCount();
        return new Diagnostics(suspended, inTick, server.getTickCount(), RuntimeBotManager.observationRevision(server),
                observations.size(), ticks.size(), delivered, pending, stableOperations.size());
    }

    @Override public void close() {
        closed = true;
        var failure = new IllegalStateException("World Run closed");
        failTickWaiters(failure);
        var pendingStable = List.copyOf(stableOperations); stableOperations.clear();
        pendingStable.forEach(operation -> operation.result.completeExceptionally(failure));
        var pending = List.copyOf(observations); observations.clear();
        pending.forEach(wait -> wait.result.completeExceptionally(failure));
    }
    private void failTickWaiters(RuntimeException failure) {
        var pending = List.copyOf(ticks); ticks.clear();
        pending.forEach(wait -> wait.result.completeExceptionally(failure));
    }
    private record StableOperation<T>(java.util.function.Supplier<T> operation, CompletableFuture<T> result) {
        void execute() {
            if (result.isDone()) return;
            try { result.complete(operation.get()); }
            catch (RuntimeException failure) { result.completeExceptionally(failure); }
        }
    }
    /** {@code demand}: the wait itself keeps a pause-when-idle World Run advancing; otherwise it only watches. */
    private record TickWait(long afterTick, CompletableFuture<Long> result, boolean demand) {}
    /** {@code deadline}: when waiting for chunk delivery around a living body gives up. */
    private static final class ObservationWait {
        final CompletableFuture<RuntimeObservation> result;
        long deadline;
        ObservationWait(CompletableFuture<RuntimeObservation> result, long deadline) { this.result = result; this.deadline = deadline; }
    }
}
