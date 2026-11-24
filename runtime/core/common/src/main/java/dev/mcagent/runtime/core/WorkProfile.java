package dev.mcagent.runtime.core;

import net.minecraft.server.level.ServerPlayer;

/**
 * The Bot's current work capabilities: the single point that translates the game mode (and, in
 * future, potion effects or server config) into capability facts. Rule: algorithms never read the
 * game mode, only these capability bits. {@code isCreative()/instabuild} may appear only in this
 * class and at snapshot construction; any use in a task loop or Movement is a code smell.
 *
 * <p>No caching: callers fetch a fresh profile at each decision point ({@link #of}), so when the
 * mode is switched externally the next decision sees the new profile and no stale state exists.
 */
public record WorkProfile(
        boolean freeMaterials,   // placing/using does not consume items
        boolean dropsLoot,       // breaking blocks produces drops
        boolean hasHunger,       // hunger applies (must eat; sprinting is gated by food level)
        boolean fearless,        // immune to physical damage such as falling or drowning
        boolean instaBreak) {    // blocks break instantly, regardless of tool tier

    public static final WorkProfile SURVIVAL = new WorkProfile(false, true, true, false, false);
    public static final WorkProfile CREATIVE = new WorkProfile(true, false, false, true, true);

    public static WorkProfile of(ServerPlayer body) {
        return body.getAbilities().instabuild ? CREATIVE : SURVIVAL;
    }
}
