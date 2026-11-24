package dev.mcagent.runtime.sdk;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RuntimeSdkConfigTest {

    @Test
    void defaultsToLoopbackPortWhenBearerTokenExists() {
        RuntimeSdkConfig config = RuntimeSdkConfig.from(Map.of(
                "EVICRAFT_RUNTIME_BEARER_TOKEN", "secret"
        )).orElseThrow();

        assertEquals("127.0.0.1", config.host());
        assertEquals(8765, config.port());
        assertEquals("secret", config.bearerToken());
    }

    @Test
    void environmentCanOverridePort() {
        RuntimeSdkConfig config = RuntimeSdkConfig.from(Map.of(
                "EVICRAFT_RUNTIME_BEARER_TOKEN", "secret",
                "EVICRAFT_RUNTIME_PORT", "18765"
        )).orElseThrow();

        assertEquals(18765, config.port());
    }

    @Test
    void missingOrBlankBearerTokenDisablesEndpoint() {
        assertTrue(RuntimeSdkConfig.from(Map.of()).isEmpty());
        assertTrue(RuntimeSdkConfig.from(Map.of(
                "EVICRAFT_RUNTIME_BEARER_TOKEN", "  "
        )).isEmpty());
    }

    @Test
    void invalidPortIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> RuntimeSdkConfig.from(Map.of(
                "EVICRAFT_RUNTIME_BEARER_TOKEN", "secret",
                "EVICRAFT_RUNTIME_PORT", "0"
        )));
    }
}
