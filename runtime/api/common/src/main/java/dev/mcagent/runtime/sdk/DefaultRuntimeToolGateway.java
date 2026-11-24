package dev.mcagent.runtime.sdk;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.ToolRegistry;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskResult;
import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.task.RuntimeTaskCompletions;
import dev.mcagent.runtime.task.BotTickDispatcher;
import dev.mcagent.runtime.entity.InputDriver;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Adapts the deployment's registered Runtime tools to the authenticated SDK seam. */
public final class DefaultRuntimeToolGateway implements RuntimeToolGateway {

    private final Supplier<List<RuntimeTool>> catalogue;
    private final Supplier<BotPlayer> actor;
    private final Map<String, ActiveTask> active = new HashMap<>();
    private long session;

    public DefaultRuntimeToolGateway(Supplier<BotPlayer> actor) {
        this(ToolRegistry::all, actor);
    }

    DefaultRuntimeToolGateway(Supplier<List<RuntimeTool>> catalogue, Supplier<BotPlayer> actor) {
        this.catalogue = Objects.requireNonNull(catalogue, "catalogue");
        this.actor = Objects.requireNonNull(actor, "actor");
    }

    @Override
    public List<RuntimeToolDescriptor> list() {
        return catalogue.get().stream()
                .map(tool -> new RuntimeToolDescriptor(
                        tool.name(), tool.description(), tool.parameterSchema(),
                        tool.execution().name().toLowerCase(java.util.Locale.ROOT)))
                .toList();
    }

    @Override
    public void call(JsonElement requestId, String name, JsonObject arguments,
                     Consumer<String> completion) {
        Objects.requireNonNull(completion, "completion");
        RuntimeTool tool = catalogue.get().stream()
                .filter(candidate -> candidate.name().equals(name))
                .findFirst()
                .orElse(null);
        if (tool == null) {
            completion.accept(TaskResult.fail("unknown Runtime Tool: " + name, "unknown_tool").toJson());
            return;
        }
        BotPlayer body = actor.get();
        if (body == null) {
            completion.accept(TaskResult.fail("Runtime Bot is not ready", "actor_unavailable").toJson());
            return;
        }

        if (tool.execution() == RuntimeTool.Execution.BODY
                && (!active.isEmpty()
                || BotTickDispatcher.currentTaskFor(body.getUUID()) != null)) {
            completion.accept(TaskResult.fail("the Runtime Bot is already executing a body task", "busy").toJson());
            return;
        }

        AtomicBoolean completed = new AtomicBoolean();
        Consumer<String> terminal = result -> {
            if (completed.compareAndSet(false, true)) {
                completion.accept(result);
            }
        };
        String taskKey = taskKey(requestId);
        String internalId = TaskRecord.RUNTIME_CALL_PREFIX + session + "-" + taskKey;
        active.put(taskKey, new ActiveTask(internalId, body));
        RuntimeTaskCompletions.register(internalId, result -> {
            ActiveTask owned = active.get(taskKey);
            if (owned != null && owned.internalId().equals(internalId)) {
                active.remove(taskKey);
                terminal.accept(result);
            }
        });
        try {
            tool.onServerCall(internalId, arguments.deepCopy(), body, result -> {
                if (isAsyncAcceptance(result)) {
                    return;
                }
                RuntimeTaskCompletions.forget(internalId);
                active.remove(taskKey);
                terminal.accept(result);
            });
        } catch (IllegalArgumentException | com.google.gson.JsonParseException invalid) {
            RuntimeTaskCompletions.forget(internalId);
            active.remove(taskKey);
            terminal.accept(TaskResult.fail("invalid arguments: " + invalid.getMessage(), "invalid_arguments").toJson());
        } catch (RuntimeException exception) {
            RuntimeTaskCompletions.forget(internalId);
            active.remove(taskKey);
            terminal.accept(TaskResult.fail("tool call failed: " + exception.getMessage(), TaskResult.INTERNAL).toJson());
        }
    }

    @Override
    public boolean cancel(JsonElement taskId) {
        ActiveTask task = active.get(taskKey(taskId));
        return task != null && BotTickDispatcher.cancelMatching(task.body(), task.internalId());
    }

    @Override
    public boolean busy() {
        return !active.isEmpty();
    }

    @Override
    public void sessionOpened(long sessionId) {
        if (sessionId <= session) return;
        cleanupActive();
        session = sessionId;
    }

    @Override
    public void sessionClosed(long sessionId) {
        if (session != sessionId) return;
        cleanupActive();
    }

    private void cleanupActive() {
        for (ActiveTask task : List.copyOf(active.values())) {
            BotTickDispatcher.cancelMatching(task.body(), task.internalId());
            RuntimeTaskCompletions.forget(task.internalId());
            InputDriver.halt(task.body());
            task.body().setShiftKeyDown(false);
        }
        active.clear();
    }

    private static String taskKey(JsonElement taskId) {
        if (taskId == null || !taskId.isJsonPrimitive()) {
            throw new IllegalArgumentException("task id must be a JSON string or number");
        }
        var primitive = taskId.getAsJsonPrimitive();
        if (primitive.isString()) return "s:" + primitive.getAsString();
        if (primitive.isNumber()) return "n:" + primitive;
        throw new IllegalArgumentException("task id must be a JSON string or number");
    }

    private static boolean isAsyncAcceptance(String result) {
        try {
            JsonObject root = com.google.gson.JsonParser.parseString(result).getAsJsonObject();
            JsonObject data = root.getAsJsonObject("data");
            return root.get("success").getAsBoolean() && data != null
                    && data.has("async") && data.get("async").getAsBoolean();
        } catch (RuntimeException malformed) {
            return false;
        }
    }

    private record ActiveTask(String internalId, BotPlayer body) {}
}
