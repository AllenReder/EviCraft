package dev.mcagent.runtime.sdk;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.task.TaskResult;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;

class RuntimeToolRpcTest {

    @Test
    void toolListReturnsTheWaitToolAndTheGatewayCatalog() {
        RuntimeToolGateway gateway = new RuntimeToolGateway() {
            @Override
            public List<RuntimeToolDescriptor> list() {
                return List.of(
                        new RuntimeToolDescriptor("get_self_status", "Read body status", Map.of("type", "object")),
                        new RuntimeToolDescriptor("get_world_info", "Read world status", Map.of("type", "object"))
                );
            }

            @Override
            public void call(JsonElement requestId, String name, JsonObject arguments,
                             java.util.function.Consumer<String> completion) {
                throw new AssertionError("tool.list must not invoke a tool");
            }
        };
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(0L),
                gateway
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatchAsync(
                "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tool.list\",\"params\":{}}"
        ).toCompletableFuture().join()).getAsJsonObject();

        assertEquals(11, response.get("id").getAsInt());
        assertEquals(Set.of("tools"), response.getAsJsonObject("result").keySet());
        assertEquals(List.of("wait", "get_self_status", "get_world_info"),
                response.getAsJsonObject("result").getAsJsonArray("tools").asList().stream()
                        .map(tool -> tool.getAsJsonObject().get("name").getAsString())
                .toList());
    }

    @Test
    void toolCallWaitsForAndReturnsTheOrdinaryTaskResult() {
        RuntimeToolGateway gateway = new RuntimeToolGateway() {
            @Override
            public List<RuntimeToolDescriptor> list() {
                return List.of();
            }

            @Override
            public void call(JsonElement requestId, String name, JsonObject arguments,
                             java.util.function.Consumer<String> completion) {
                assertEquals(true, requestId.getAsJsonPrimitive().isString());
                assertEquals("task-7", requestId.getAsString());
                assertEquals("get_world_info", name);
                assertEquals(Set.of(), arguments.keySet());
                completion.accept(TaskResult.ok("world status", Map.of(
                        "dimension", "minecraft:overworld",
                        "time_of_day", "day"
                )).toJson());
            }
        };
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(0L),
                gateway
        );

        JsonObject response = JsonParser.parseString(dispatcher.dispatchAsync(
                "{\"jsonrpc\":\"2.0\",\"id\":\"task-7\",\"method\":\"tool.call\","
                        + "\"params\":{\"name\":\"get_world_info\",\"arguments\":{}}}"
        ).toCompletableFuture().join()).getAsJsonObject();

        JsonObject result = response.getAsJsonObject("result");
        assertEquals(true, result.get("success").getAsBoolean());
        assertEquals("world status", result.get("message").getAsString());
        assertEquals("minecraft:overworld", result.getAsJsonObject("data").get("dimension").getAsString());
    }

    @Test
    void runtimeToolArgumentsCannotSelectAWorldKnowledgeProfile() {
        RuntimeToolGateway gateway = new RuntimeToolGateway() {
            @Override public List<RuntimeToolDescriptor> list() { return List.of(); }
            @Override public void call(JsonElement requestId, String name, JsonObject arguments,
                                       java.util.function.Consumer<String> completion) {
                throw new AssertionError("profile-bearing Runtime Tool input must be rejected");
            }
        };
        RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                () -> RuntimeActorView.starting(0L), gateway);

        JsonObject response = JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"tool.call\","
                        + "\"params\":{\"name\":\"get_world_info\",\"arguments\":{"
                        + "\"world_knowledge_profile\":\"loaded_world_state\"}}}"
        )).getAsJsonObject();

        assertEquals(-32602, response.getAsJsonObject("error").get("code").getAsInt());
    }
}
