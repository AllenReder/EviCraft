package dev.mcagent.runtime.benchmark;

import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/** Environment-derived configuration for the separate Benchmark Authority endpoint. */
public record BenchmarkAuthorityConfig(String host, int port, String bearerToken) {

    public static final String LOOPBACK_HOST = "127.0.0.1";
    public static final int DEFAULT_PORT = 8766;

    public BenchmarkAuthorityConfig {
        Objects.requireNonNull(host, "host");
        Objects.requireNonNull(bearerToken, "bearerToken");
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("Benchmark Authority port must be between 1 and 65535");
        }
    }

    /** Empty means the optional Authority token is absent and only Authority is disabled. */
    public static Optional<BenchmarkAuthorityConfig> from(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        String token = environment.get("EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN");
        if (token == null || token.isBlank()) return Optional.empty();
        String rawPort = environment.get("EVICRAFT_BENCHMARK_AUTHORITY_PORT");
        int port = rawPort == null || rawPort.isBlank() ? DEFAULT_PORT : parsePort(rawPort);
        return Optional.of(new BenchmarkAuthorityConfig(LOOPBACK_HOST, port, token));
    }

    private static int parsePort(String rawPort) {
        try {
            return Integer.parseInt(rawPort.trim());
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(
                    "EVICRAFT_BENCHMARK_AUTHORITY_PORT must be an integer", error);
        }
    }
}
