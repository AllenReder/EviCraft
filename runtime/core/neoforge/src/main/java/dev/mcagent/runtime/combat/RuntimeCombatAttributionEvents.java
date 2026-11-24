package dev.mcagent.runtime.combat;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.EntityObservation;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.phys.EntityHitResult;
import net.neoforged.neoforge.event.entity.ProjectileImpactEvent;
import net.neoforged.neoforge.event.entity.living.LivingDeathEvent;
import net.neoforged.neoforge.event.entity.living.LivingDropsEvent;

/** Exact game-event attribution for Runtime combat deaths, drops, and pickups. */
public final class RuntimeCombatAttributionEvents {

    private RuntimeCombatAttributionEvents() {}

    public static void onLivingDeath(LivingDeathEvent event) {
        if (event.isCanceled()
                || !causedByRuntimeBot(event.getSource(), event.getEntity())) return;
        // LivingDropsEvent is the terminal publication point. It carries the exact death
        // and every vanilla drop in one atomic attributable update (including an empty drop list).
    }

    public static void onLivingDrops(LivingDropsEvent event) {
        if (event.isCanceled()
                || !causedByRuntimeBot(event.getSource(), event.getEntity())) return;
        if (!(event.getEntity().level() instanceof ServerLevel level)) return;
        var drops = event.getDrops().stream().filter(drop -> !drop.getItem().isEmpty())
                .map(drop -> EntityObservation.attributable(drop.getUUID(),
                        BuiltInRegistries.ENTITY_TYPE.getKey(drop.getType()).toString(),
                        BuiltInRegistries.ITEM.getKey(drop.getItem().getItem()).toString(),
                        drop.getItem().getCount(), drop.position(), null, null)).toList();
        RuntimeBotManager.recordAttributableDeathWithDrops(level.getServer(),
                event.getEntity().getUUID(), level.dimension().location().toString(),
                level.getGameTime(), event.getEntity().position(), drops);
    }

    public static void onProjectileImpact(ProjectileImpactEvent event) {
        if (event.isCanceled()
                || !(event.getRayTraceResult() instanceof EntityHitResult hit)
                || hit.getEntity() instanceof LivingEntity) return;
        Projectile projectile = event.getProjectile();
        if (!(projectile.getOwner() instanceof BotPlayer bot)
                || !RuntimeBotManager.isRuntimeBot(bot)) return;
        RuntimeBotManager.recordAttributableProjectileImpact(
                bot.getServer(), hit.getEntity());
    }

    private static boolean causedByRuntimeBot(DamageSource source, LivingEntity victim) {
        Entity causing = source.getEntity();
        if (causing instanceof BotPlayer bot && RuntimeBotManager.isRuntimeBot(bot)) return true;
        LivingEntity killCredit = victim.getKillCredit();
        if (killCredit instanceof BotPlayer bot && RuntimeBotManager.isRuntimeBot(bot)) return true;
        // For a non-player DamageSource (such as a splash potion) source.getEntity() may not be the
        // attacker, but the direct entity still names the immediate cause; attribute it when that is the Bot.
        Entity direct = source.getDirectEntity();
        return direct instanceof BotPlayer bot && RuntimeBotManager.isRuntimeBot(bot);
    }

}
