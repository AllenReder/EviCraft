package dev.mcagent.runtime.bot;

import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.OptionalInt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RuntimeBotViewDistanceTest {

    @Test
    void omittedConfigurationUsesTheServerViewDistance() {
        RuntimeBotViewDistance distance = RuntimeBotViewDistance.from(Map.of(), 10);

        assertEquals(OptionalInt.empty(), distance.configured());
        assertEquals(10, distance.requested());
        assertEquals(10, distance.effective());
    }

    @Test
    void gameTestServerZeroSentinelUsesTheVanillaMinimum() {
        RuntimeBotViewDistance distance = RuntimeBotViewDistance.from(Map.of(), 0);

        assertEquals(OptionalInt.empty(), distance.configured());
        assertEquals(2, distance.requested());
        assertEquals(2, distance.effective());
    }

    @Test
    void explicitConfigurationUsesMinecraftChunkColumnRadiusUnits() {
        RuntimeBotViewDistance distance = RuntimeBotViewDistance.from(Map.of(
                "EVICRAFT_RUNTIME_VIEW_DISTANCE", "6"
        ), 10);

        assertEquals(OptionalInt.of(6), distance.configured());
        assertEquals(6, distance.requested());
        assertEquals(6, distance.effective());
    }

    @Test
    void serverLimitClampsTheEffectiveDistanceWithoutChangingTheRequest() {
        RuntimeBotViewDistance distance = RuntimeBotViewDistance.from(Map.of(
                "EVICRAFT_RUNTIME_VIEW_DISTANCE", "20"
        ), 10);

        assertEquals(OptionalInt.of(20), distance.configured());
        assertEquals(20, distance.requested());
        assertEquals(10, distance.effective());
    }

    @Test
    void valuesBelowTheVanillaMinimumAreRejected() {
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> RuntimeBotViewDistance.from(Map.of(
                        "EVICRAFT_RUNTIME_VIEW_DISTANCE", "1"
                ), 10));

        assertEquals("EVICRAFT_RUNTIME_VIEW_DISTANCE must be at least 2",
                failure.getMessage());
    }

    @Test
    void malformedConfigurationIsRejected() {
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> RuntimeBotViewDistance.from(Map.of(
                        "EVICRAFT_RUNTIME_VIEW_DISTANCE", "far"
                ), 10));

        assertEquals("EVICRAFT_RUNTIME_VIEW_DISTANCE must be an integer",
                failure.getMessage());
    }
}
