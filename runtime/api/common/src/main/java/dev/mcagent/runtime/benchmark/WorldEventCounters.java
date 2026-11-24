package dev.mcagent.runtime.benchmark;

import net.minecraft.server.MinecraftServer;
import java.util.Map;
import java.util.WeakHashMap;

/** Server-lifetime authority observations, never published as Agent World Knowledge. */
public final class WorldEventCounters {
    public record Counts(long portalActivations, long actorDeaths) {}
    private static final Map<MinecraftServer, Counts> COUNTS = new WeakHashMap<>();
    private WorldEventCounters() {}

    public static synchronized void recordPortalActivation(MinecraftServer server) {
        Counts before = counts(server);
        COUNTS.put(server, new Counts(before.portalActivations() + 1, before.actorDeaths()));
    }

    public static synchronized void recordActorDeath(MinecraftServer server) {
        Counts before = counts(server);
        COUNTS.put(server, new Counts(before.portalActivations(), before.actorDeaths() + 1));
    }

    public static synchronized Counts counts(MinecraftServer server) {
        return COUNTS.getOrDefault(server, new Counts(0, 0));
    }
}
