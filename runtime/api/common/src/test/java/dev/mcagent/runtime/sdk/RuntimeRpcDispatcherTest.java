package dev.mcagent.runtime.sdk;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.knowledge.WorldKnowledgeProfile;
import org.junit.jupiter.api.Test;

import java.util.Set;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;

class RuntimeRpcDispatcherTest {

    @Test
    void waitToolLetsTicksPassAndRejectsOutOfRangeDurations() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> null);

        JsonObject waited = toolCall(dispatcher, "{\"ticks\":20}");
        assertEquals(true, waited.get("success").getAsBoolean());
        assertEquals("waited 20 ticks", waited.get("message").getAsString());
        assertEquals(true, waited.has("start_tick") && waited.has("end_tick"));
        assertEquals(false, toolCall(dispatcher, "{\"ticks\":6001}").get("success").getAsBoolean());
        assertEquals(false, toolCall(dispatcher, "{\"ticks\":1.5}").get("success").getAsBoolean());
        assertEquals(false, toolCall(dispatcher, "{}").get("success").getAsBoolean());
    }

    @Test
    void harnessCannotSuspendOrResumeSimulation() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> null);

        for (String method : List.of("runtime.time.suspend", "runtime.time.resume")) {
            JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                    "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"" + method + "\",\"params\":{}}"
            )).getAsJsonObject();
            assertEquals(-32601, response.getAsJsonObject("error").get("code").getAsInt());
        }
    }

    private static JsonObject toolCall(RuntimeRpcDispatcher dispatcher, String arguments) {
        return JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tool.call\",\"params\":{\"name\":\"wait\",\"arguments\":" + arguments + "}}"
        )).getAsJsonObject().getAsJsonObject("result");
    }

    @Test
    void taskCancelUsesTheToolCallRequestIdAsTheTaskId() {
        AtomicReference<JsonElement> cancelled = new AtomicReference<>();
        RuntimeToolGateway gateway = new RuntimeToolGateway() {
            @Override public List<RuntimeToolDescriptor> list() { return List.of(); }
            @Override public void call(JsonElement requestId, String name, JsonObject arguments,
                                       Consumer<String> completion) {}
            @Override public boolean cancel(JsonElement taskId) {
                cancelled.set(taskId);
                return true;
            }
        };
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(0L), gateway
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"task.cancel\","
                        + "\"params\":{\"task_id\":\"goto-17\"}}"
        )).getAsJsonObject();

        assertEquals(true, cancelled.get().getAsJsonPrimitive().isString());
        assertEquals("goto-17", cancelled.get().getAsString());
        assertEquals("goto-17", response.getAsJsonObject("result").get("task_id").getAsString());
        assertEquals(true, response.getAsJsonObject("result").get("cancelled").getAsBoolean());
    }

    @Test
    void runtimeInfoReturnsTheFixedWorldKnowledgeProfileBeforeActorCreation() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                WorldKnowledgeProfile.LOADED_WORLD_STATE,
                new dev.mcagent.runtime.knowledge.GroundedEvidencePolicy(600, 200, 360),
                () -> null
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"runtime.info\",\"params\":{}}"
        )).getAsJsonObject();
        JsonObject result = response.getAsJsonObject("result");

        assertEquals("2.0", response.get("jsonrpc").getAsString());
        assertEquals(7, response.get("id").getAsInt());
        assertEquals(Set.of(
                "protocol_version", "build_version", "minecraft_version",
                "neoforge_version", "readiness", "world_knowledge_profile",
                "grounded_block_expiry_ticks", "grounded_entity_expiry_ticks",
                "simulation_suspended", "pause_when_idle"
        ), result.keySet());
        assertEquals(4, result.get("protocol_version").getAsInt());
        assertEquals("0.1.1", result.get("build_version").getAsString());
        assertEquals("1.21.1", result.get("minecraft_version").getAsString());
        assertEquals("21.1.233", result.get("neoforge_version").getAsString());
        assertEquals("ready", result.get("readiness").getAsString());
        assertEquals("loaded_world_state", result.get("world_knowledge_profile").getAsString());
        assertEquals(600, result.get("grounded_block_expiry_ticks").getAsInt());
        assertEquals(200, result.get("grounded_entity_expiry_ticks").getAsInt());
        assertEquals(false, result.get("simulation_suspended").getAsBoolean());

        JsonObject attemptedSwitch = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"runtime.info\","
                        + "\"params\":{\"world_knowledge_profile\":\"grounded_evidence\"}}"
        )).getAsJsonObject();
        assertEquals(-32602, attemptedSwitch.getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    void actorGetReturnsOnlyIdentityLifecycleAndObservationRevision() {
        UUID identity = UUID.fromString("1060d6bd-3af2-42ae-92dc-ecab4536f00d");
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> new RuntimeActorView(identity, "bot", RuntimeActorView.Lifecycle.ALIVE, 0L)
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":\"actor-1\",\"method\":\"actor.get\",\"params\":{}}"
        )).getAsJsonObject();
        JsonObject result = response.getAsJsonObject("result");

        assertEquals("actor-1", response.get("id").getAsString());
        assertEquals(Set.of("uuid", "name", "lifecycle_state", "observation_revision"), result.keySet());
        assertEquals(identity.toString(), result.get("uuid").getAsString());
        assertEquals("bot", result.get("name").getAsString());
        assertEquals("alive", result.get("lifecycle_state").getAsString());
        assertEquals(0L, result.get("observation_revision").getAsLong());
    }

    @Test
    void actorGetReturnsJsonNullBeforeExplicitCreation() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                new RuntimeActorGateway() {
                    @Override public RuntimeActorView get() { return null; }
                    @Override public RuntimeActorView create(String username) {
                        throw new AssertionError("actor.create was not requested");
                    }
                }
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"actor.get\",\"params\":{}}"
        )).getAsJsonObject();

        assertEquals(true, response.get("result").isJsonNull());
    }

    @Test
    void actorCreateDelegatesTheRequestedUsernameAndReturnsTheActorProjection() {
        AtomicReference<String> requestedUsername = new AtomicReference<>();
        UUID identity = UUID.fromString("1060d6bd-3af2-42ae-92dc-ecab4536f00d");
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                new RuntimeActorGateway() {
                    @Override public RuntimeActorView get() { return null; }
                    @Override public RuntimeActorView create(String username) {
                        requestedUsername.set(username);
                        return new RuntimeActorView(
                                identity, username, RuntimeActorView.Lifecycle.ALIVE, 1L);
                    }
                }
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"actor.create\","
                        + "\"params\":{\"username\":\"HarnessBot\"}}"
        )).getAsJsonObject();
        JsonObject result = response.getAsJsonObject("result");

        assertEquals("HarnessBot", requestedUsername.get());
        assertEquals(identity.toString(), result.get("uuid").getAsString());
        assertEquals("HarnessBot", result.get("name").getAsString());
        assertEquals("alive", result.get("lifecycle_state").getAsString());
        assertEquals(1L, result.get("observation_revision").getAsLong());
    }

    @Test
    void actorCreateCannotSelectAWorldKnowledgeProfile() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                () -> null
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"actor.create\","
                        + "\"params\":{\"username\":\"bot\","
                        + "\"world_knowledge_profile\":\"loaded_world_state\"}}"
        )).getAsJsonObject();

        assertEquals(-32602, response.getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    void knowledgeOperationsCannotSelectAWorldKnowledgeProfile() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                () -> null
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"knowledge.query\","
                        + "\"params\":{\"operation\":\"block.get\","
                        + "\"dimension\":\"minecraft:overworld\","
                        + "\"positions\":[{\"x\":0,\"y\":64,\"z\":0}],"
                        + "\"world_knowledge_profile\":\"loaded_world_state\"}}"
        )).getAsJsonObject();

        assertEquals(-32602, response.getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    void rejectsMalformedJsonWithoutExposingAnImplementationException() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(0L)
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch("{" )).getAsJsonObject();

        assertEquals("2.0", response.get("jsonrpc").getAsString());
        assertEquals(true, response.get("id").isJsonNull());
        assertEquals(-32700, response.getAsJsonObject("error").get("code").getAsInt());
        assertEquals("Parse error", response.getAsJsonObject("error").get("message").getAsString());
    }

    @Test
    void rejectsBooleanJsonRpcRequestIds() {
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(0L)
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":true,\"method\":\"runtime.info\",\"params\":{}}"
        )).getAsJsonObject();

        assertEquals(true, response.get("id").isJsonNull());
        assertEquals(-32600, response.getAsJsonObject("error").get("code").getAsInt());
    }

    private static JsonObject response(RuntimeRpcDispatcher dispatcher, String method) {
        return JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"" + method + "\",\"params\":{}}"
        )).getAsJsonObject().getAsJsonObject("result");
    }
}
