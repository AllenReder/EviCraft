package dev.mcagent.runtime.sdk;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RuntimeEvidenceRpcTest {

    @Test
    void explicitObservationCompletesWithoutASimulationFrame() {
        CompletableFuture<RuntimeObservation> observation = new CompletableFuture<>();
        RuntimeSimulationControl control = new RuntimeSimulationControl() {
            public boolean suspend() { return true; }
            public boolean resume() { return false; }
            public boolean simulationSuspended() { return true; }
            public CompletionStage<RuntimeObservation> observe() { return observation; }
        };
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("test", "1.21.1", "test"),
                dev.mcagent.runtime.knowledge.WorldKnowledgeProfile.LOADED_WORLD_STATE,
                dev.mcagent.runtime.knowledge.GroundedEvidencePolicy.defaults(),
                new RuntimeActorGateway() {
                    public RuntimeActorView get() { return RuntimeActorView.starting(0); }
                    public RuntimeActorView create(String username) { return get(); }
                }, RuntimeToolGateway.EMPTY, RuntimeEvidenceGateway.EMPTY, control);
        var response = dispatcher.dispatchAsync("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"observation.observe\",\"params\":{}}").toCompletableFuture();
        assertFalse(response.isDone());
        observation.complete(new RuntimeObservation(1, 0, 400));
        var result = JsonParser.parseString(response.join()).getAsJsonObject().getAsJsonObject("result");
        assertEquals(1, result.get("observation_revision").getAsLong());
        assertEquals(0, result.get("server_tick").getAsLong());
        assertEquals(400, result.get("game_time").getAsLong());
    }

    @Test
    void latePreviousSessionCloseDoesNotCancelTheCurrentObservation() {
        java.util.List<CompletableFuture<RuntimeObservation>> requests = new java.util.ArrayList<>();
        RuntimeSimulationControl control = new RuntimeSimulationControl() {
            public boolean suspend() { return true; }
            public boolean resume() { return false; }
            public boolean simulationSuspended() { return true; }
            public CompletionStage<RuntimeObservation> observe() {
                var request = new CompletableFuture<RuntimeObservation>(); requests.add(request); return request;
            }
        };
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("test", "1.21.1", "test"),
                dev.mcagent.runtime.knowledge.WorldKnowledgeProfile.LOADED_WORLD_STATE,
                dev.mcagent.runtime.knowledge.GroundedEvidencePolicy.defaults(),
                new RuntimeActorGateway() {
                    public RuntimeActorView get() { return RuntimeActorView.starting(0); }
                    public RuntimeActorView create(String username) { return get(); }
                }, RuntimeToolGateway.EMPTY, RuntimeEvidenceGateway.EMPTY, control);
        String wire = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"observation.observe\",\"params\":{}}";
        dispatcher.sessionOpened(1);
        var old = dispatcher.dispatchAsync(wire).toCompletableFuture();
        dispatcher.sessionOpened(2);
        assertTrue(old.isDone(), "a replacement controller must release previous requests");
        var current = dispatcher.dispatchAsync(wire).toCompletableFuture();
        dispatcher.sessionClosed(1);
        assertFalse(current.isDone(), "late close of an old controller must not cancel current work");
        requests.get(1).complete(new RuntimeObservation(2, 0, 0));
        assertEquals(2, JsonParser.parseString(current.join()).getAsJsonObject()
                .getAsJsonObject("result").get("observation_revision").getAsLong());
    }

    @Test
    void knowledgeQueryBlockGetReturnsUnknownAndKnownCellsWithoutLiveLookup() {
        RuntimeEvidenceGateway evidence = new RuntimeEvidenceGateway() {
            @Override
            public List<RuntimeBlockEvidence> blockGet(
                    String dimension, List<RuntimeBlockPosition> positions) {
                assertEquals("minecraft:overworld", dimension);
                assertEquals(List.of(
                        new RuntimeBlockPosition(10, 64, -3),
                        new RuntimeBlockPosition(11, 64, -3)
                ), positions);
                return List.of(
                        RuntimeBlockEvidence.unknown(dimension, positions.get(0)),
                        RuntimeBlockEvidence.knownBlock(dimension, positions.get(1),
                                "minecraft:stone", "minecraft:empty", "vision", 120L, 9L)
                );
            }
        };
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(9L),
                RuntimeToolGateway.EMPTY,
                evidence
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatchAsync(
                "{\"jsonrpc\":\"2.0\",\"id\":18,\"method\":\"knowledge.query\",\"params\":{"
                        + "\"operation\":\"block.get\",\"dimension\":\"minecraft:overworld\","
                        + "\"positions\":[{\"x\":10,\"y\":64,\"z\":-3},{\"x\":11,\"y\":64,\"z\":-3}]}}"
        ).toCompletableFuture().join()).getAsJsonObject();

        JsonObject result = response.getAsJsonObject("result");
        assertEquals("block.get", result.get("operation").getAsString());
        assertEquals("UNKNOWN", result.getAsJsonArray("cells").get(0)
                .getAsJsonObject().get("state").getAsString());
        JsonObject known = result.getAsJsonArray("cells").get(1).getAsJsonObject();
        assertEquals("KNOWN_BLOCK", known.get("state").getAsString());
        assertEquals("minecraft:stone", known.get("block_state").getAsString());
        assertEquals("vision", known.get("source").getAsString());
        assertEquals(120L, known.get("observed_tick").getAsLong());
        assertEquals(9L, known.get("observation_revision").getAsLong());
    }

    @Test
    void blockGetRejectsMoreThan256ExactPositions() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(0L),
                RuntimeToolGateway.EMPTY,
                new RuntimeEvidenceGateway() {
                    @Override
                    public List<RuntimeBlockEvidence> blockGet(
                            String dimension, List<RuntimeBlockPosition> positions) {
                        throw new AssertionError("invalid block.get must not reach evidence");
                    }
                }
        );
        JsonArray positions = new JsonArray();
        for (int index = 0; index < 257; index++) {
            JsonObject position = new JsonObject();
            position.addProperty("x", index);
            position.addProperty("y", 64);
            position.addProperty("z", 0);
            positions.add(position);
        }
        JsonObject params = new JsonObject();
        params.addProperty("operation", "block.get");
        params.addProperty("dimension", "minecraft:overworld");
        params.add("positions", positions);
        JsonObject request = new JsonObject();
        request.addProperty("jsonrpc", "2.0");
        request.addProperty("id", 19);
        request.addProperty("method", "knowledge.query");
        request.add("params", params);

        JsonObject response = JsonParser.parseString(dispatcher.dispatchAsync(request.toString())
                .toCompletableFuture().join()).getAsJsonObject();
        assertEquals(-32602, response.getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    void blockFindReturnsOnlyBoundedKnownMatchesWithoutClaimingWorldCompleteness() {
        RuntimeEvidenceGateway evidence = new StubEvidenceGateway() {
            @Override
            public RuntimeBlockFindResult blockFind(
                    String dimension, CanonicalIdentifierMatcher pattern) {
                assertEquals("minecraft:overworld", dimension);
                assertTrue(pattern.matches("minecraft:diamond_ore"));
                assertFalse(pattern.matches("example:diamond_ore"));
                return new RuntimeBlockFindResult(List.of(
                        RuntimeBlockEvidence.knownBlock(dimension,
                                new RuntimeBlockPosition(3, 12, 5),
                                "minecraft:diamond_ore", "minecraft:empty",
                                "vision", 80L, 7L)
                ), true, false);
            }
        };
        RuntimeRpcDispatcher dispatcher = dispatcher(evidence);

        JsonObject response = response(dispatcher,
                "{\"operation\":\"block.find\",\"dimension\":\"minecraft:overworld\","
                        + "\"block_id_glob\":\"minecraft:*_ore\"}");

        JsonObject result = response.getAsJsonObject("result");
        assertEquals("block.find", result.get("operation").getAsString());
        assertEquals("minecraft:diamond_ore", result.getAsJsonArray("matches").get(0)
                .getAsJsonObject().get("block_state").getAsString());
        assertTrue(result.get("has_more").getAsBoolean());
        assertFalse(result.get("complete").getAsBoolean());
    }

    @Test
    void blockFindPassesOptionalOriginAndLimitToTheEvidenceQuery() {
        RuntimeEvidenceGateway evidence = new StubEvidenceGateway() {
            @Override
            public RuntimeBlockFindResult blockFind(
                    String dimension, CanonicalIdentifierMatcher pattern,
                    RuntimeBlockPosition origin, int limit) {
                assertEquals("minecraft:overworld", dimension);
                assertTrue(pattern.matches("minecraft:oak_log"));
                assertEquals(new RuntimeBlockPosition(124, 79, 153), origin);
                assertEquals(32, limit);
                return new RuntimeBlockFindResult(List.of(), false, false);
            }
        };

        JsonObject response = response(dispatcher(evidence),
                "{\"operation\":\"block.find\",\"dimension\":\"minecraft:overworld\","
                        + "\"block_id_glob\":\"minecraft:*_log\","
                        + "\"origin\":{\"x\":124,\"y\":79,\"z\":153},\"limit\":32}");

        assertEquals("block.find", response.getAsJsonObject("result")
                .get("operation").getAsString());
    }

    @Test
    void blockFindUsesOnlyGlobSelectors() {
        RuntimeEvidenceGateway evidence = new StubEvidenceGateway() {
            @Override
            public RuntimeBlockFindResult blockFind(
                    String dimension, CanonicalIdentifierMatcher matcher,
                    RuntimeBlockPosition origin, int limit) {
                assertEquals("minecraft:overworld", dimension);
                assertTrue(matcher.matches("minecraft:oak_log"));
                assertFalse(matcher.matches("example:oak_log"));
                assertEquals(new RuntimeBlockPosition(4, 70, 9), origin);
                assertEquals(32, limit);
                return new RuntimeBlockFindResult(List.of(), false, false);
            }
        };

        JsonObject response = response(dispatcher(evidence),
                "{\"operation\":\"block.find\",\"dimension\":\"minecraft:overworld\","
                        + "\"block_id_glob\":\"minecraft:*_log\","
                        + "\"origin\":{\"x\":4,\"y\":70,\"z\":9},\"limit\":32}");

        assertEquals("block.find", response.getAsJsonObject("result")
                .get("operation").getAsString());
    }

    @Test
    void blockFindRejectsUnsupportedOrOversizedGlobBeforeReadingEvidence() {
        RuntimeRpcDispatcher dispatcher = dispatcher(new StubEvidenceGateway());
        for (String glob : List.of("minecraft:(stone)", "minecraft:stone+",
                "x".repeat(257))) {
            JsonObject response = response(dispatcher,
                    "{\"operation\":\"block.find\",\"dimension\":\"minecraft:overworld\","
                            + "\"block_id_glob\":\"" + glob + "\"}");
            assertEquals(-32602, response.getAsJsonObject("error").get("code").getAsInt());
        }
    }

    @Test
    void blockRegionReturnsPaletteAndXFastestFlattenedIndices() {
        RuntimeEvidenceGateway evidence = new StubEvidenceGateway() {
            @Override
            public RuntimeBlockRegionResult blockRegion(
                    String dimension, BlockKnowledge.RegionBounds bounds) {
                assertEquals(new net.minecraft.core.BlockPos(4, 60, 8), bounds.min());
                assertEquals(new net.minecraft.core.BlockPos(5, 60, 8), bounds.max());
                return new RuntimeBlockRegionResult(dimension,
                        new RuntimeBlockPosition(4, 60, 8),
                        new RuntimeBlockPosition(2, 1, 1), List.of(
                        RuntimeBlockPaletteEntry.unknown(),
                        RuntimeBlockPaletteEntry.knownBlock("minecraft:stone", "minecraft:empty",
                                "contact", 91L, 11L)
                ), List.of(1, 0), false);
            }
        };
        RuntimeRpcDispatcher dispatcher = dispatcher(evidence);

        JsonObject response = response(dispatcher,
                "{\"operation\":\"block.region\",\"dimension\":\"minecraft:overworld\","
                        + "\"min\":{\"x\":4,\"y\":60,\"z\":8},"
                        + "\"max\":{\"x\":5,\"y\":60,\"z\":8}}");

        JsonObject result = response.getAsJsonObject("result");
        assertEquals("block.region", result.get("operation").getAsString());
        assertEquals(2, result.getAsJsonObject("size").get("x").getAsInt());
        assertEquals("UNKNOWN", result.getAsJsonArray("palette").get(0)
                .getAsJsonObject().get("state").getAsString());
        assertEquals(1, result.getAsJsonArray("indices").get(0).getAsInt());
        assertEquals(0, result.getAsJsonArray("indices").get(1).getAsInt());
        assertFalse(result.get("complete").getAsBoolean());
    }

    @Test
    void blockRegionRejectsOversizedAxesAndVolumesBeforeReadingEvidence() {
        RuntimeRpcDispatcher dispatcher = dispatcher(new StubEvidenceGateway());
        for (String bounds : List.of(
                "\"min\":{\"x\":0,\"y\":0,\"z\":0},\"max\":{\"x\":128,\"y\":0,\"z\":0}",
                "\"min\":{\"x\":0,\"y\":0,\"z\":0},\"max\":{\"x\":63,\"y\":31,\"z\":32}",
                "\"min\":{\"x\":1,\"y\":0,\"z\":0},\"max\":{\"x\":0,\"y\":0,\"z\":0}")) {
            JsonObject response = response(dispatcher,
                    "{\"operation\":\"block.region\",\"dimension\":\"minecraft:overworld\","
                            + bounds + "}");
            assertEquals(-32602, response.getAsJsonObject("error").get("code").getAsInt());
        }
    }

    @Test
    void entityGetUsesExactUuidAndOmitsHealthAndNumericEntityId() {
        UUID uuid = UUID.fromString("00000000-0000-0000-0000-000000000243");
        RuntimeEvidenceGateway evidence = new StubEvidenceGateway() {
            @Override
            public Optional<RuntimeEntityTrack> entityGet(UUID requested) {
                assertEquals(uuid, requested);
                return Optional.of(new RuntimeEntityTrack(uuid, "minecraft:overworld",
                        "minecraft:zombie", null, null,
                        new RuntimeEntityPosition(2.5, 64.0, 3.5),
                        RuntimeEntityTrack.State.KNOWN, "vision", 100L, 7L));
            }
        };

        JsonObject response = response(dispatcher(evidence),
                "{\"operation\":\"entity.get\",\"uuid\":\"" + uuid + "\"}");

        JsonObject result = response.getAsJsonObject("result");
        JsonObject track = result.getAsJsonObject("track");
        assertEquals("entity.get", result.get("operation").getAsString());
        assertEquals(uuid.toString(), track.get("uuid").getAsString());
        assertEquals("KNOWN", track.get("state").getAsString());
        assertEquals(2.5, track.getAsJsonObject("position").get("x").getAsDouble());
        assertFalse(track.has("entity_numeric_id"));
        assertFalse(track.has("id"));
        assertFalse(track.has("health"));
        assertFalse(track.has("max_health"));
    }

    @Test
    void entityListUsesBoundedCanonicalEntityAndItemFilters() {
        UUID uuid = UUID.fromString("00000000-0000-0000-0000-000000000244");
        RuntimeEvidenceGateway evidence = new StubEvidenceGateway() {
            @Override
            public RuntimeEntityListResult entityList(
                    String dimension, CanonicalIdentifierMatcher entityPattern,
                    CanonicalIdentifierMatcher itemPattern) {
                assertEquals("minecraft:overworld", dimension);
                assertTrue(entityPattern.matches("minecraft:item"));
                assertTrue(itemPattern.matches("minecraft:diamond"));
                return new RuntimeEntityListResult(List.of(new RuntimeEntityTrack(
                        uuid, dimension, "minecraft:item", "minecraft:diamond", 2,
                        new RuntimeEntityPosition(4.0, 65.0, 6.0),
                        RuntimeEntityTrack.State.VISIBLE, "vision", 120L, 9L)), true);
            }
        };

        JsonObject response = response(dispatcher(evidence),
                "{\"operation\":\"entity.list\",\"dimension\":\"minecraft:overworld\","
                        + "\"entity_id_glob\":\"minecraft:item\","
                        + "\"item_id_glob\":\"minecraft:diamond\"}");

        JsonObject result = response.getAsJsonObject("result");
        JsonObject track = result.getAsJsonArray("tracks").get(0).getAsJsonObject();
        assertEquals("entity.list", result.get("operation").getAsString());
        assertEquals("minecraft:diamond", track.get("item_id").getAsString());
        assertEquals(2, track.get("item_count").getAsInt());
        assertTrue(result.get("has_more").getAsBoolean());
    }

    @Test
    void entityListOmitsLivingEntityHealth() {
        UUID uuid = UUID.fromString("00000000-0000-0000-0000-000000000245");
        RuntimeEvidenceGateway evidence = new StubEvidenceGateway() {
            @Override
            public RuntimeEntityListResult entityList(
                    String dimension, CanonicalIdentifierMatcher entityPattern,
                    CanonicalIdentifierMatcher itemPattern) {
                return new RuntimeEntityListResult(List.of(new RuntimeEntityTrack(
                        uuid, "minecraft:overworld", "minecraft:zombie", null, null,
                        new RuntimeEntityPosition(2.5, 64.0, 3.5),
                        RuntimeEntityTrack.State.VISIBLE, "vision", 100L, 7L)), false);
            }
        };

        JsonObject result = response(dispatcher(evidence), "{\"operation\":\"entity.list\"}")
                .getAsJsonObject("result");
        JsonObject track = result.getAsJsonArray("tracks").get(0).getAsJsonObject();
        assertEquals("minecraft:zombie", track.get("entity_id").getAsString());
        assertEquals("VISIBLE", track.get("state").getAsString());
        assertFalse(track.has("health"));
        assertFalse(track.has("max_health"));
    }

    @Test
    void entityListUsesGlobFilters() {
        RuntimeEvidenceGateway evidence = new StubEvidenceGateway() {
            @Override
            public RuntimeEntityListResult entityList(
                    String dimension, CanonicalIdentifierMatcher entityMatcher,
                    CanonicalIdentifierMatcher itemMatcher) {
                assertTrue(entityMatcher.matches("minecraft:item"));
                assertTrue(itemMatcher.matches("minecraft:diamond"));
                assertFalse(itemMatcher.matches("minecraft:diamond_block"));
                return new RuntimeEntityListResult(List.of(), false);
            }
        };

        JsonObject response = response(dispatcher(evidence),
                "{\"operation\":\"entity.list\",\"entity_id_glob\":\"minecraft:item\","
                        + "\"item_id_glob\":\"minecraft:diamond\"}");
        assertEquals("entity.list", response.getAsJsonObject("result")
                .get("operation").getAsString());
    }

    @Test
    void entityQueriesRejectMalformedUuidAndUnsupportedGlob() {
        RuntimeRpcDispatcher dispatcher = dispatcher(new StubEvidenceGateway());
        for (String params : List.of(
                "{\"operation\":\"entity.get\",\"uuid\":\"not-a-uuid\"}",
                "{\"operation\":\"entity.list\",\"entity_id_glob\":\"minecraft:(item)\"}",
                "{\"operation\":\"entity.list\",\"item_id_glob\":\"minecraft:diamond+\"}")) {
            JsonObject response = response(dispatcher, params);
            assertEquals(-32602, response.getAsJsonObject("error").get("code").getAsInt());
        }
    }

    private static RuntimeRpcDispatcher dispatcher(RuntimeEvidenceGateway evidence) {
        return new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(0L), RuntimeToolGateway.EMPTY, evidence);
    }

    private static JsonObject response(RuntimeRpcDispatcher dispatcher, String params) {
        return JsonParser.parseString(dispatcher.dispatchAsync(
                "{\"jsonrpc\":\"2.0\",\"id\":20,\"method\":\"knowledge.query\",\"params\":"
                        + params + "}").toCompletableFuture().join()).getAsJsonObject();
    }

    private static class StubEvidenceGateway implements RuntimeEvidenceGateway {
        @Override
        public List<RuntimeBlockEvidence> blockGet(
                String dimension, List<RuntimeBlockPosition> positions) {
            throw new AssertionError("query reached the wrong evidence operation");
        }
    }
}
