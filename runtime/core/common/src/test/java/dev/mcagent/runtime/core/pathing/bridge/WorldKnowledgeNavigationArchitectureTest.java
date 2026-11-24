package dev.mcagent.runtime.core.pathing.bridge;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Source boundary pins for Runtime navigation's profile-neutral World Knowledge adapter. */
class WorldKnowledgeNavigationArchitectureTest {

    @Test
    void runtimePlanningAdapterHasNoConcreteSourceOrLiveWorldFallback() throws IOException {
        String source = source("dev/mcagent/runtime/core/pathing/bridge/WorldKnowledgeContextProvider.java");

        assertTrue(source.contains("RuntimeBotManager.knowledge"));
        assertTrue(source.contains("SPAWNER_CAPTURE_RADIUS_BLOCKS"));
        assertTrue(source.contains("EntityKnowledgeSelection.avoidanceCenters"));
        assertFalse(source.contains("EmbodiedWorldEvidence"));
        assertFalse(source.contains("LoadedWorldKnowledge"));
        assertFalse(source.contains("WorldKnowledgeProfile"));
        assertFalse(source.contains("getBlockState("));
        assertFalse(source.contains("getChunkNow("));
        assertFalse(source.contains("getBlockEntities("));
    }

    @Test
    void runtimeEntityConsumersUseOnlyEntityKnowledgeForDiscoveryAndBinding() throws IOException {
        String collect = source("dev/mcagent/runtime/core/task/collect/CollectItemsTask.java");
        assertTrue(collect.contains("RuntimeBotManager.knowledge"));
        assertTrue(collect.contains("EntityKnowledgeSelection.selectTargets"));
        assertFalse(collect.contains("listEntityEvidence"));

        String attack = source("dev/mcagent/runtime/core/task/combat/AttackTask.java");
        assertTrue(attack.contains("RuntimeBotManager.knowledge"));
        assertTrue(attack.contains("EntityKnowledgeSelection.selectTargets"));
        assertTrue(attack.contains("player.position(), (double) FIELD_RADIUS"));

        String interact = source("dev/mcagent/runtime/core/task/interact/InteractEntityTask.java");
        assertTrue(interact.contains("RuntimeBotManager.knowledge"));

        for (String consumer : java.util.List.of(collect, attack, interact)) {
            assertFalse(consumer.contains("EntityEvidenceSource"));
            assertFalse(consumer.contains("WorldKnowledgeProfile"));
            assertFalse(consumer.contains("LoadedWorldKnowledge"));
            assertFalse(consumer.contains("EmbodiedWorldEvidence"));
        }

        assertFalse(source("dev/mcagent/runtime/core/combat/Menace.java")
                .contains("getEntitiesOfClass"));
    }

    @Test
    void runtimeGenericAvoidanceUsesTheCapturedEntityFacet() throws IOException {
        String avoidance = source("dev/mcagent/runtime/core/pathing/astar/Avoidance.java");
        assertTrue(avoidance.contains("context.entityAvoidanceCenters"));
        assertFalse(avoidance.contains("getAllEntities()"));
    }

    @Test
    void runtimePlayerNavUsesTheWorldKnowledgeAdapter() throws IOException {
        String source = source("dev/mcagent/runtime/core/pathing/execute/PlayerNav.java");

        assertTrue(source.contains("new dev.mcagent.runtime.core.pathing.bridge."
                + "WorldKnowledgeContextProvider()"));
        assertFalse(source.contains("EmbodiedContextProvider"));
    }

    @Test
    void runtimeDiscoveryAndPosePlanningDoNotReadLiveBlockFacts() throws IOException {
        String discovery = source("dev/mcagent/runtime/core/task/move/NearestBlockFinder.java");
        assertTrue(discovery.contains("RuntimeBotManager.currentDimension"));
        assertTrue(discovery.contains("RuntimeBotManager.knowledge"));
        assertFalse(discovery.contains("player.level().dimension()"));

        String interaction = source("dev/mcagent/runtime/core/task/interact/"
                + "GotoBlockInteractionPoseTask.java");
        assertFalse(method(interaction, "protected void onStart()", "protected TaskState onTick()")
                .contains("getBlockState("));

        String placement = source("dev/mcagent/runtime/core/task/interact/"
                + "GotoBlockPlacementPoseTask.java");
        String planning = method(placement, "protected void onStart()", "static Set<BlockPos>");
        assertFalse(planning.contains("getBlockState("));
    }

    @Test
    void productionPlanningHasNoOrdinaryFallback() throws IOException {
        String playerNav = source("dev/mcagent/runtime/core/pathing/execute/PlayerNav.java");
        assertFalse(playerNav.contains("ContextProvider.DEFAULT"));
        assertFalse(playerNav.contains("GoalCompiler.block(player.level()"));

        String avoidance = source("dev/mcagent/runtime/core/pathing/astar/Avoidance.java");
        assertFalse(avoidance.contains("spawnersInLoadedChunks"));
        assertFalse(avoidance.contains("getChunkNow("));

        String discovery = source("dev/mcagent/runtime/core/task/move/NearestBlockFinder.java");
        assertFalse(discovery.contains("runtimeKnowledge"));
        assertFalse(discovery.contains("BlockSearch"));
        assertFalse(discovery.contains("ServerLevel"));

        String execution = source("dev/mcagent/runtime/core/pathing/execute/ExecHarness.java");
        assertFalse(execution.contains("RuntimeBotManager.isRuntimeBot(player)"));
        assertFalse(execution.contains("BlockEvidenceCell.loadedWorldState"));
    }

    @Test
    void tasksPublishWorldUpdatesOnlyThroughPva() throws IOException {
        Path taskRoot = Path.of("src/main/java/dev/mcagent/runtime/core/task");
        try (var files = Files.walk(taskRoot)) {
            List<Path> offenders = files
                    .filter(path -> path.toString().endsWith(".java"))
                    .filter(path -> !path.endsWith("PhysicalVerificationAuthority.java"))
                    .filter(path -> {
                        String source = read(path);
                        return source.contains("AttributableWorldUpdate")
                                || source.contains("RuntimeBotManager.publishAttributable")
                                || source.contains("RuntimeBotManager.recordAttributable");
                    })
                    .map(taskRoot::relativize)
                    .sorted()
                    .toList();
            assertTrue(offenders.isEmpty(), () -> "Task-side World Knowledge publishers: " + offenders);
        }
    }

    @Test
    void taskFactoryRegistersOnlyCallableRuntimeTools() throws IOException {
        String core = source("dev/mcagent/runtime/core/RuntimeCore.java");
        for (String unregistered : List.of(
                "FollowTaskRecord.class", "MineBlockTaskRecord.class",
                "FishTaskRecord.class", "BuildTaskRecord.class",
                "LocateStructureTaskRecord.class", "LocateBiomeTaskRecord.class")) {
            assertFalse(core.contains("TaskFactory.register(" + unregistered),
                    () -> "uncallable ordinary task runner: " + unregistered);
        }
    }

    @Test
    void ordinaryScannersHaveNoProductionEntrypoint() throws IOException {
        String mixins = Files.readString(Path.of("src/main/resources/mc_agent.mixins.json"));
        assertFalse(mixins.contains("ServerLevelBlockChangeMixin"));
        assertFalse(Files.exists(Path.of("src/main/java/dev/mcagent/runtime/core/mixin/"
                + "ServerLevelBlockChangeMixin.java")));
    }

    @Test
    void everyRuntimeWorldFactConsumerRejectsConcreteAndLiveDiscoveryAuthorities()
            throws IOException {
        for (String relative : List.of(
                "dev/mcagent/runtime/core/pathing/bridge/WorldKnowledgeContextProvider.java",
                "dev/mcagent/runtime/core/pathing/execute/PlayerNav.java",
                "dev/mcagent/runtime/core/pathing/goal/GoalCompiler.java",
                "dev/mcagent/runtime/core/pathing/astar/Avoidance.java",
                "dev/mcagent/runtime/core/task/move/NearestBlockFinder.java",
                "dev/mcagent/runtime/core/task/collect/CollectItemsTask.java",
                "dev/mcagent/runtime/core/task/combat/AttackTask.java",
                "dev/mcagent/runtime/core/task/interact/InteractEntityTask.java")) {
            String consumer = source(relative);
            for (String forbidden : List.of(
                    "EmbodiedWorldEvidence", "LoadedWorldKnowledge", "WorldKnowledgeProfile",
                    "EntityEvidenceSource", "getAllEntities()", "getEntitiesOfClass(",
                    "getChunkNow(", "getBlockEntities(", "BlockSearch.start(")) {
                assertFalse(consumer.contains(forbidden),
                        () -> relative + " uses forbidden authority " + forbidden);
            }
        }
    }

    private static String source(String relative) throws IOException {
        return Files.readString(Path.of("src/main/java").resolve(relative));
    }

    private static String read(Path path) {
        try {
            return Files.readString(path);
        } catch (IOException exception) {
            throw new AssertionError("failed to read " + path, exception);
        }
    }

    private static String method(String source, String start, String end) {
        return source.substring(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    }
}
