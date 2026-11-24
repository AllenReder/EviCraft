package dev.mcagent.runtime.sdk;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.knowledge.GroundedEvidencePolicy;
import dev.mcagent.runtime.knowledge.WorldKnowledgeProfile;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RuntimeCameraRpcTest {

    private final List<RuntimeCameraRequest> requests = new ArrayList<>();

    private RuntimeRpcDispatcher dispatcher(RuntimeCameraGateway camera) {
        return new RuntimeRpcDispatcher(
                new RuntimeBuildInfo("0.1.1", "1.21.1", "21.1.233"),
                WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                GroundedEvidencePolicy.defaults(),
                new RuntimeActorGateway() {
                    @Override public RuntimeActorView get() { return null; }
                    @Override public RuntimeActorView create(String username) { throw new UnsupportedOperationException(); }
                }, RuntimeToolGateway.EMPTY, RuntimeEvidenceGateway.EMPTY, RuntimeSimulationControl.standalone(), camera);
    }

    private RuntimeRpcDispatcher recording() {
        return dispatcher(request -> {
            requests.add(request);
            return CompletableFuture.completedFuture(new RuntimeCameraCapture(new byte[] {1, 2, 3}, 854, 480,
                    "minecraft:overworld", 0.5, 65.62, -3.5, request.yaw() == null ? 0.0F : request.yaw(),
                    request.pitch() == null ? 0.0F : request.pitch(), 42, request.targetBlock()));
        });
    }

    private static JsonObject call(RuntimeRpcDispatcher dispatcher, String params) {
        return JsonParser.parseString(dispatcher.dispatch(
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"observation.capture_view\",\"params\":" + params + "}")).getAsJsonObject();
    }

    @Test
    void returnsTheImageAndPoseAndForwardsTheDirection() {
        JsonObject result = call(recording(), "{\"yaw\":90,\"pitch\":-15.5}").getAsJsonObject("result");
        assertEquals(new RuntimeCameraRequest(90.0F, -15.5F, null), requests.getFirst());
        assertEquals("image/png", result.get("media_type").getAsString());
        assertEquals(Base64.getEncoder().encodeToString(new byte[] {1, 2, 3}), result.get("image_base64").getAsString());
        assertEquals(854, result.get("width").getAsInt());
        assertEquals("minecraft:overworld", result.get("dimension").getAsString());
        assertEquals(65.62, result.getAsJsonObject("eye").get("y").getAsDouble());
        assertEquals(90.0F, result.get("yaw").getAsFloat());
        assertEquals(42, result.get("server_tick").getAsLong());
    }

    @Test
    void omittedFieldsKeepTheCurrentDirection() {
        call(recording(), "{}");
        assertEquals(new RuntimeCameraRequest(null, null, null), requests.getFirst());
    }

    @Test
    void forwardsAnIntegerTargetBlockAndEchoesIt() {
        JsonObject result = call(recording(), "{\"target_block\":{\"x\":-12,\"y\":64,\"z\":7}}").getAsJsonObject("result");
        assertEquals(new RuntimeCameraRequest(null, null, new RuntimeCameraRequest.TargetBlock(-12, 64, 7)), requests.getFirst());
        assertEquals(-12, result.getAsJsonObject("target_block").get("x").getAsInt());
    }

    @Test
    void rejectsInvalidParamsWithoutCapturing() {
        RuntimeRpcDispatcher dispatcher = recording();
        for (String params : List.of("{\"pitch\":91}", "{\"yaw\":\"north\"}", "{\"hud\":true}", "{\"zoom\":2}", "[]",
                "{\"yaw\":0,\"target_block\":{\"x\":1,\"y\":2,\"z\":3}}", "{\"target_block\":{\"x\":1.5,\"y\":2,\"z\":3}}",
                "{\"target_block\":{\"x\":1,\"y\":2}}")) {
            assertEquals(-32602, call(dispatcher, params).getAsJsonObject("error").get("code").getAsInt(), params);
        }
        assertTrue(requests.isEmpty());
    }

    @Test
    void reportsAnUnavailableCameraWithItsOwnCode() {
        JsonObject response = call(dispatcher(RuntimeCameraGateway.UNAVAILABLE), "{}");
        assertNull(response.get("result"));
        assertEquals(RuntimeRpcDispatcher.CAMERA_UNAVAILABLE, response.getAsJsonObject("error").get("code").getAsInt());
        assertEquals("Camera is not configured for this World Run", response.getAsJsonObject("error").get("message").getAsString());
    }

    @Test
    void reportsOtherCaptureFailuresAsInternalErrors() {
        JsonObject response = call(dispatcher(request -> CompletableFuture.failedFuture(new IllegalStateException("HTTP 504"))), "{}");
        assertEquals(-32603, response.getAsJsonObject("error").get("code").getAsInt());
        assertEquals("HTTP 504", response.getAsJsonObject("error").get("message").getAsString());
    }
}
