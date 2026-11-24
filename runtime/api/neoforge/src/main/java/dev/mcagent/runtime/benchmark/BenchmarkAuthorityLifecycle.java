package dev.mcagent.runtime.benchmark;

import dev.mcagent.runtime.Constants;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.sdk.RuntimeBuildInfo;
import dev.mcagent.runtime.sdk.RuntimeSimulationControl;
import net.minecraft.SharedConstants;
import net.minecraft.server.MinecraftServer;
import net.neoforged.fml.ModList;

import java.util.IdentityHashMap;
import java.util.Map;
import java.util.concurrent.CompletionStage;

/** Authority transport delegates stable world access to the World Run lifecycle. */
public final class BenchmarkAuthorityLifecycle {

    private static final Map<MinecraftServer, State> SERVERS = new IdentityHashMap<>();

    private BenchmarkAuthorityLifecycle() {}

    public static void start(MinecraftServer minecraftServer) {
        BenchmarkAuthorityConfig.from(System.getenv()).ifPresentOrElse(config -> {
            if (Boolean.parseBoolean(System.getenv("EVICRAFT_TASK_START_PAUSED"))) {
                RuntimeSimulationControl.forServer(minecraftServer).suspend();
            }
            State state = new State(minecraftServer);
            BenchmarkAuthorityServer endpoint = new BenchmarkAuthorityServer(minecraftServer, config,
                    state::enqueue);
            state.endpoint = endpoint;
            state.dispatcher.notifications(endpoint::send);
            RuntimeSimulationControl.forServer(minecraftServer).onRest(state.dispatcher::atRest);
            try {
                endpoint.start();
                SERVERS.put(minecraftServer, state);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                endpoint.close();
                throw new IllegalStateException("Interrupted while starting Benchmark Authority", interrupted);
            } catch (RuntimeException failure) {
                endpoint.close();
                throw failure;
            }
        }, () -> Constants.LOG.info("[mc_agent-runtime] Benchmark Authority disabled: "
                + "EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN is missing"));
    }

    /** Runs after every simulation tick, once the tick's own bookkeeping is complete. */
    public static void tick(MinecraftServer minecraftServer) {
        State state = SERVERS.get(minecraftServer);
        if (state != null) state.dispatcher.afterTick();
    }

    public static int pendingRequests(MinecraftServer minecraftServer) {
        State state = SERVERS.get(minecraftServer);
        return state == null ? 0 : RuntimeSimulationControl.forServer(minecraftServer).diagnostics().pendingStableOperations();
    }

    public static void stop(MinecraftServer minecraftServer) {
        State state = SERVERS.remove(minecraftServer);
        if (state != null) state.close();
    }

    private static final class State implements AutoCloseable {
        private final BenchmarkAuthorityDispatcher dispatcher;
        private final MinecraftServer minecraftServer;
        private BenchmarkAuthorityServer endpoint;

        State(MinecraftServer minecraftServer) {
            this.minecraftServer = minecraftServer;
            dispatcher = new BenchmarkAuthorityDispatcher(minecraftServer, buildInfo(),
                    RuntimeBotManager.worldKnowledgeProfile(minecraftServer),
                    RuntimeBotManager.groundedEvidencePolicy(minecraftServer));
        }

        CompletionStage<String> enqueue(String frame, long receivedNanos) {
            var control = RuntimeSimulationControl.forServer(minecraftServer);
            // Only the RPC identity is logged; params and authentication remain outside diagnostics.
            JsonObject identity = new JsonObject();
            try {
                var request = JsonParser.parseString(frame).getAsJsonObject();
                identity.add("id", request.get("id"));
                identity.add("method", request.get("method"));
            } catch (RuntimeException malformed) {
                // The dispatcher still owns protocol errors.
            }
            long enqueued = System.nanoTime();
            var state = control.diagnostics();
            Constants.LOG.info("[authority_rpc] enqueued={} serverQueueMs={} paused={} inSimulationTick={} serverTick={} pendingStableOperations={}",
                    identity, (enqueued - receivedNanos) / 1_000_000.0, state.paused(), state.inSimulationTick(), state.serverTick(), state.pendingStableOperations());
            return control.atStablePoint(() -> {
                long executing = System.nanoTime();
                Constants.LOG.info("[authority_rpc] executing={} queueMs={}", identity, (executing - enqueued) / 1_000_000.0);
                try { return dispatcher.dispatch(frame); }
                finally {
                    Constants.LOG.info("[authority_rpc] completed={} executionMs={}", identity, (System.nanoTime() - executing) / 1_000_000.0);
                }
            });
        }

        @Override public void close() {
            if (endpoint != null) endpoint.close();
        }
    }

    private static RuntimeBuildInfo buildInfo() {
        return new RuntimeBuildInfo(modVersion("mc_agent"), SharedConstants.getCurrentVersion().getName(),
                modVersion("neoforge"));
    }

    private static String modVersion(String modId) {
        return ModList.get().getModContainerById(modId)
                .map(container -> container.getModInfo().getVersion().toString())
                .orElse("unknown");
    }
}
