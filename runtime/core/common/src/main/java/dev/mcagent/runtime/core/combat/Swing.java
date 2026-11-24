package dev.mcagent.runtime.core.combat;

/**
 * When a swing may go out. <b>This is the only definition in the codebase</b>: the combat task and the body
 * action both use it, so the same decision never yields two answers while both hit the same mob.
 */
public final class Swing {

    /**
     * Attack charge at which to strike.
     *
     * <p>Not waiting for 1.0 is deliberate: a sword's cooldown is 12.5 ticks but the counter is an integer, so
     * waiting for full charge costs a whole extra tick. At tick 12 the charge is 0.96 and the damage factor
     * {@code 0.2 + f² × 0.8} = 0.937, i.e. 0.0781/tick; waiting until tick 13 for the full factor 1.0 gives
     * only 0.0769/tick. <b>Striking half a tick early yields more damage per tick</b>.
     * 0.95 is also above vanilla's 0.9 critical-hit threshold, so critical hits are unaffected.
     */
    public static final float ATTACK_READY = 0.95f;

    /**
     * Vanilla player melee reach: the default 3.0 of {@code Attributes.ENTITY_INTERACTION_RANGE}.
     * Used only as a floor: if a mod raises the attribute the reach follows; if lowered, the Bot can still
     * reach something.
     */
    private static final double MIN_REACH = 3.0;

    private Swing() {}

    /** How far the Bot can reach right now, <b>from the eyes to the hitbox</b>: the length of vanilla's ray. */
    public static double reachOf(double nativeInteractionRange) {
        return Math.max(MIN_REACH, nativeInteractionRange);
    }

    /**
     * The <b>center distance</b> at which the Bot can reach {@code target}.
     *
     * <p>Vanilla's 3.0 blocks run from the eyes along the line of sight to the target's <b>hitbox</b>, and the
     * box extends half its width toward the Bot, so the center distance adds that back (this is what
     * {@code entityInteractionRange() + distance} in {@code Player} means).
     *
     * <p>The difference matters: a large slime is 2.04 wide, so its half-width alone exceeds one block.
     * Comparing against a flat 3.0 would judge it out of reach although a vanilla player can hit it. Both the
     * decision and positioning use this value, not the bare 3.0.
     */
    public static double reachTo(double nativeInteractionRange, double targetWidth) {
        return reachOf(nativeInteractionRange) + targetWidth / 2.0;
    }

    /**
     * Whether this swing may go out.
     *
     * @param weaponChanged   the held item changed this tick; no swing then, since attributes have not updated yet
     * @param targetRecovering the target is still in its invulnerability frames, so damage now would be absorbed
     * @param attackStrengthScale vanilla attack charge ({@code getAttackStrengthScale})
     */
    public static boolean mayStrike(boolean weaponChanged, boolean targetRecovering,
                                    float attackStrengthScale) {
        return !weaponChanged && !targetRecovering && attackStrengthScale >= ATTACK_READY;
    }
}
