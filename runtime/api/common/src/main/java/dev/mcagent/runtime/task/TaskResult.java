package dev.mcagent.runtime.task;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;

import java.util.Map;

/**
 * The outcome of one Runtime Tool call, serialised as the result of {@code tool.call}.
 *
 * <p>{@code success}, {@code timedOut} and {@code interrupted} say how the call ended; {@code message} is a
 * short human-readable summary; {@code data} is the tool-specific payload (lowercase snake_case keys,
 * Gson-serialisable values). Every result that is not a success also carries one {@code failure_type}: a
 * stable lowercase code a caller can branch on without reading the message.
 *
 * @param failureType the cause when the tool knows one; {@code null} lets {@link #failureType()} derive it
 */
public record TaskResult(boolean success,
                         String message,
                         boolean timedOut,
                         boolean interrupted,
                         String failureType,
                         Map<String, Object> data) {

    /** The call ended without a more specific cause. */
    public static final String UNSPECIFIED = "unspecified";
    public static final String TIMED_OUT = "timed_out";
    public static final String INTERRUPTED = "interrupted";
    public static final String INTERNAL = "internal";

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    public TaskResult(boolean success, String message, boolean timedOut, boolean interrupted,
                      Map<String, Object> data) {
        this(success, message, timedOut, interrupted, null, data);
    }

    public static TaskResult ok(String message, Map<String, Object> data) {
        return new TaskResult(true, message, false, false, data);
    }

    public static TaskResult ok(String message) {
        return new TaskResult(true, message, false, false, Map.of());
    }

    public static TaskResult fail(String message, Map<String, Object> data) {
        return new TaskResult(false, message, false, false, data);
    }

    public static TaskResult fail(String message) {
        return new TaskResult(false, message, false, false, Map.of());
    }

    /** A failure whose cause is not part of the tool-specific payload. */
    public static TaskResult fail(String message, String failureType) {
        return new TaskResult(false, message, false, false, failureType, Map.of());
    }

    public static TaskResult fail(String message, String failureType, Map<String, Object> data) {
        return new TaskResult(false, message, false, false, failureType, data);
    }

    public static TaskResult timeout(String message) {
        return new TaskResult(false, message, true, false, Map.of());
    }

    public static TaskResult cancelled(String message) {
        return new TaskResult(false, message, false, true, Map.of());
    }

    /**
     * The failure code of this result, or {@code null} for a success. A tool-specific
     * {@code data.failure_type} wins, then the declared cause, then how the call ended.
     */
    @Override
    public String failureType() {
        if (success) return null;
        Object specific = data == null ? null : data.get("failure_type");
        if (specific != null) return specific.toString();
        if (failureType != null) return failureType;
        if (timedOut) return TIMED_OUT;
        if (interrupted) return INTERRUPTED;
        return UNSPECIFIED;
    }

    public String toJson() {
        JsonObject root = new JsonObject();
        root.addProperty("success", success);
        root.addProperty("message", message == null ? "" : message);
        if (!success) root.addProperty("failure_type", failureType());
        if (timedOut) root.addProperty("timed_out", true);
        if (interrupted) root.addProperty("interrupted", true);
        if (data != null && !data.isEmpty()) {
            JsonObject dataObj = new JsonObject();
            for (Map.Entry<String, Object> e : data.entrySet()) {
                Object v = e.getValue();
                if (v instanceof Number n) dataObj.addProperty(e.getKey(), n);
                else if (v instanceof Boolean b) dataObj.addProperty(e.getKey(), b);
                // Lists and maps expand as JSON: a structure must reach the model as a structure; Java's
                // toString would turn it into an unreadable [{k=v}].
                else if (v instanceof java.util.Collection<?> || v instanceof Map<?, ?>) {
                    dataObj.add(e.getKey(), GSON.toJsonTree(v));
                } else if (v != null) dataObj.addProperty(e.getKey(), v.toString());
            }
            root.add("data", dataObj);
        }
        return root.toString();
    }
}
