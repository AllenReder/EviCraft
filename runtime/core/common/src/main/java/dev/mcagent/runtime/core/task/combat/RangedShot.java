package dev.mcagent.runtime.core.task.combat;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.act.Ballistics;
import dev.mcagent.runtime.core.combat.Loadout;
import dev.mcagent.runtime.entity.BotPlayer;

import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.BowItem;
import net.minecraft.world.item.CrossbowItem;
import net.minecraft.world.item.ItemStack;

/**
 * The full lifecycle of one shot: draw/load → aim → release → confirm the projectile left.
 *
 * <h2>Why a state machine</h2>
 * Vanilla ranged weapons do not fire from a single method call. A bow must be held to charge, with power
 * growing with the ticks held; a crossbow first spends tens of ticks loading and can fire only once loaded.
 * Swapping items, interruptions, or running out of arrows can all stop the sequence halfway. So something
 * must remember "which step am I at", rather than re-deciding from scratch every tick.
 *
 * <h2>Misfires must be detected</h2>
 * Releasing does not mean an arrow flew. {@link State#SETTLING} gives vanilla a few ticks to actually spawn
 * the projectile; if nothing happens by then, a misfire is recorded. Without this state, a crossbow with no
 * arrows would keep the Bot drawing in place indefinitely.
 */
final class RangedShot {

    /** Draw ticks at which a bow is at full power (drawing longer adds nothing). */
    private static final int BOW_RELEASE_TICKS = 15;
    /** Maximum bow draw; release even if not aimed by then, so the draw never lasts forever. */
    private static final int BOW_MAX_DRAW_TICKS = 40;
    /** Loading longer than this many ticks means it cannot load (no arrows, item swapped). */
    private static final int CROSSBOW_LOAD_TIMEOUT = 80;
    /** Ticks to wait after release to confirm the projectile actually spawned. */
    private static final int SETTLE_TICKS = 4;
    /** Aimed when the angle between line of sight and trajectory is within this. */
    static final double AIM_THRESHOLD_DEGREES = 1.5;

    private enum State { USING, READY_TO_FIRE, SETTLING, DONE, MISFIRE }

    private final BotPlayer player;
    private final boolean crossbow;
    private State state = State.USING;
    private int held;
    private int settle;
    private boolean fired;

    RangedShot(BotPlayer player, boolean crossbow) {
        this.player = player;
        this.crossbow = crossbow;
        player.gameMode.useItem(player, player.level(), player.getMainHandItem(), InteractionHand.MAIN_HAND);
    }

    /** Whether the held item is still this shot's weapon; if swapped, the shot is void and restarts. */
    static boolean stillHolding(boolean crossbow, ItemStack stack) {
        return crossbow ? stack.getItem() instanceof CrossbowItem : stack.getItem() instanceof BowItem;
    }

    /** Converts draw ticks to an arrow speed multiplier (vanilla formula). */
    static double bowPowerForTicks(int ticks) {
        double draw = ticks / 20.0;
        double power = (draw * draw + draw * 2.0) / 3.0;
        return Math.min(1.0, Math.max(0.0, power));
    }

    /** Release only when aimed and drawn enough. */
    static boolean canRelease(double angleDegrees, int heldTicks, int releaseTicks) {
        return angleDegrees <= AIM_THRESHOLD_DEGREES && heldTicks >= releaseTicks;
    }

    /** Projectile speed for this shot: a bow's depends on draw ticks so far; a crossbow's is constant. */
    double projectileVelocity(double bowFullSpeed, double crossbowSpeed) {
        if (crossbow) {
            return crossbowSpeed;
        }
        return bowFullSpeed * bowPowerForTicks(Math.max(BOW_RELEASE_TICKS, held + 1));
    }

    /** @return true when this shot is over (fired or misfired) */
    boolean tick(Ballistics.Aim aim, Entity target) {
        switch (state) {
            case USING -> tickUsing(aim, target);
            case READY_TO_FIRE -> tickReadyToFire(aim, target);
            case SETTLING -> tickSettling();
            default -> { return true; }
        }
        return state == State.DONE || state == State.MISFIRE;
    }

    boolean fired() {
        return fired;
    }

    /**
     * Whether to turn and aim this tick.
     *
     * <p><b>No aiming is needed while drawing</b>: a vanilla arrow's direction depends only on the line of
     * sight <b>at the moment of release</b>. Turning every tick also skews the feet (movement is projected
     * along the facing), walking the Bot straight into the target. Turning only just before release keeps the
     * footwork clean for the dozen or so ticks in between, the same way melee swings already work.
     */
    boolean aboutToRelease() {
        return crossbow ? state == State.READY_TO_FIRE : held >= BOW_RELEASE_TICKS - 1;
    }

    void abort() {
        if (player.isUsingItem()) {
            player.stopUsingItem();
        }
    }

    private void tickUsing(Ballistics.Aim aim, Entity target) {
        ItemStack weapon = player.getMainHandItem();
        if (crossbow) {
            if (CrossbowItem.isCharged(weapon)) {
                state = State.READY_TO_FIRE;
                tickReadyToFire(aim, target);
            } else if (!player.isUsingItem()) {
                state = State.SETTLING;
            } else if (++held >= CrossbowItem.getChargeDuration(weapon, player)) {
                player.releaseUsingItem();
                state = State.READY_TO_FIRE;
                settle = 0;
            } else if (held >= CROSSBOW_LOAD_TIMEOUT) {
                player.stopUsingItem();
                state = State.SETTLING;
            }
            return;
        }
        if (!player.isUsingItem()) {
            state = State.SETTLING;
            return;
        }
        held++;
        double angle = Ballistics.angleDegrees(player.getViewVector(1.0f), aim.direction());
        if (canRelease(angle, held, BOW_RELEASE_TICKS) || held >= BOW_MAX_DRAW_TICKS) {
            player.releaseUsingItem();
            markFired(aim, target);
        }
    }

    private void tickReadyToFire(Ballistics.Aim aim, Entity target) {
        ItemStack weapon = player.getMainHandItem();
        if (!CrossbowItem.isCharged(weapon)) {
            if (++settle >= SETTLE_TICKS) {
                state = State.MISFIRE;
            }
            return;
        }
        if (Ballistics.angleDegrees(player.getViewVector(1.0f), aim.direction()) <= AIM_THRESHOLD_DEGREES) {
            player.gameMode.useItem(player, player.level(), weapon, InteractionHand.MAIN_HAND);
            markFired(aim, target);
        }
    }

    private void tickSettling() {
        if (++settle >= SETTLE_TICKS) {
            state = State.MISFIRE;
        }
    }

    private void markFired(Ballistics.Aim aim, Entity target) {
        fired = true;
        if (target != null) {
            Constants.LOG.info("[mc_agent-attack] fired target={} weapon={} held={} dist={} eta={}",
                    target.getId(), crossbow ? "crossbow" : "bow", held,
                    String.format("%.1f", player.distanceTo(target)), Math.ceil(aim.travelTicks()));
        }
        state = State.DONE;
    }

    /** Whether this shot uses a crossbow (determines projectile speed and misfire detection). */
    static boolean isCrossbow(Loadout.Pick pick) {
        return pick.stack().getItem() instanceof CrossbowItem;
    }
}
