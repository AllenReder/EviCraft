package dev.mcagent.runtime.core.combat;

import dev.mcagent.runtime.core.combat.Battlefield.Foe;

/**
 * What to do this tick, and to whom. <b>Reflex-driven fights and the model's {@code attack} ask the same
 * function</b>: how far to back off from a creeper should not be written once in a reflex and again in a tool.
 *
 * <h2>The input is the whole situation, not one target</h2>
 * See {@link Battlefield}. "Should I evade" concerns the whole field, and so does "whom to hit" (pick the
 * nearest, skip the unhittable, remember the one hit last tick). Hung on a single-target description, every
 * new concern adds a field, and a wrong ordering produces "the Bot fights a slime while a creeper ignites
 * next to it".
 *
 * <h2>It has memory</h2>
 * {@link #decide} takes the previous tick's decision. Two things need it: <b>hysteresis</b> (while already
 * swinging, a target stepping back slightly should not make the Bot restart pathfinding at once) and
 * <b>commitment</b> (finish the chosen target before switching; otherwise, in a group of splitting mobs,
 * "the nearest one" changes every tick and the Bot keeps turning). A memoryless decision forces callers to
 * patch around it.
 *
 * <h2>It does not handle survival</h2>
 * Low health, being surrounded, empty hands: none of these trigger disengagement. Whether to keep fighting
 * and when to flee are strategic decisions for the Harness hazard and the model, not for this tactical
 * decision. It only does this: attack while there are targets, finish when there are none.
 */
public final class AttackPlan {

    /** What to do this tick. */
    public enum Action {
        /**
         * Footwork. <b>This is a movement action, not "strike or not"</b>: striking is decided independently
         * by the attack system every tick (strike when the cooldown is ready and the target is in reach),
         * regardless of whether the Bot is closing in or backing off.
         *
         * <p>Approach and retreat are deliberately not separate actions: if they were, neither would swing,
         * so the Bot would not hit back while evading and could not catch a skeleton backing off while
         * shooting.
         */
        SKIRMISH,
        /**
         * Bow combat. <b>The same shape as {@link #SKIRMISH}, with a different ring</b>: the inner edge is
         * "far enough to draw the bow" and the outer edge is the bow's range. Inside the band the navigation
         * arrives on its own, the Bot stops, and the attack layer draws the bow fully, so "when to stand
         * still" needs no separate logic.
         *
         * <p>The sword's ring is {@code [it reaches me 2.02, I reach it 3.30]}. Used for a bow, the two
         * conflict: the ring pulls the Bot toward 3.3 while the bow needs five blocks of distance, so the Bot
         * never reaches firing distance and only inches along after the mob, jittering at the edge.
         */
        BOW,
        /** Nothing left to attack. */
        DONE
    }

    /**
     * A decision.
     *
     * @param action what to do
     * @param foeId  to whom; {@link Action#DONE} applies to the whole field, and then this is {@link #NO_FOE}
     */
    public record Move(Action action, int foeId) {}

    public static final int NO_FOE = Integer.MIN_VALUE;

    private AttackPlan() {}

    /**
     * @param last the previous tick's decision; {@code null} on the first call
     */
    public static Move decide(Battlefield b, Move last) {
        // "Cannot survive this" is not decided here: disengaging belongs to the Harness hazard and the model;
        // this decision only covers how to fight. Fleeing automatically on low health would take over the
        // fight without the model knowing.
        //
        // "Nothing in hand to fight with" does not disengage either: empty hands only mean no target can be
        // picked; the Bot keeps its footwork until the model or the Harness decides what is next. Fleeing
        // automatically when hit bare-handed would look to the model like the fight ended.
        //
        // "Too close to something explosive" is not decided here. For a lit creeper <b>the danger radius is
        // its blast range</b> (6.71 blocks), and the inner edge of the footwork ring pushes the Bot beyond it
        // on its own. A separate evade action would make "evade the blast" and footwork two exclusive states,
        // and the evading branch would not hit back.
        //
        // "Too close" is not decided here. It is <b>pathfinding's job</b>: the combat footwork goal is a ring,
        // whose inner edge is "the target cannot reach the Bot" and whose outer edge is "do not lose it". Too
        // close moves outward and too far moves back on its own. A separate back-off action would make
        // backing off and footwork exclusive states, and the back-off branch would not swing.
        //
        // This decision answers only two things: <b>bow or footwork</b>, and <b>whom to hit</b>.
        Foe foe = pick(b, last);
        if (foe != null) {
            return new Move(actionAgainst(b, foe), foe.id());
        }
        // No target can be picked, but something is still chasing the Bot: <b>this is not "nothing to
        // attack"</b>. The Bot keeps its footwork, with the ring reduced to "outside every threat's danger
        // radius"; once a fuse goes out or another mob closes in, the next tick will have a target.
        if (anyEngaging(b)) {
            return new Move(Action.SKIRMISH, NO_FOE);
        }
        return new Move(Action.DONE, NO_FOE);
    }

    /**
     * Whom to hit. <b>Nearest first, but once chosen, finish it before switching</b>: reselecting by distance
     * every tick would make "the nearest one" in a group of splitting slimes change every tick, so the Bot
     * would keep turning, and every turn discards the path just computed.
     */
    private static Foe pick(Battlefield b, Move last) {
        Foe kept = last == null ? null : b.byId(last.foeId());
        if (kept != null && fightable(b, kept)) {
            return kept;
        }
        Foe best = null;
        for (Foe f : b.foes()) {
            if (!fightable(b, f)) {
                continue;
            }
            if (best == null || f.distance() < best.distance()
                    || (f.distance() == best.distance() && f.id() < best.id())) {
                best = f;
            }
        }
        return best;
    }

    /**
     * Whether this foe is worth targeting.
     *
     * <p><b>An armed explosive is never a target without a ranged option</b>: the Bot should keep away from
     * it, not hit it. As a candidate it would make the decision oscillate at the safety line between evading
     * and abandoning, getting reselected on the tick after being abandoned, several times per second.
     * Keeping away from it is footwork, not a question of whom to hit.
     */
    private static boolean fightable(Battlefield b, Foe f) {
        if (!f.authorized()) {
            return false;
        }
        // A creeper with an unlit fuse is an ordinary mob: the Bot reaches 4 blocks and it ignites only at 3,
        // and the one-block band between lets the Bot hit it without triggering it. Excluding all explosives
        // would leave the Bot circling forever, never resolving it.
        return !f.armed() || b.hasRanged();
    }

    /**
     * Which style to use against this foe. <b>Only two things matter: whether it can be reached, and what is
     * in hand.</b>
     *
     * <pre>
     * reachable and a melee weapon is available   → sword combat (saves arrows)
     * unreachable, or only a bow                  → bow combat
     * explosive with a lit fuse                   → bow combat (closing in would set it off)
     * neither weapon                              → fists, treated as sword combat
     * </pre>
     *
     * <p><b>"Unreachable and unshootable" is not handled here</b>: such a foe should no longer be a target.
     * The task layer revokes its authorization the moment pathfinding reports NO-PATH, so {@link #fightable}
     * never selects it.
     */
    private static Action actionAgainst(Battlefield b, Foe foe) {
        if (!b.hasRanged()) {
            return Action.SKIRMISH;   // no bow: reachable or not, the only option is to close in
        }
        if (foe.armed() || !foe.reachable() || !b.hasMelee()) {
            return Action.BOW;
        }
        return Action.SKIRMISH;
    }

    private static boolean anyEngaging(Battlefield b) {
        return b.foes().stream().anyMatch(Foe::engaging);
    }
}
