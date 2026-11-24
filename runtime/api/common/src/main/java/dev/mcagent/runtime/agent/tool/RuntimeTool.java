package dev.mcagent.runtime.agent.tool;

import dev.mcagent.runtime.agent.provider.IToolSpec;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskResult;
import com.google.gson.JsonObject;

import java.util.function.Consumer;

/**
 * The complete tool contract. The LLM-facing description (name/description/parameterSchema) is inherited
 * from the connection layer's {@link IToolSpec}; execution lives in this interface. Most tools are
 * <b>body tools</b> (they move the Bot's body or read its world), which is the default form: override
 * nothing, the call goes to the live body on the server, and you implement only {@link #onServerCall},
 * either answering on the spot (a query) or handing off to the task queue through
 * {@code TaskDispatch.enqueue}/{@code dispatchAsync}.
 */
public interface RuntimeTool extends IToolSpec {

    /** Whether invoking this tool requires exclusive ownership of the body task slot. */
    enum Execution { QUERY, BODY }

    default Execution execution() {
        return Execution.QUERY;
    }


    /**
     * Server-side entry point of a body tool, given the live body and the reply channel. Answer on the spot
     * (a query), or build a {@code TaskRecord} and pass it to {@code TaskDispatch.enqueue} (short,
     * synchronous) or {@code dispatchAsync} (long, asynchronous). Only a non-body tool that overrides
     * {@link #invoke} may ignore it; the default implementation fails with a clear message.
     */
    default void onServerCall(String toolCallId, JsonObject args,
                             BotPlayer bot, Consumer<String> reply) {
        reply.accept(TaskResult.fail(
                "tool '" + name() + "' has no server-side body implementation").toJson());
    }
}
