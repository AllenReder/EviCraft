package dev.mcagent.runtime.core.combat;

import dev.mcagent.runtime.core.combat.Battlefield.Foe;

import org.junit.jupiter.api.Test;

import java.util.List;

import static dev.mcagent.runtime.core.combat.AttackPlan.Action;
import static dev.mcagent.runtime.core.combat.AttackPlan.Move;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What to do this tick, and to whom.
 *
 * <p>The decision takes the <b>whole situation</b>, not one target: a single-target description has no
 * place for global danger, which is how the Bot ends up fighting a slime while a creeper blows it up.
 */
class AttackPlanTest {

    private static final double HEALTHY = 40.0;

    private static Foe mob(int id, double distance) {
        return new Foe(id, distance, false, false, true, true, true);
    }

    /** A creeper with a lit fuse. */
    private static Foe creeper(int id, double distance) {
        return new Foe(id, distance, true, true, true, true, true);
    }

    /** A creeper with an unlit fuse: an ordinary mob as far as the decision is concerned. */
    private static Foe idleCreeper(int id, double distance) {
        return new Foe(id, distance, true, false, true, true, true);
    }

    private static Battlefield field(boolean melee, boolean ranged, Foe... foes) {
        return new Battlefield(HEALTHY, melee, ranged, List.of(foes));
    }

    // ==================== Reachability ====================

    @Test
    void withinReachSheSwings() {
        Move m = AttackPlan.decide(field(true, true, mob(1, 3.0)), null);
        assertEquals(Action.SKIRMISH, m.action());
        assertEquals(1, m.foeId());
    }

    /** Even with a bow, walk over and strike: arrows should not be spent on a reachable target. */
    @Test
    void reachableButFarSheWalksThereRatherThanSpendArrows() {
        assertEquals(Action.SKIRMISH,
                AttackPlan.decide(field(true, true, mob(1, 20.0)), null).action());
    }

    /** Ranged only when unreachable: ghasts, targets across a cliff, or on a pillar take this branch. */
    @Test
    void unreachableIsWhatBowsAreFor() {
        Foe far = new Foe(1, 20.0, false, false, true, false, true);
        assertEquals(Action.BOW, AttackPlan.decide(field(true, true, far), null).action());
    }

    @Test
    void unreachableWithNoBowIsGivenUp() {
        Foe far = new Foe(1, 20.0, false, false, true, false, true);
        assertEquals(Action.SKIRMISH, AttackPlan.decide(field(true, false, far), null).action());
    }

    // ==================== Global danger ====================

    /** Once the blast threat is beyond the safety line, go back to fighting the original target. */
    @Test
    void onceTheBlastIsClearSheGoesBackToFighting() {
        Battlefield b = field(true, true, mob(1, 3.0), creeper(2, 9.0));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, new Move(Action.SKIRMISH, 1)).action());
    }

    // ==================== Explosives ====================

    /**
     * A lit creeper is <b>not a separate action</b>. Its danger radius is the blast range (6.71 blocks), and
     * the inner edge of the footwork ring pushes the Bot beyond it on its own; evading the blast is not a
     * state exclusive with footwork.
     */
    @Test
    void aLitCreeperIsHandledByTheRingNotByAnAction() {
        Move m = AttackPlan.decide(field(true, true, creeper(1, 3.0)), null);
        assertEquals(Action.BOW, m.action(), "with a bow, shoot it from range");
    }

    /** With a bow: back off beyond the safety line and shoot it. */
    @Test
    void withABowAnExplosiveTargetIsShotFromOutside() {
        Move m = AttackPlan.decide(field(true, true, creeper(1, 9.0)), null);
        assertEquals(Action.BOW, m.action());
        assertEquals(1, m.foeId());
    }

    /**
     * No target can be picked but something is still chasing the Bot: <b>keep the footwork; do not flee</b>.
     *
     * <p>With only a lit creeper left (unhittable without a bow), backing off about seven blocks is enough for
     * the fuse to wind down; fleeing far would be wrong for a healthy, armed Bot. "This one cannot be hit right
     * now" is not a reason to run.
     */
    @Test
    void nothingWorthHittingIsStillNotAReasonToRun() {
        Move m = AttackPlan.decide(field(true, false, creeper(1, 3.0)), null);
        assertEquals(Action.SKIRMISH, m.action());
        assertEquals(AttackPlan.NO_FOE, m.foeId(), "a field-wide action targets no single foe");
    }

    /** Without a bow, it must not take the turn from a mob that can be fought. */
    @Test
    void anUnfightableExplosiveDoesNotStealTheTurnFromAFightableMob() {
        Battlefield b = field(true, false, creeper(1, 8.0), mob(2, 9.0));
        Move m = AttackPlan.decide(b, null);
        assertEquals(Action.SKIRMISH, m.action());
        assertEquals(2, m.foeId(), "should go hit the zombie, not circle the creeper");
    }

    /**
     * <b>A creeper with an unlit fuse is an ordinary mob.</b> The Bot reaches 4 blocks and it ignites only at
     * 3, and the one-block band between lets the Bot hit it without triggering it. Excluding all explosives
     * would leave the Bot circling forever, never resolving it.
     */
    @Test
    void aCreeperThatHasNotLitYetIsJustAMob() {
        Move m = AttackPlan.decide(field(true, false, idleCreeper(1, 3.5)), null);
        assertEquals(Action.SKIRMISH, m.action());
        assertEquals(1, m.foeId());
    }

    /** A bit farther away, walk over to it, as with any other mob. */
    @Test
    void anUnlitCreeperIsWalkedUpToLikeAnythingElse() {
        assertEquals(Action.SKIRMISH,
                AttackPlan.decide(field(true, false, idleCreeper(1, 9.0)), null).action());
    }

    // ==================== Whom to hit: nearest first, with commitment ====================

    @Test
    void theNearestOneGoesFirst() {
        Battlefield b = field(true, true, mob(1, 9.0), mob(2, 4.5));
        assertEquals(2, AttackPlan.decide(b, null).foeId());
    }

    /**
     * Once chosen, finish it before switching. In a group of splitting slimes "the nearest one" changes every
     * tick, and every switch discards the path just computed, so the target would bounce among them while
     * each new path is judged arrived immediately.
     */
    @Test
    void sheStaysOnTheOneSheChose() {
        Battlefield b = field(true, true, mob(1, 9.0), mob(2, 4.5));
        assertEquals(1, AttackPlan.decide(b, new Move(Action.SKIRMISH, 1)).foeId(),
                "was hitting 1 last tick; do not switch even if 2 is closer");
    }

    /** But once it is dead or gone, pick another. */
    @Test
    void whenTheChosenOneIsGoneShePicksAgain() {
        Battlefield b = field(true, true, mob(2, 4.5));
        assertEquals(2, AttackPlan.decide(b, new Move(Action.SKIRMISH, 1)).foeId());
    }

    // ==================== Melee hysteresis ====================

    /** While already swinging, a target stepping back slightly should not make the Bot restart pathfinding at once. */
    @Test
    void onceSwingingSheKeepsSwingingThroughSmallDrift() {
        Battlefield b = field(true, false, mob(1, 4.6));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, new Move(Action.SKIRMISH, 1)).action());
    }

    /** No hysteresis before the fight starts: at the same 4.6 blocks, walk over. */
    @Test
    void beforeTheFirstSwingTheBandIsTheReachItself() {
        Battlefield b = field(true, false, mob(1, 4.6));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, null).action());
    }

    /** Drifting far enough still means chasing: hysteresis is a band, not an indefinite exemption. */
    @Test
    void driftingWellOutOfBandStillMeansWalking() {
        Battlefield b = field(true, false, mob(1, 7.0));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, new Move(Action.SKIRMISH, 1)).action());
    }

    // ==================== What is in hand ====================

    /**
     * With only a bow, <b>it is a bow fight at any distance</b>; there is no switching between two actions by
     * distance.
     *
     * <p>Switching would give SKIRMISH up close, and the sword's ring pulls the Bot toward 3.3 blocks, closer
     * than the five blocks the bow needs, so the Bot would never reach firing distance and only inch along
     * after the mob. The bow has its own ring, which handles backing off.
     */
    @Test
    void withOnlyABowItIsAlwaysABowFight() {
        assertEquals(Action.BOW,
                AttackPlan.decide(field(false, true, mob(1, 3.0)), null).action());
        assertEquals(Action.BOW,
                AttackPlan.decide(field(false, true, mob(1, 12.0)), null).action());
    }

    /** Neither weapon, against something that hits back: no disengagement; fight bare-handed until the Harness interrupts. */
    @Test
    void barehandedAgainstSomethingThatFightsBackKeepsFighting() {
        Move m = AttackPlan.decide(field(false, false, mob(1, 3.0)), null);
        assertEquals(Action.SKIRMISH, m.action());
        assertEquals(1, m.foeId(), "bare hands are a weapon too; still picks a target");
    }

    /** Bare-handed against something harmless is fine (the model named a chicken as the target). */
    @Test
    void barehandedAgainstSomethingHarmlessIsFine() {
        Foe chicken = new Foe(1, 3.0, false, false, false, true, true);
        assertEquals(Action.SKIRMISH,
                AttackPlan.decide(field(false, false, chicken), null).action());
    }

    // ==================== Survivability ====================

    /** No disengagement even when unable to take more: that belongs to the Harness; the decision only covers how to fight. */
    @Test
    void tooHurtKeepsFightingWhenTheTargetIsInReach() {
        Battlefield b = new Battlefield(4.0, true, true, List.of(mob(1, 3.0)));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, null).action());
    }

    /** Low health keeps fighting: disengagement is not an option of this decision. */
    @Test
    void lowHealthDoesNotChangeThePlan() {
        Battlefield b = new Battlefield(4.0, true, true, List.of(creeper(1, 3.0)));
        assertEquals(Action.BOW, AttackPlan.decide(b, null).action());
    }

    /** Even with a way out, no retreat: this decision does not disengage. */
    @Test
    void withAWayOutSheStillFights() {
        Battlefield b = new Battlefield(4.0, true, true, List.of(mob(1, 3.0)));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, null).action());
    }

    // ==================== Finishing ====================

    @Test
    void anEmptyFieldIsDone() {
        assertEquals(Action.DONE, AttackPlan.decide(field(true, true), null).action());
    }

    /** Unauthorized foes do not count: mobs remain on the field, but none belong to this fight. */
    @Test
    void unauthorizedFoesDoNotKeepTheFightAlive() {
        Foe stranger = new Foe(1, 3.0, false, false, false, true, false);
        assertEquals(Action.DONE, AttackPlan.decide(field(true, true, stranger), null).action());
    }

    // ==================== Someone inside the danger radius ====================

    /**
     * When someone is inside its danger radius the Bot should reposition, <b>regardless of whom it is
     * fighting</b>.
     *
     * <p>The pathfinding goal is a <b>snapshot taken when the path was planned</b>, and it does not
     * invalidate itself when other mobs close in; only this decision re-asks with live distances every tick.
     */
    @Test
    void someoneInsideHisRadiusMeansMovingFirst() {
        Battlefield b = field(true, true, mob(1, 5.0), mob(2, 2.0));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, null).action());
    }

    /**
     * Outside the radius, fight again, <b>no hysteresis needed</b>: the Bot's reach exceeds the foe's danger
     * radius by half a block to a block (zombie: 3.30 vs. 2.73), so backing off to the edge is enough. That gap
     * comes from vanilla hitboxes, not from tuning.
     */
    @Test
    void justOutsideTheRadiusSheFightsAgain() {
        Battlefield b = field(true, true, mob(1, 3.0));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, null).action());
        assertEquals(Action.SKIRMISH,
                AttackPlan.decide(b, new Move(Action.SKIRMISH, AttackPlan.NO_FOE)).action());
    }

    /** Distant mobs should not make the Bot turn away; only those inside the radius count. */
    @Test
    void distantMobsDoNotScareHer() {
        Battlefield b = field(true, true, mob(1, 3.0), mob(2, 8.0), mob(3, 11.0));
        assertEquals(Action.SKIRMISH, AttackPlan.decide(b, null).action());
    }

    // ==================== Bare-handed ====================

    /**
     * Bare-handed inside the danger radius: <b>keep fighting</b>, with no separate evade or disengage action.
     *
     * <p>Two rules firing in turn at the radius would make the decision alternate on that line, and each
     * action would take a different execution branch and rebuild navigation every time.
     */
    @Test
    void barehandedInsideTheRadiusKeepsFighting() {
        Move m = AttackPlan.decide(field(false, false, mob(1, 2.0)), null);
        assertEquals(Action.SKIRMISH, m.action());
        assertEquals(1, m.foeId());
    }

    /** The same outside the radius: fight bare-handed. */
    @Test
    void barehandedOutsideTheRadiusStillFights() {
        Move m = AttackPlan.decide(field(false, false, mob(1, 4.0)), null);
        assertEquals(Action.SKIRMISH, m.action());
        assertEquals(1, m.foeId());
    }

    /** Armed inside the radius: reposition and keep fighting. */
    @Test
    void armedInsideTheRadiusIsAReposition() {
        assertEquals(Action.SKIRMISH,
                AttackPlan.decide(field(true, false, mob(1, 2.0)), null).action());
    }
}
