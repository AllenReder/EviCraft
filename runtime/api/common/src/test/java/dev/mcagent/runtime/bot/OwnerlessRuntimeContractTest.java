package dev.mcagent.runtime.bot;

import dev.mcagent.runtime.entity.BotPlayer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class OwnerlessRuntimeContractTest {

    @Test
    void botBodyHasNoOwnerStateOrOwnerApi() {
        assertFalse(Arrays.stream(BotPlayer.class.getDeclaredFields())
                .anyMatch(field -> field.getName().toLowerCase().contains("owner")));
        assertFalse(Arrays.stream(BotPlayer.class.getDeclaredMethods())
                .anyMatch(method -> method.getName().toLowerCase().contains("owner")));
    }

    @Test
    void productionBotPlayerConstructionIsRuntimeOwned() throws IOException {
        Path root = Path.of("src/main/java");
        List<String> constructors;
        try (var files = Files.walk(root)) {
            constructors = files
                    .filter(path -> path.toString().endsWith(".java"))
                    .filter(path -> read(path).contains("new BotPlayer("))
                    .map(root::relativize)
                    .map(Path::toString)
                    .sorted()
                    .toList();
        }

        assertEquals(List.of(
                "dev/mcagent/runtime/entity/BotFactory.java",
                "dev/mcagent/runtime/mixin/PlayerListRuntimeBotRespawnMixin.java"),
                constructors);
        String factory = read(root.resolve("dev/mcagent/runtime/entity/BotFactory.java"));
        assertEquals(1, occurrences(factory, "public static BotPlayer spawnFresh("));

        Path runtimeRoot = Path.of("../..").normalize();
        List<String> productionFactoryCallers;
        try (var files = Files.walk(runtimeRoot)) {
            productionFactoryCallers = files
                    .filter(path -> path.toString().contains("/src/main/java/"))
                    .filter(path -> path.toString().endsWith(".java"))
                    .filter(path -> !path.toString().contains("/gametest/"))
                    .filter(path -> read(path).contains("BotFactory.spawnFresh("))
                    .map(runtimeRoot::relativize)
                    .map(Path::toString)
                    .sorted()
                    .toList();
        }
        assertEquals(List.of(
                "api/common/src/main/java/dev/mcagent/runtime/bot/RuntimeBotManager.java"),
                productionFactoryCallers);
    }

    @Test
    void runtimeManagerExposesOnlyWorldKnowledgeAndPvaSeams() throws IOException {
        String manager = read(Path.of("src/main/java/dev/mcagent/runtime/bot/RuntimeBotManager.java"));

        for (String legacy : List.of(
                "WorldKnowledgeQueries", "groundedKnowledge", "blockEvidence(",
                "blockEvidenceSnapshot(", "findBlockEvidence(", "blockEvidenceRegion(",
                "entityEvidence(", "entityEvidenceSnapshot(", "selectEntityTargets(",
                "listEntityEvidence(", "recordAttributableBlock(",
                "recordAttributableEntity(", "removeAttributableEntity(",
                "latestObservationDiagnostics(")) {
            assertFalse(manager.contains(legacy), () -> "legacy RuntimeBotManager seam: " + legacy);
        }
    }

    private static String read(Path path) {
        try {
            return Files.readString(path);
        } catch (IOException exception) {
            throw new AssertionError("failed to read " + path, exception);
        }
    }

    private static int occurrences(String source, String needle) {
        return source.split(java.util.regex.Pattern.quote(needle), -1).length - 1;
    }
}
