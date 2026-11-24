package dev.mcagent.runtime.entity;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * The seam between the engine (which owns the bot body) and tool packs
 * (which own how tasks execute). The engine fires these as a body changes state;
 * a pack subscribes to finalize its own per-bot work (its server-side task
 * queue, in-flight calls, …). This keeps the engine free of any task-system or
 * transport knowledge — it is a scheduler and a body, nothing more.
 *
 * <p>Listeners are invoked on the server body lifecycle that fires the event.
 */
public final class BotLifecycle {

    private static final List<Consumer<BotPlayer>> ON_REMOVE = new CopyOnWriteArrayList<>();
    private static final List<Consumer<BotPlayer>> ON_DEATH = new CopyOnWriteArrayList<>();

    private BotLifecycle() {}

    /** Body is leaving the world (dormancy / dismissal / death-despawn). */
    public static void onRemove(Consumer<BotPlayer> listener) { ON_REMOVE.add(listener); }

    /** Body just died, before the corpse is removed. */
    public static void onDeath(Consumer<BotPlayer> listener) { ON_DEATH.add(listener); }

    public static void fireRemove(BotPlayer body) { for (var l : ON_REMOVE) l.accept(body); }
    public static void fireDeath(BotPlayer body) { for (var l : ON_DEATH) l.accept(body); }
}
