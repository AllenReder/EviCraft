package dev.mcagent.runtime.task;

import dev.mcagent.runtime.entity.BotPlayer;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * core module's server-tick driver of bot tasks. The engine (the api module)
 * owns the body and is a pure scheduler; <em>task execution</em> is core's, so the
 * per-bot scheduler ({@link BotBrain}) lives here (keyed by bot
 * UUID), not on the body.
 *
 * <p>Each tick, for the live {@link BotPlayer}, the brain ticks the
 * highest-priority active chain. Registered from core's end-of-tick hooks and
 * finalised on body removal or death via the engine's lifecycle seam.
 *
 * <p>This class is a thin facade over {@link BotBrain}
 * — {@link #queueFor} and the three lifecycle finalizers are the API that tools
 * ({@code TaskDispatch.enqueue}, {@code WaitTool}) and the lifecycle wiring
 * depend on; all scheduling lives in the brain.
 */
@dev.mcagent.runtime.api.Internal
public final class BotTickDispatcher {

    private static final Map<UUID, BotBrain> BRAINS = new HashMap<>();

    /** UUIDs already warned about having two bodies; each Bot is warned once. */
    private static final java.util.Set<UUID> duplicateWarned = new java.util.HashSet<>();

    static {
        // Brains belong to the world, not the process: leaving a save discards the whole table, and the next
        // save starts empty. See ServerLifecycle; without this, tasks bound to old bodies would run in the
        // new world.
        dev.mcagent.runtime.platform.ServerLifecycle.onStopped(BotTickDispatcher::dropAll);
    }

    private BotTickDispatcher() {}

    /**
     * The world is gone, so the brains go too. The heartbeat flag is reset as well: it proves that this
     * server's tick hook is connected, which every server must prove again.
     */
    static void dropAll() {
        BRAINS.clear();
        duplicateWarned.clear();
        heartbeatLogged = false;
    }

    private static BotBrain brainFor(UUID botUuid) {
        return BRAINS.computeIfAbsent(botUuid, k -> new BotBrain());
    }

    /** The synchronous-action slot a turn waits on (creates the brain on first use). */
    static TaskSlot syncSlotFor(UUID botUuid) {
        return brainFor(botUuid).sync;
    }

    /** The slot for what the Bot is doing now (creates the brain on first use). */
    static TaskSlot currentSlotFor(UUID botUuid) {
        return brainFor(botUuid).current;
    }

    /** One-time heartbeat log: proves the scheduler's tick hook is connected. Check it first when nothing runs. */
    private static boolean heartbeatLogged;

    public static void tick(MinecraftServer server) {
        if (!heartbeatLogged) {
            heartbeatLogged = true;
            dev.mcagent.runtime.Constants.LOG.info("[mc_agent-task] scheduler heartbeat online (first server tick)");
        }
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (player instanceof BotPlayer body) {
                // External teleports can place a body in a not-yet-ticking chunk. Synchronize the
                // ordinary vanilla player tracking position before World Knowledge samples it.
                dev.mcagent.runtime.bot.RuntimeBotTracking.sync(body);
            }
        }
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            // Death already drained this body's slots. Recreating a brain during
            // the respawn gap can orphan work accepted by the replacement body.
            if (p instanceof BotPlayer ap && ap.isAlive() && !ap.isRemoved()) {
                BotBrain brain = brainFor(ap.getUUID());
                if (!brain.boundTo(ap) && !brain.boundBodyGone()) {
                    // Two bodies with one UUID: the previous one is still in the world and this one is a
                    // duplicate. Do NOT tear down and rebuild: that would spin between the two bodies forever,
                    // twice per tick, replaying the Bot's work each time. Warn once and skip; the root cause
                    // is the Bot being revived twice (see ExecuteToolPayload).
                    if (duplicateWarned.add(ap.getUUID())) {
                        dev.mcagent.runtime.Constants.LOG.warn(
                                "[mc_agent-task] {} has two bodies in the player list at once; ignoring the later one", ap.getUUID());
                    }
                    continue;
                }
                if (!brain.boundTo(ap)) {
                    // Unreachable (server stop already cleared the table); reaching it means something leaked,
                    // so log loudly. Discard the whole brain: its tasks are bound to the old body and none may
                    // tick again.
                    dev.mcagent.runtime.Constants.LOG.warn(
                            "[mc_agent-task] {} changed bodies but the old brain is still there; discarding it and rebuilding", ap.getUUID());
                    BRAINS.remove(ap.getUUID());
                    brain = brainFor(ap.getUUID());
                }
                brain.tick(ap);
            }
        }
    }

    /**
     * Drop work on death. The disabled owner client already resolves calls from its death payload;
     * Runtime SDK calls instead receive one interrupted terminal result from the scheduler bridge.
     */
    public static void clearActiveTask(BotPlayer player) {
        BotBrain brain = BRAINS.remove(player.getUUID());   // never create: a late death
        if (brain != null) brain.dropActiveOnDeath(player);       // respawn starts with empty slots
    }

    /** What the Bot is doing now; null = empty slot (the Bot stands). Used by task_status. */
    public static TaskRecord currentTaskFor(UUID botUuid) {
        BotBrain brain = BRAINS.get(botUuid);
        return brain == null ? null : brain.current.record();
    }

    /**
     * The task in the slot was just accepted and has not run a tick.
     *
     * <p>Separates two kinds of "dispatch another job": the second one in the same batch of tool calls (the
     * model is planning; refuse it so the model sees the first result before deciding the next step), and
     * one from a new turn (the user or model changed its mind; replace directly). Decidable locally, with
     * no need to pass a turn id to the server.
     */
    public static boolean currentFreshlyAccepted(BotPlayer bot) {
        BotBrain brain = BRAINS.get(bot.getUUID());
        return brain != null && brain.current.freshlyAccepted(bot);
    }

    /** Cancel only the Runtime task with this session-qualified tool-call id. */
    public static boolean cancelMatching(BotPlayer player, String toolCallId) {
        BotBrain brain = BRAINS.get(player.getUUID());
        return brain != null && brain.cancelMatchingAtStablePoint(player, toolCallId);
    }

    /**
     * Finalize a bot's running task because the BODY is leaving the world
     * (server stop or death) — the tick loop only visits players still in
     * the player list, so without this the running task is orphaned and its
     * {@code buildResult} side-effects never run (e.g. a mining dig's crack overlay
     * would stay painted on every viewer until chunk reload).
     */
    public static void onBotRemoved(BotPlayer player) {
        UUID id = player.getUUID();
        BotBrain brain = BRAINS.get(id);
        if (brain != null) {
            brain.finalizeActive(player);
        }
        BRAINS.remove(id);   // the body is gone; don't leak its brain
    }
}
