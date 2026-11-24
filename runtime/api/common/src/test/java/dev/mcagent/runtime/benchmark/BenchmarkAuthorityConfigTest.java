package dev.mcagent.runtime.benchmark;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BenchmarkAuthorityConfigTest {

    @Test
    void defaultsToLoopbackPortWhenBearerTokenExists() {
        BenchmarkAuthorityConfig config = BenchmarkAuthorityConfig.from(Map.of(
                "EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN", "secret"
        )).orElseThrow();

        assertEquals("127.0.0.1", config.host());
        assertEquals(8766, config.port());
        assertEquals("secret", config.bearerToken());
    }

    @Test
    void environmentCanOverridePort() {
        BenchmarkAuthorityConfig config = BenchmarkAuthorityConfig.from(Map.of(
                "EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN", "secret",
                "EVICRAFT_BENCHMARK_AUTHORITY_PORT", "18766"
        )).orElseThrow();

        assertEquals(18766, config.port());
    }

    @Test
    void missingOrBlankBearerTokenDisablesOnlyAuthority() {
        assertTrue(BenchmarkAuthorityConfig.from(Map.of()).isEmpty());
        assertTrue(BenchmarkAuthorityConfig.from(Map.of(
                "EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN", "  "
        )).isEmpty());
    }

    @Test
    void invalidPortIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> BenchmarkAuthorityConfig.from(Map.of(
                "EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN", "secret",
                "EVICRAFT_BENCHMARK_AUTHORITY_PORT", "0"
        )));
    }
}
