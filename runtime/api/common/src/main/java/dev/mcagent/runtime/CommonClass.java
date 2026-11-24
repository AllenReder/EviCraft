package dev.mcagent.runtime;

import dev.mcagent.runtime.agent.tool.ToolRegistry;
import dev.mcagent.runtime.platform.Services;

/**
 * Loader-agnostic mod init. Called once from each platform's mod entry point
 * after the loader has finished registry-registration (entity types, payloads,
 * etc.). Everything that depends on the {@code Services} surface or that is
 * pure data-side initialisation lives here.
 */
public class CommonClass {

    public static void init() {
        Constants.LOG.info("[mc_agent] common init on {} ({})",
                Services.PLATFORM.getPlatformName(), Services.PLATFORM.getEnvironmentName());

        registerTools();
        wireTaskMachine();
    }

    /** Connects body lifecycle events to the task scheduler. */
    private static void wireTaskMachine() {
        dev.mcagent.runtime.entity.BotLifecycle.onDeath(
                dev.mcagent.runtime.task.BotTickDispatcher::clearActiveTask);
        dev.mcagent.runtime.entity.BotLifecycle.onRemove(
                dev.mcagent.runtime.task.BotTickDispatcher::onBotRemoved);
    }

    /**
     * Populate the global {@link ToolRegistry}. the api module is a
     * chat-only bot and registers <em>no</em> tools of its own — the
     * registry starts empty. the core module and third-party tool packs
     * register their own {@link dev.mcagent.runtime.agent.tool.RuntimeTool}s via
     * {@link ToolRegistry#register}, in their own init.
     *
     * <p>Kept as an explicit (empty) hook so the engine's init flow and logging
     * read the same whether or not any tools are present.
     */
    public static void registerTools() {
        Constants.LOG.info("[mc_agent] registered {} tool(s)", ToolRegistry.size());
    }
}
