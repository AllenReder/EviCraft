package dev.mcagent.runtime.sdk;


import net.minecraft.server.MinecraftServer;

import java.util.IdentityHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
/**
 * World Run-local control of whether Minecraft simulation advances.
 *
 * <p>The decision is taken once before every tick. A held World Run never advances. With pause-when-idle
 * enabled, a World Run that is not held advances only while there is demand: a tool call in progress, a
 * pending tick wait, or a Bot that is dead or respawning. Calls are made on the server thread.
 */
public interface RuntimeSimulationControl {

    /** Environment switch for pause-when-idle; the World Run reads it once at start. */
    String PAUSE_WHEN_IDLE_ENV = "EVICRAFT_RUNTIME_PAUSE_WHEN_IDLE";

    /** Holds the World Run; returns whether simulation is suspended afterwards. */
    boolean suspend();

    static RuntimeSimulationControl forServer(MinecraftServer server) {
        synchronized (SERVERS) {
            return SERVERS.computeIfAbsent(server, RuntimeWorldLifecycle::new);
        }
    }

    static boolean suspended(MinecraftServer server) {
        synchronized (SERVERS) {
            RuntimeSimulationControl control = SERVERS.get(server);
            return control != null && control.simulationSuspended();
        }
    }

    static void stop(MinecraftServer server) {
        RuntimeSimulationControl control;
        synchronized (SERVERS) { control = SERVERS.remove(server); }
        if (control != null) control.close();
    }

    Map<MinecraftServer, RuntimeSimulationControl> SERVERS = new IdentityHashMap<>();

    default boolean pausesWhenIdle() { return false; }
    /**
     * Runs {@code listener} each time the World Run comes to rest: it has no demand left, and since the last
     * rest a tick ran or a tool call finished. A held World Run does not come to rest.
     */
    default void onRest(Runnable listener) {}
    /** Reports a finished tool call; one that needed no game time still brings the World Run to rest. */
    default void toolCallFinished() {}
    /** Adds a source of demand, polled before each tick. */
    default void addDemand(java.util.function.BooleanSupplier source) {}
    /** Completes with the server tick once {@code ticks} further ticks have run; a pending wait is demand. */
    default CompletionStage<Long> waitTicks(long ticks) { return CompletableFuture.failedFuture(new IllegalStateException("Tick waits are unavailable")); }
    default CompletionStage<RuntimeObservation> observe() { return CompletableFuture.failedFuture(new IllegalStateException("Runtime Bot is unavailable")); }
    /** Completes once the server tick passes {@code afterTick}. It only watches: it is not demand. */
    default CompletionStage<Long> waitForTick(long afterTick) { return CompletableFuture.failedFuture(new IllegalStateException("Tick waits are unavailable")); }
    /** The server tick of the last completed simulation step. */
    default long serverTick() { return 0; }
    default <T> CompletionStage<T> atStablePoint(java.util.function.Supplier<T> operation) {
        try { return CompletableFuture.completedFuture(operation.get()); }
        catch (RuntimeException failure) { return CompletableFuture.failedFuture(failure); }
    }
    record Diagnostics(boolean paused, boolean inSimulationTick, long serverTick, long knowledgeRevision,
                       int pendingObservations, int pendingTickWaiters, int deliveredChunks, int pendingChunks, int pendingStableOperations) {}
    default Diagnostics diagnostics() { return new Diagnostics(simulationSuspended(), false, 0, 0, 0, 0, 0, 0, 0); }
    default void beforeTick() {}
    default void afterTick() {}
    default void close() {}

    /** Releases the hold; returns whether simulation is still suspended (an idle World Run stays paused). */
    boolean resume();

    boolean simulationSuspended();

    static RuntimeSimulationControl standalone() {
        return new State();
    }

    /** Mutable state holder for one World Run. */
    final class State implements RuntimeSimulationControl {
        private boolean suspended;

        @Override public boolean suspend() {
            suspended = true;
            return true;
        }

        @Override public boolean resume() {
            suspended = false;
            return false;
        }

        @Override public boolean simulationSuspended() {
            return suspended;
        }

        @Override public CompletionStage<Long> waitTicks(long ticks) {
            return CompletableFuture.completedFuture(ticks);
        }
    }
}
