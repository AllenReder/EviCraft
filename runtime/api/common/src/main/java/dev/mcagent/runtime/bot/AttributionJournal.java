package dev.mcagent.runtime.bot;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.phys.Vec3;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.UUID;

/**
 * Exact physical receipts owned by one World Run, including late projectile/drop outcomes.
 * Death, respawn, dimension changes and SDK reconnection do not erase world facts. The
 * enclosing ActiveRun releases this journal at server stop. Each stream retains at most
 * 256 receipts; consume methods remove only the exact UUID and never grant target authority.
 */
final class AttributionJournal {
    private static final int LIMIT = 256;
    private final LinkedHashMap<UUID, RuntimeBotManager.AttributableDeath> deaths = new LinkedHashMap<>();
    private final LinkedHashMap<UUID, RuntimeBotManager.AttributablePickup> pickups = new LinkedHashMap<>();
    private final LinkedHashMap<UUID, EyeOfEnder> launches = new LinkedHashMap<>();
    private final LinkedHashSet<UUID> eyes = new LinkedHashSet<>();
    private final LinkedHashMap<UUID, RuntimeBotManager.EnderEyeTerminal> terminals = new LinkedHashMap<>();
    private final Deque<PendingImpact> impacts = new ArrayDeque<>();

    void death(RuntimeBotManager.AttributableDeath death) {
        deaths.put(death.uuid(), death);
        trim(deaths);
    }

    RuntimeBotManager.AttributableDeath consumeDeath(UUID uuid) { return deaths.remove(uuid); }

    void pickup(UUID uuid, int count, boolean complete) {
        pickups.compute(uuid, (key, previous) -> new RuntimeBotManager.AttributablePickup(
                (previous == null ? 0 : previous.count()) + count, complete));
        trim(pickups);
    }

    RuntimeBotManager.AttributablePickup pickup(UUID uuid) { return pickups.get(uuid); }

    void launch(UUID body, EyeOfEnder eye) {
        launches.put(body, eye);
        eyes.add(eye.getUUID());
        terminals.remove(eye.getUUID());
        trim(launches);
        trim(eyes);
    }

    EyeOfEnder consumeLaunch(UUID body) { return launches.remove(body); }
    boolean ownsEye(UUID eye) { return eyes.contains(eye); }

    void terminal(UUID eye, RuntimeBotManager.EnderEyeTerminal terminal) {
        terminals.put(eye, terminal);
        trim(terminals);
    }

    RuntimeBotManager.EnderEyeTerminal consumeTerminal(UUID eye) {
        var terminal = terminals.remove(eye);
        if (terminal != null) eyes.remove(eye);
        return terminal;
    }

    void impact(Entity target) {
        impacts.addLast(new PendingImpact(target, target.position(),
                target.level().dimension().location().toString(), target.getServer().getTickCount()));
        while (impacts.size() > LIMIT) impacts.removeFirst();
    }

    PendingImpact pollImpact() { return impacts.pollFirst(); }

    private static void trim(LinkedHashMap<?, ?> records) {
        while (records.size() > LIMIT) records.remove(records.keySet().iterator().next());
    }

    private static void trim(LinkedHashSet<?> records) {
        while (records.size() > LIMIT) records.remove(records.iterator().next());
    }

    record PendingImpact(Entity target, Vec3 position, String dimension, long observedTick) {}
}
