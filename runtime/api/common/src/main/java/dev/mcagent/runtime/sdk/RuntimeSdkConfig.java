package dev.mcagent.runtime.sdk;

import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/** Environment-derived configuration for the loopback Runtime SDK endpoint. */
public record RuntimeSdkConfig(String host, int port, String bearerToken) {

    public static final String LOOPBACK_HOST = "127.0.0.1";
    public static final int DEFAULT_PORT = 8765;

    public RuntimeSdkConfig {
        Objects.requireNonNull(host, "host");
        Objects.requireNonNull(bearerToken, "bearerToken");
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("Runtime SDK port must be between 1 and 65535");
        }
    }

    /** Empty means the mandatory bearer token is absent and the endpoint must not start. */
    public static Optional<RuntimeSdkConfig> from(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        String token = environment.get("EVICRAFT_RUNTIME_BEARER_TOKEN");
        if (token == null || token.isBlank()) {
            return Optional.empty();
        }
        String rawPort = environment.get("EVICRAFT_RUNTIME_PORT");
        int port = rawPort == null || rawPort.isBlank() ? DEFAULT_PORT : parsePort(rawPort);
        return Optional.of(new RuntimeSdkConfig(LOOPBACK_HOST, port, token));
    }

    private static int parsePort(String rawPort) {
        try {
            return Integer.parseInt(rawPort.trim());
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("EVICRAFT_RUNTIME_PORT must be an integer", error);
        }
    }
}
