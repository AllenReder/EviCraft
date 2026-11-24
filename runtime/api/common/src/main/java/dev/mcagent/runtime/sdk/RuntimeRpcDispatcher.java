package dev.mcagent.runtime.sdk;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.knowledge.WorldKnowledgeProfile;
import dev.mcagent.runtime.knowledge.GroundedEvidencePolicy;

import java.util.Objects;
import java.util.Locale;
import java.util.Map;
import java.util.function.Supplier;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** JSON-RPC 2.0 text dispatcher for the initial Runtime SDK methods. */
public final class RuntimeRpcDispatcher {

    public static final int PROTOCOL_VERSION = 4;
    private static final String WAIT_TOOL = "wait";
    /** Five minutes of game time. */
    private static final long MAX_WAIT_TICKS = 6000;

    private final RuntimeBuildInfo buildInfo;
    private final WorldKnowledgeProfile worldKnowledgeProfile;
    private final GroundedEvidencePolicy groundedEvidencePolicy;
    private final RuntimeActorGateway actors;
    private final RuntimeToolGateway tools;
    private final RuntimeEvidenceGateway evidence;
    private final RuntimeKnowledgeRpcHandler knowledge;
    private final RuntimeSimulationControl simulation;
    private final RuntimeCameraGateway camera;
    /** observation.capture_view error code when no view can be captured: no camera client or no Bot. */
    public static final int CAMERA_UNAVAILABLE = -32010;

    private final java.util.Set<CompletableFuture<?>> pendingControls = new java.util.HashSet<>();
    private final Map<String, CompletableFuture<Long>> pendingWaits = new java.util.HashMap<>();
    private long controlSessionId = -1;

    public RuntimeRpcDispatcher(RuntimeBuildInfo buildInfo, Supplier<RuntimeActorView> actorView) {
        this(buildInfo, WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                GroundedEvidencePolicy.defaults(), readOnlyActors(actorView),
                RuntimeToolGateway.EMPTY, RuntimeEvidenceGateway.EMPTY, RuntimeSimulationControl.standalone());
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            WorldKnowledgeProfile worldKnowledgeProfile,
            Supplier<RuntimeActorView> actorView
    ) {
        this(buildInfo, worldKnowledgeProfile, GroundedEvidencePolicy.defaults(),
                readOnlyActors(actorView), RuntimeToolGateway.EMPTY, RuntimeEvidenceGateway.EMPTY,
                RuntimeSimulationControl.standalone());
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            WorldKnowledgeProfile worldKnowledgeProfile,
            GroundedEvidencePolicy groundedEvidencePolicy,
            Supplier<RuntimeActorView> actorView
    ) {
        this(buildInfo, worldKnowledgeProfile, groundedEvidencePolicy,
                readOnlyActors(actorView), RuntimeToolGateway.EMPTY, RuntimeEvidenceGateway.EMPTY,
                RuntimeSimulationControl.standalone());
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            Supplier<RuntimeActorView> actorView,
            RuntimeToolGateway tools
    ) {
        this(buildInfo, actorView, tools, RuntimeEvidenceGateway.EMPTY);
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            Supplier<RuntimeActorView> actorView,
            RuntimeToolGateway tools,
            RuntimeEvidenceGateway evidence
    ) {
        this(buildInfo, WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                GroundedEvidencePolicy.defaults(), readOnlyActors(actorView), tools, evidence,
                RuntimeSimulationControl.standalone());
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            WorldKnowledgeProfile worldKnowledgeProfile,
            RuntimeActorGateway actors,
            RuntimeToolGateway tools,
            RuntimeEvidenceGateway evidence
    ) {
        this(buildInfo, worldKnowledgeProfile, GroundedEvidencePolicy.defaults(),
                actors, tools, evidence, RuntimeSimulationControl.standalone());
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            WorldKnowledgeProfile worldKnowledgeProfile,
            GroundedEvidencePolicy groundedEvidencePolicy,
            RuntimeActorGateway actors,
            RuntimeToolGateway tools,
            RuntimeEvidenceGateway evidence
    ) {
        this(buildInfo, worldKnowledgeProfile, groundedEvidencePolicy,
                actors, tools, evidence, RuntimeSimulationControl.standalone());
    }
    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            WorldKnowledgeProfile worldKnowledgeProfile,
            GroundedEvidencePolicy groundedEvidencePolicy,
            RuntimeActorGateway actors,
            RuntimeToolGateway tools,
            RuntimeEvidenceGateway evidence,
            RuntimeSimulationControl simulation
    ) {
        this(buildInfo, worldKnowledgeProfile, groundedEvidencePolicy, actors, tools, evidence,
                simulation, RuntimeCameraGateway.UNAVAILABLE);
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            WorldKnowledgeProfile worldKnowledgeProfile,
            GroundedEvidencePolicy groundedEvidencePolicy,
            RuntimeActorGateway actors,
            RuntimeToolGateway tools,
            RuntimeEvidenceGateway evidence,
            RuntimeSimulationControl simulation,
            RuntimeCameraGateway camera
    ) {
        this.buildInfo = Objects.requireNonNull(buildInfo, "buildInfo");
        this.worldKnowledgeProfile = Objects.requireNonNull(
                worldKnowledgeProfile, "worldKnowledgeProfile");
        this.groundedEvidencePolicy = Objects.requireNonNull(
                groundedEvidencePolicy, "groundedEvidencePolicy");
        this.actors = Objects.requireNonNull(actors, "actors");
        this.tools = Objects.requireNonNull(tools, "tools");
        this.evidence = Objects.requireNonNull(evidence, "evidence");
        this.simulation = Objects.requireNonNull(simulation, "simulation");
        simulation.addDemand(this.tools::busy);
        this.camera = Objects.requireNonNull(camera, "camera");
        this.knowledge = new RuntimeKnowledgeRpcHandler(evidence);
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            RuntimeActorGateway actors
    ) {
        this(buildInfo, actors, RuntimeToolGateway.EMPTY, RuntimeEvidenceGateway.EMPTY);
    }

    public RuntimeRpcDispatcher(
            RuntimeBuildInfo buildInfo,
            RuntimeActorGateway actors,
            RuntimeToolGateway tools,
            RuntimeEvidenceGateway evidence
    ) {
        this(buildInfo, WorldKnowledgeProfile.GROUNDED_EVIDENCE,
                GroundedEvidencePolicy.defaults(), actors, tools, evidence,
                RuntimeSimulationControl.standalone());
    }

    public String dispatch(String textFrame) {
        return dispatchAsync(textFrame).toCompletableFuture().join();
    }

    public CompletionStage<String> dispatchAsync(String textFrame) {
        final JsonObject request;
        try {
            JsonElement parsed = JsonParser.parseString(textFrame);
            if (!parsed.isJsonObject()) {
                return completed(error(null, -32600, "Invalid Request"));
            }
            request = parsed.getAsJsonObject();
        } catch (JsonParseException | IllegalStateException exception) {
            return completed(error(null, -32700, "Parse error"));
        }
        JsonElement id = request.get("id");
        if (!isRequest(request, id)) {
            return completed(error(null, -32600, "Invalid Request"));
        }
        String method = request.get("method").getAsString();
        if (containsWorldKnowledgeProfile(request.get("params"))) {
            return completed(error(id, -32602, "Invalid params"));
        }
        if ("runtime.info".equals(method)) {
            return completed(runtimeInfo(id, request.get("params")));
        }
        if ("actor.get".equals(method)) {
            return completed(actorGet(id));
        }
        if ("actor.create".equals(method)) {
            return completed(actorCreate(id, request.get("params")));
        }
        if ("observation.observe".equals(method)) return observe(id, request.get("params"));
        if ("observation.capture_view".equals(method)) return captureView(id, request.get("params"));
        if ("runtime.time.await_tick".equals(method)) return awaitTick(id, request.get("params"));
        if ("knowledge.query".equals(method)) {
            return completed(knowledge.handle(id, request.get("params")));
        }
        if ("tool.list".equals(method)) {
            return completed(toolList(id));
        }
        if ("tool.call".equals(method)) {
            return toolCall(id, request.get("params"));
        }
        if ("task.cancel".equals(method)) {
            return completed(taskCancel(id, request.get("params")));
        }
        return completed(error(id, -32601, "Method not found"));
    }

    public void sessionOpened(long sessionId) {
        tools.sessionOpened(sessionId);
        cancelControls();
        controlSessionId = sessionId;
    }

    public void sessionClosed(long sessionId) {
        tools.sessionClosed(sessionId);
        if (controlSessionId != sessionId) return;
        controlSessionId = -1;
        cancelControls();
    }

    private void cancelControls() {
        var cancelled = java.util.List.copyOf(pendingControls);
        pendingControls.clear();
        cancelled.forEach(future -> future.cancel(false));
    }

    private static boolean emptyObject(JsonElement element) {
        return element != null && element.isJsonObject()
                && element.getAsJsonObject().keySet().isEmpty();
    }

    private JsonObject taskCancel(JsonElement id, JsonElement paramsElement) {
        if (id.isJsonNull() || paramsElement == null || !paramsElement.isJsonObject()) {
            return error(id, -32602, "Invalid params");
        }
        JsonElement taskId = paramsElement.getAsJsonObject().get("task_id");
        if (taskId == null || !taskId.isJsonPrimitive()
                || !(taskId.getAsJsonPrimitive().isString()
                || taskId.getAsJsonPrimitive().isNumber())) {
            return error(id, -32602, "Invalid params");
        }
        JsonObject result = new JsonObject();
        result.add("task_id", taskId.deepCopy());
        CompletableFuture<Long> wait = pendingWaits.get(taskId.toString());
        result.addProperty("cancelled", wait != null ? wait.cancel(false) : tools.cancel(taskId.deepCopy()));
        return success(id, result);
    }

    private CompletionStage<String> observe(JsonElement id, JsonElement params) {
        if (!emptyObject(params)) return completed(error(id, -32602, "Invalid params"));
        return control(id, simulation.observe(), receipt -> {
            JsonObject result = new JsonObject();
            result.addProperty("observation_revision", receipt.observationRevision());
            result.addProperty("server_tick", receipt.serverTick());
            result.addProperty("game_time", receipt.gameTime());
            return success(id, result);
        });
    }

    /**
     * Params: optional finite {@code yaw}/{@code pitch} in Minecraft degrees, or an integer
     * {@code target_block} {x,y,z} in the Bot's dimension instead of both. A capture that cannot run at all
     * (no camera, or no Bot) fails with {@link #CAMERA_UNAVAILABLE}; any other failure with -32603.
     */
    private CompletionStage<String> captureView(JsonElement id, JsonElement paramsElement) {
        if (paramsElement != null && !paramsElement.isJsonObject()) return completed(error(id, -32602, "Invalid params"));
        JsonObject params = paramsElement == null ? new JsonObject() : paramsElement.getAsJsonObject();
        for (String key : params.keySet()) {
            if (!key.equals("yaw") && !key.equals("pitch") && !key.equals("target_block")) {
                return completed(error(id, -32602, "Invalid params"));
            }
        }
        RuntimeCameraRequest request;
        try {
            Float yaw = optionalAngle(params, "yaw");
            Float pitch = optionalAngle(params, "pitch");
            RuntimeCameraRequest.TargetBlock target = optionalTargetBlock(params);
            if (pitch != null && (pitch < -90.0F || pitch > 90.0F)) return completed(error(id, -32602, "Invalid params"));
            request = new RuntimeCameraRequest(yaw, pitch, target);
        } catch (IllegalArgumentException invalid) {
            return completed(error(id, -32602, "Invalid params"));
        }
        CompletableFuture<RuntimeCameraCapture> capture = simulation.atStablePoint(() -> camera.capture(request))
                .thenCompose(stage -> stage).toCompletableFuture();
        pendingControls.add(capture);
        return capture.handle((frame, failure) -> {
            pendingControls.remove(capture);
            if (failure == null) return captureJson(id, frame).toString();
            Throwable cause = failure instanceof java.util.concurrent.CompletionException && failure.getCause() != null
                    ? failure.getCause() : failure;
            return error(id, cause instanceof RuntimeCameraUnavailableException ? CAMERA_UNAVAILABLE : -32603,
                    String.valueOf(cause.getMessage())).toString();
        });
    }

    private static JsonObject captureJson(JsonElement id, RuntimeCameraCapture frame) {
        JsonObject result = new JsonObject();
        result.addProperty("media_type", "image/png");
        result.addProperty("image_base64", java.util.Base64.getEncoder().encodeToString(frame.png()));
        result.addProperty("width", frame.width());
        result.addProperty("height", frame.height());
        result.addProperty("dimension", frame.dimension());
        JsonObject eye = new JsonObject();
        eye.addProperty("x", frame.eyeX());
        eye.addProperty("y", frame.eyeY());
        eye.addProperty("z", frame.eyeZ());
        result.add("eye", eye);
        result.addProperty("yaw", frame.yaw());
        result.addProperty("pitch", frame.pitch());
        result.addProperty("server_tick", frame.serverTick());
        if (frame.targetBlock() != null) {
            JsonObject target = new JsonObject();
            target.addProperty("x", frame.targetBlock().x());
            target.addProperty("y", frame.targetBlock().y());
            target.addProperty("z", frame.targetBlock().z());
            result.add("target_block", target);
        }
        return success(id, result);
    }

    private static RuntimeCameraRequest.TargetBlock optionalTargetBlock(JsonObject params) {
        JsonElement value = params.get("target_block");
        if (value == null) return null;
        if (!value.isJsonObject() || value.getAsJsonObject().size() != 3) throw new IllegalArgumentException("target_block");
        JsonObject block = value.getAsJsonObject();
        return new RuntimeCameraRequest.TargetBlock(blockCoordinate(block, "x"), blockCoordinate(block, "y"), blockCoordinate(block, "z"));
    }

    private static int blockCoordinate(JsonObject block, String key) {
        JsonElement value = block.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException(key);
        try { return value.getAsBigDecimal().intValueExact(); }
        catch (ArithmeticException notInteger) { throw new IllegalArgumentException(key, notInteger); }
    }

    private static Float optionalAngle(JsonObject params, String key) {
        JsonElement value = params.get(key);
        if (value == null) return null;
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException(key);
        double angle = value.getAsDouble();
        if (!Double.isFinite(angle)) throw new IllegalArgumentException(key);
        return (float) angle;
    }

    /**
     * Params: {@code after_tick} (absolute) or {@code ticks} (counted from now). Completes once the server
     * tick passes that point. The request only watches the clock; unlike the {@code wait} tool it does not
     * make a paused World Run advance.
     */
    private CompletionStage<String> awaitTick(JsonElement id, JsonElement params) {
        if (params == null || !params.isJsonObject() || params.getAsJsonObject().size() != 1) return completed(error(id, -32602, "Invalid params"));
        boolean relative = params.getAsJsonObject().has("ticks");
        if (!relative && !params.getAsJsonObject().has("after_tick")) return completed(error(id, -32602, "Invalid params"));
        try {
            JsonElement tick = params.getAsJsonObject().get(relative ? "ticks" : "after_tick");
            if (!tick.isJsonPrimitive() || !tick.getAsJsonPrimitive().isNumber()) return completed(error(id, -32602, "Invalid params"));
            long value = tick.getAsBigDecimal().longValueExact();
            if (value < 0) return completed(error(id, -32602, "Invalid params"));
            long afterTick = relative ? simulation.serverTick() + value - 1 : value;
            return control(id, simulation.waitForTick(afterTick), reached -> {
                JsonObject result = new JsonObject(); result.addProperty("server_tick", reached);
                return success(id, result);
            });
        } catch (RuntimeException invalid) { return completed(error(id, -32602, "Invalid params")); }
    }

    private <T> CompletionStage<String> control(JsonElement id, CompletionStage<T> operation,
                                               java.util.function.Function<T, JsonObject> encode) {
        CompletableFuture<T> future = operation.toCompletableFuture(); pendingControls.add(future);
        return future.handle((value, failure) -> {
            pendingControls.remove(future);
            if (failure != null) return error(id, -32603, failure.getMessage() == null ? "Control operation cancelled" : failure.getMessage()).toString();
            return encode.apply(value).toString();
        });
    }

    private CompletionStage<String> toolCall(JsonElement id, JsonElement paramsElement) {
        if (id.isJsonNull() || paramsElement == null || !paramsElement.isJsonObject()) {
            return completed(error(id, -32602, "Invalid params"));
        }
        JsonObject params = paramsElement.getAsJsonObject();
        JsonElement nameElement = params.get("name");
        JsonElement argumentsElement = params.get("arguments");
        if (nameElement == null || !nameElement.isJsonPrimitive()
                || !nameElement.getAsJsonPrimitive().isString()
                || argumentsElement == null || !argumentsElement.isJsonObject()) {
            return completed(error(id, -32602, "Invalid params"));
        }

        long startTick = simulation.serverTick();
        if (WAIT_TOOL.equals(nameElement.getAsString())) {
            return waitTool(id, argumentsElement.getAsJsonObject(), startTick);
        }
        CompletableFuture<String> response = new CompletableFuture<>();
        try {
            tools.call(id.deepCopy(), nameElement.getAsString(),
                    argumentsElement.getAsJsonObject(), resultJson -> {
                simulation.toolCallFinished();
                try {
                    JsonObject result = JsonParser.parseString(resultJson).getAsJsonObject();
                    response.complete(success(id, stamped(result, startTick)).toString());
                } catch (RuntimeException exception) {
                    response.complete(error(id, -32603, "Internal error").toString());
                }
            });
        } catch (RuntimeException exception) {
            response.complete(error(id, -32603, "Internal error").toString());
        }
        return response;
    }

    /**
     * The one way to let game time pass without acting. It does not use the body, so it may overlap a body
     * task; its request id is its task id for {@code task.cancel}.
     */
    private CompletionStage<String> waitTool(JsonElement id, JsonObject arguments, long startTick) {
        JsonElement ticksElement = arguments.get("ticks");
        long ticks;
        try {
            if (arguments.size() != 1 || ticksElement == null) throw new IllegalArgumentException("ticks");
            ticks = ticksElement.getAsBigDecimal().longValueExact();
        } catch (RuntimeException invalid) {
            return completed(success(id, stamped(waitResult("wait requires integer ticks", "invalid_arguments"), startTick)));
        }
        if (ticks < 0 || ticks > MAX_WAIT_TICKS) {
            return completed(success(id, stamped(waitResult(
                    "wait ticks must be between 0 and " + MAX_WAIT_TICKS, "invalid_arguments"), startTick)));
        }
        CompletableFuture<Long> wait = simulation.waitTicks(ticks).toCompletableFuture();
        String key = id.toString();
        pendingWaits.put(key, wait);
        pendingControls.add(wait);
        return wait.handle((tick, failure) -> {
            pendingWaits.remove(key, wait);
            pendingControls.remove(wait);
            return success(id, stamped(failure == null
                    ? waitResult("waited " + ticks + " ticks", null)
                    : waitResult("wait cancelled", "interrupted"), startTick)).toString();
        });
    }

    private static JsonObject waitResult(String message, String failureType) {
        JsonObject result = new JsonObject();
        result.addProperty("success", failureType == null);
        result.addProperty("message", message);
        if (failureType != null) result.addProperty("failure_type", failureType);
        if ("interrupted".equals(failureType)) result.addProperty("interrupted", true);
        result.add("data", new JsonObject());
        return result;
    }

    /** Every tool result says which server ticks the call spanned. */
    private JsonObject stamped(JsonObject result, long startTick) {
        result.addProperty("start_tick", startTick);
        result.addProperty("end_tick", simulation.serverTick());
        return result;
    }

    private JsonObject toolList(JsonElement id) {
        Gson gson = new Gson();
        JsonArray catalogue = new JsonArray();
        JsonObject wait = new JsonObject();
        wait.addProperty("name", WAIT_TOOL);
        wait.addProperty("description", "Let the given number of game ticks pass without acting.");
        wait.add("parameters", JsonParser.parseString("{\"type\":\"object\",\"properties\":{\"ticks\":{\"type\":\"integer\","
                + "\"minimum\":0,\"maximum\":" + MAX_WAIT_TICKS + "}},\"required\":[\"ticks\"],\"additionalProperties\":false}"));
        wait.addProperty("execution", "query");
        catalogue.add(wait);
        for (RuntimeToolDescriptor tool : tools.list()) {
            JsonObject item = new JsonObject();
            item.addProperty("name", tool.name());
            item.addProperty("description", tool.description());
            item.add("parameters", gson.toJsonTree(tool.parameters()));
            item.addProperty("execution", tool.execution());
            catalogue.add(item);
        }
        JsonObject result = new JsonObject();
        result.add("tools", catalogue);
        return success(id, result);
    }

    static CompletionStage<String> completed(JsonObject response) {
        return CompletableFuture.completedFuture(response.toString());
    }

    private static boolean isRequest(JsonObject request, JsonElement id) {
        JsonElement version = request.get("jsonrpc");
        JsonElement method = request.get("method");
        boolean validId = id != null && (id.isJsonNull() || id.isJsonPrimitive()
                && (id.getAsJsonPrimitive().isString() || id.getAsJsonPrimitive().isNumber()));
        return version != null && version.isJsonPrimitive() && version.getAsJsonPrimitive().isString()
                && "2.0".equals(version.getAsString())
                && method != null && method.isJsonPrimitive()
                && method.getAsJsonPrimitive().isString()
                && validId;
    }

    private static boolean containsWorldKnowledgeProfile(JsonElement value) {
        if (value == null || value.isJsonNull() || value.isJsonPrimitive()) return false;
        if (value.isJsonArray()) {
            for (JsonElement element : value.getAsJsonArray()) {
                if (containsWorldKnowledgeProfile(element)) return true;
            }
            return false;
        }
        JsonObject object = value.getAsJsonObject();
        if (object.has("world_knowledge_profile")) return true;
        for (Map.Entry<String, JsonElement> entry : object.entrySet()) {
            if (containsWorldKnowledgeProfile(entry.getValue())) return true;
        }
        return false;
    }

    private JsonObject runtimeInfo(JsonElement id, JsonElement paramsElement) {
        if (!emptyObject(paramsElement)) {
            return error(id, -32602, "Invalid params");
        }
        JsonObject result = new JsonObject();
        result.addProperty("protocol_version", PROTOCOL_VERSION);
        result.addProperty("build_version", buildInfo.buildVersion());
        result.addProperty("minecraft_version", buildInfo.minecraftVersion());
        result.addProperty("neoforge_version", buildInfo.neoForgeVersion());
        result.addProperty("readiness", "ready");
        result.addProperty("world_knowledge_profile", worldKnowledgeProfile.wireValue());
        result.addProperty("grounded_block_expiry_ticks",
                groundedEvidencePolicy.blockExpiryTicks());
        result.addProperty("grounded_entity_expiry_ticks",
                groundedEvidencePolicy.entityExpiryTicks());
        result.addProperty("simulation_suspended", simulation.simulationSuspended());
        result.addProperty("pause_when_idle", simulation.pausesWhenIdle());
        return success(id, result);
    }

    private JsonObject actorGet(JsonElement id) {
        RuntimeActorView actor = actors.get();
        return success(id, actor == null
                ? com.google.gson.JsonNull.INSTANCE
                : actorJson(actor));
    }

    private JsonObject actorCreate(JsonElement id, JsonElement paramsElement) {
        if (id.isJsonNull() || paramsElement == null || !paramsElement.isJsonObject()) {
            return error(id, -32602, "Invalid params");
        }
        JsonElement username = paramsElement.getAsJsonObject().get("username");
        if (!paramsElement.getAsJsonObject().keySet().equals(java.util.Set.of("username"))
                || username == null || !username.isJsonPrimitive()
                || !username.getAsJsonPrimitive().isString()) {
            return error(id, -32602, "Invalid params");
        }
        try {
            return success(id, actorJson(actors.create(username.getAsString())));
        } catch (IllegalArgumentException exception) {
            return error(id, -32602, exception.getMessage());
        } catch (IllegalStateException exception) {
            return error(id, -32009, exception.getMessage());
        }
    }

    private static JsonObject actorJson(RuntimeActorView actor) {
        JsonObject result = new JsonObject();
        result.addProperty("uuid", actor.uuid().toString());
        result.addProperty("name", actor.name());
        result.addProperty("lifecycle_state", actor.lifecycle().name().toLowerCase(Locale.ROOT));
        result.addProperty("observation_revision", actor.observationRevision());
        return result;
    }

    private static RuntimeActorGateway readOnlyActors(Supplier<RuntimeActorView> actorView) {
        Objects.requireNonNull(actorView, "actorView");
        return new RuntimeActorGateway() {
            @Override public RuntimeActorView get() { return actorView.get(); }
            @Override public RuntimeActorView create(String username) {
                throw new UnsupportedOperationException("actor.create is not configured");
            }
        };
    }

    static JsonObject success(JsonElement id, JsonElement result) {
        JsonObject response = envelope(id);
        response.add("result", result);
        return response;
    }

    static JsonObject error(JsonElement id, int code, String message) {
        JsonObject detail = new JsonObject();
        detail.addProperty("code", code);
        detail.addProperty("message", message);
        JsonObject response = envelope(id);
        response.add("error", detail);
        return response;
    }

    private static JsonObject envelope(JsonElement id) {
        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        response.add("id", id == null ? com.google.gson.JsonNull.INSTANCE : id.deepCopy());
        return response;
    }
}
