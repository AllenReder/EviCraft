package dev.mcagent.runtime.benchmark;

import dev.mcagent.runtime.transport.LoopbackRpcServer;
import net.minecraft.server.MinecraftServer;

import java.util.Objects;
import java.util.concurrent.CompletionStage;

/** Separate Authority listener; it deliberately shares no Runtime SDK controller or credential. */
public final class BenchmarkAuthorityServer implements AutoCloseable {

    private final LoopbackRpcServer transport;

    public BenchmarkAuthorityServer(MinecraftServer minecraftServer, BenchmarkAuthorityConfig config,
                                    LoopbackRpcServer.RequestHandler requests) {
        Objects.requireNonNull(config, "config");
        this.transport = new LoopbackRpcServer(minecraftServer, config.host(), config.port(),
                config.bearerToken(), "Benchmark Authority", requests,
                new LoopbackRpcServer.SessionListener() {
                    @Override public void opened(long sessionId) {}
                    @Override public void closed(long sessionId) {}
                });
    }

    public void start() throws InterruptedException { transport.start(); }

    /** Sends a notification to the connected Authority controller; false when none is connected. */
    public boolean send(com.google.gson.JsonObject notification) { return transport.send(notification); }

    @Override public void close() { transport.close(); }
}
