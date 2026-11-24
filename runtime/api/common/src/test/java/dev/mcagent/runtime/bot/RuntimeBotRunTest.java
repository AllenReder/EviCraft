package dev.mcagent.runtime.bot;

import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

class RuntimeBotRunTest {

    @Test
    void oneWorldRunKeepsOneBotIdentity() {
        UUID uuid = UUID.fromString("11111111-1111-4111-8111-111111111111");

        RuntimeBotRun run = RuntimeBotRun.start(() -> uuid, "HarnessBot");

        assertEquals(new RuntimeBotRun.Identity(uuid, "HarnessBot"), run.identity());
        assertEquals(run.identity(), run.identity());
    }

    @Test
    void aNewWorldRunMintsANewBotIdentity() {
        RuntimeBotRun first = RuntimeBotRun.start(
                () -> UUID.fromString("11111111-1111-4111-8111-111111111111"), "bot");
        RuntimeBotRun second = RuntimeBotRun.start(
                () -> UUID.fromString("22222222-2222-4222-8222-222222222222"), "bot");

        assertNotEquals(first.identity().uuid(), second.identity().uuid());
        assertEquals("bot", second.identity().name());
    }
}
