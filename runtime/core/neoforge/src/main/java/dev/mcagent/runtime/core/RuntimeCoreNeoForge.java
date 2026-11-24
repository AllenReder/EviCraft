package dev.mcagent.runtime.core;

import dev.mcagent.runtime.combat.RuntimeCombatAttributionEvents;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/**
 * NeoForge entry point for the core module tool pack. Registers the tools and
 * task runners into the api module engine, then wires the server-tick work its
 * tools need (budget-sliced block scans, the off-thread pathfinder's chunk
 * snapshots). The engine itself is brought up by the separate api module mod,
 * which core depends on.
 */
@Mod(Constants.MOD_ID)
public class RuntimeCoreNeoForge {

    public RuntimeCoreNeoForge(IEventBus eventBus, ModContainer container) {
        RuntimeCore.init();

        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,
                RuntimeCombatAttributionEvents::onLivingDeath);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,
                RuntimeCombatAttributionEvents::onLivingDrops);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,
                RuntimeCombatAttributionEvents::onProjectileImpact);
        Constants.LOG.info("EviCraft Runtime tool pack initialised on NeoForge.");
    }

}
