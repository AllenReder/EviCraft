package dev.mcagent.runtime.sdk;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.function.Consumer;

/** Runtime Tool catalogue and terminal-result execution seam used by JSON-RPC. */
public interface RuntimeToolGateway {

    RuntimeToolGateway EMPTY = new RuntimeToolGateway() {
        @Override
        public List<RuntimeToolDescriptor> list() {
            return List.of();
        }

        @Override
        public void call(JsonElement requestId, String name, JsonObject arguments,
                         Consumer<String> completion) {
            throw new UnsupportedOperationException("Runtime Tools are unavailable");
        }
    };

    List<RuntimeToolDescriptor> list();

    void call(JsonElement requestId, String name, JsonObject arguments, Consumer<String> completion);

    /** Cancel the body task whose public task id is the originating JSON-RPC request id. */
    default boolean cancel(JsonElement taskId) {
        return false;
    }

    /** Whether a tool call is in progress; a busy gateway keeps a pause-when-idle World Run advancing. */
    default boolean busy() {
        return false;
    }

    /** Start a fresh authenticated controller session. */
    default void sessionOpened(long sessionId) {}

    /** Cancel and forget all work owned by the disconnected controller session. */
    default void sessionClosed(long sessionId) {}
}
