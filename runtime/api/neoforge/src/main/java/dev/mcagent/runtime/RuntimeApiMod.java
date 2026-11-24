package dev.mcagent.runtime;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;

@Mod(Constants.MOD_ID)
public class RuntimeApiMod {

    public RuntimeApiMod(IEventBus eventBus, ModContainer container) {
        // Scheduler heartbeat: every tick drives task selection, execution and settlement for every Bot.
        // Hooked on Pre (before entity updates), so the movement and key inputs that task, navigation and
        // executor set are consumed by this tick's entity physics: a decision made at position P acts on the
        // step that starts from P, with no one-tick input lag. Edge timings such as sneak and jump release
        // depend on this.
        NeoForge.EVENT_BUS.addListener((net.neoforged.neoforge.event.tick.ServerTickEvent.Pre e) -> {
            if (!dev.mcagent.runtime.sdk.RuntimeSdkLifecycle.simulationSuspended(e.getServer())) {
                dev.mcagent.runtime.task.BotTickDispatcher.tick(e.getServer());
            }
        });
        NeoForge.EVENT_BUS.addListener((net.neoforged.neoforge.event.tick.ServerTickEvent.Post e) -> {
            dev.mcagent.runtime.sdk.RuntimeSimulationControl.forServer(e.getServer()).afterTick();
            dev.mcagent.runtime.sdk.RuntimeSdkLifecycle.tick(e.getServer());
            dev.mcagent.runtime.benchmark.BenchmarkAuthorityLifecycle.tick(e.getServer());
        });

        NeoForge.EVENT_BUS.addListener((net.neoforged.neoforge.event.server.ServerStartedEvent e) -> {
            dev.mcagent.runtime.bot.RuntimeBotManager.start(e.getServer(), System.getenv());
            dev.mcagent.runtime.sdk.RuntimeSdkLifecycle.start(e.getServer());
            dev.mcagent.runtime.benchmark.BenchmarkAuthorityLifecycle.start(e.getServer());
        });
        NeoForge.EVENT_BUS.addListener(
                dev.mcagent.runtime.sdk.RuntimeSdkLifecycle::onLivingDamage);

        // Server stopped: all in-process state that belongs to that world is discarded. Leaving a
        // single-player save does not end the process, so static tables would otherwise survive into the next
        // save. Each holder registers its own cleanup; see ServerLifecycle.
        NeoForge.EVENT_BUS.addListener((net.neoforged.neoforge.event.server.ServerStoppedEvent e) -> {
            dev.mcagent.runtime.benchmark.BenchmarkAuthorityLifecycle.stop(e.getServer());
            dev.mcagent.runtime.sdk.RuntimeSdkLifecycle.stop(e.getServer());
            dev.mcagent.runtime.bot.RuntimeBotManager.stop(e.getServer());
            dev.mcagent.runtime.platform.ServerLifecycle.fireStopped();
        });

        CommonClass.init();
        Constants.LOG.info("EviCraft Runtime API initialised on NeoForge.");
    }
}
