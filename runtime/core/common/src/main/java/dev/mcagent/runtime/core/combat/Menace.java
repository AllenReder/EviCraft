package dev.mcagent.runtime.core.combat;

import dev.mcagent.runtime.core.pathing.goals.GoalAvoidEntities;

import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.damagesource.CombatRules;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.Attribute;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.boss.enderdragon.EndCrystal;
import net.minecraft.world.entity.monster.Creeper;

import java.util.ArrayList;
import java.util.List;

/**
 * "How close to it is dangerous": each mob has one <b>danger radius</b>, and both the decision and
 * pathfinding ask for this one number.
 *
 * <h2>The radius is derived from hitboxes, not hard-coded</h2>
 * Vanilla {@code Mob.isWithinMeleeAttackRange} checks whether "its hitbox, expanded horizontally by
 * {@code DEFAULT_ATTACK_REACH}, intersects the Bot's hitbox", so reach depends on <b>both widths</b>: a
 * spider is 1.4 wide and a zombie 0.6, more than half a block apart. For modded mobs or other body sizes the
 * radius follows automatically.
 *
 * <h2>Exploding mobs are measured differently</h2>
 * A creeper does not melee; its danger is the fuse. Before ignition the danger radius is the <b>ignition
 * line</b> (step inside and it starts to fuse); once ignited it is the <b>blast damage range</b>. Two cases,
 * both values taken from vanilla.
 *
 * <h2>Only one metric</h2>
 * Everything is a <b>center-to-center distance</b>. The decision compares entity positions, pathfinding
 * compares cell centers, and the radius already includes the half cell from a cell center to the farthest
 * point in the cell ({@link #CELL_SLACK}), so "safe by cell center" guarantees "safe at the actual position".
 * If each side used its own metric, the decision would say "evade" while pathfinding says "already clear":
 * the navigation would arrive the moment it is built, without moving a step, and the Bot would stand still
 * and be killed.
 */
public final class Menace {

    /** Vanilla default {@code Creeper.explosionRadius}; doubled when charged. NBT overrides are rare and not tracked. */
    private static final double CREEPER_BLAST_RADIUS = 3.0;

    /** Explosion power of a destroyed end crystal, hard-coded {@code 6.0F} in vanilla. No fuse: it explodes when broken. */
    private static final double CRYSTAL_BLAST_RADIUS = 6.0;

    /**
     * How far vanilla expands a mob's melee check: {@code Mob.DEFAULT_ATTACK_REACH}
     * ({@code Math.sqrt(2.04) - 0.6} ≈ 0.83).
     */
    private static final double MOB_ATTACK_REACH = Math.sqrt(2.04) - 0.6;

    /**
     * Distance from a cell center to the farthest point in the cell (√2/2 ≈ 0.71). <b>A geometric constant,
     * not a tuning parameter</b>.
     *
     * <p>Pathfinding works in block cells, while the Bot may stand in any corner of a cell. Only with this
     * half cell included in the radius does "safe by cell center" equal "safe at the actual position";
     * otherwise the two metrics can differ by up to 1.4 blocks and the decision and pathfinding disagree.
     */
    private static final double CELL_SLACK = Math.sqrt(2.0) / 2.0;

    /**
     * Potential-field strength: the exchange rate from "walking right next to a mob" to "walking a few extra
     * blocks".
     *
     * <p>Calibrated so that <b>going around a mob at the edge of its danger radius is worth one and a half
     * blocks of travel</b>. The potential scales with multiples of the radius; stepping one block back from the
     * radius drops it by 45% ({@code 1 - (3.04/4.04)²}), which times 15 is about 7 cost, while one block of
     * walking costs about 4.6: exactly one and a half blocks.
     *
     * <p><b>It must not be larger</b>: the field enters only the heuristic ({@code h}), not the edge cost
     * ({@code g}). A* may prune only while the heuristic is a lower bound on the remaining cost, and this term
     * grows the wrong way when walking toward a crowd. Once it dominates the travel cost, the search burns its
     * node budget and returns no path; at 800 it cannot even find a two-block retreat.
     */
    public static final double AVOID_PENALTY = 15.0;

    private Menace() {}

    /** It can explode, whether or not it is exploding right now. */
    public static boolean explodes(Entity entity) {
        return entity instanceof Creeper || entity instanceof EndCrystal;
    }

    /**
     * It is <b>about to explode now</b>. A creeper counts only once its fuse is lit; before that it is an
     * ordinary mob. An end crystal <b>has no fuse</b> and explodes the moment it is hit, so it always counts.
     */
    public static boolean armed(Entity entity) {
        return entity instanceof EndCrystal || fusing(entity);
    }

    /**
     * Whether it will attack the Bot. <b>The whole danger-radius machinery applies only to things that
     * attack</b>: chickens, cows, sheep, and villagers do not, so just walk up and hit them, with no spacing,
     * no shield, and no detour.
     *
     * <p>Two checks: naturally hostile ({@link #hostile}), or <b>targeting the Bot right now</b>. The latter
     * covers provoked iron golems, wolves, and zombified piglins, which are not {@code Enemy} but hurt just
     * as much.
     */
    public static boolean threatens(Entity foe, Entity self) {
        if (hostile(foe) || explodes(foe)) {
            return true;
        }
        return foe instanceof Mob mob && mob.getTarget() == self;
    }

    /** The fuse is rising: it is already counting down, not merely "might explode". */
    public static boolean fusing(Entity entity) {
        return entity instanceof Creeper creeper
                && (creeper.getSwellDir() > 0 || creeper.isIgnited());
    }

    /**
     * <b>Danger radius</b>: closer than this and the Bot should evade. The decision and pathfinding call this
     * same function.
     *
     * <p>Includes {@link #CELL_SLACK}, so it can be compared against cell centers directly.
     */
    public static double dangerRadius(Entity foe, Entity self) {
        return rawDangerRadius(foe, self) + CELL_SLACK;
    }

    /**
     * The version without cell-quantization slack, used only in derivations and tests.
     *
     *
     * <p><b>A creeper with an unlit fuse counts as an ordinary mob</b>. Using the ignition line (3.0) plus the
     * cell slack would give 3.71, beyond the Bot's 3.30 reach: the window would be negative, so the Bot could
     * never swing and could only circle around. Once lit, the fuse lasts a full 30 ticks, which leaves enough
     * time to retreat.
     */
    public static double rawDangerRadius(Entity foe, Entity self) {
        if (!threatens(foe, self)) {
            return 0.0;   // it will not attack the Bot: just walk up and hit it
        }
        if (armed(foe)) {
            return blastSpanOf(foe);   // lit fuse / crystal that explodes when hit: the blast reach is what matters
        }
        return strikeRangeOf(foe, self);
    }

    /**
     * The <b>center distance</b> at which {@code attacker} can hit {@code victim}.
     *
     * <p>Vanilla checks two boxes for intersection, which is a <b>square</b> region: a hit lands when the gap on
     * every axis is below {@code half-width + 0.83 + half-width}. To be out of reach from every direction the
     * victim must be outside its <b>circumscribed circle</b>, hence the factor √2. The inscribed circle is
     * wrong: at a center distance of 1.43 on the diagonal, each axis gap is 1.01 and the hit still lands.
     */
    public static double strikeRangeOf(Entity attacker, Entity victim) {
        double perAxis = attacker.getBbWidth() / 2.0 + MOB_ATTACK_REACH + victim.getBbWidth() / 2.0;
        return perAxis * Math.sqrt(2.0);
    }

    /** How far blast damage reaches: vanilla explosion damage falls to zero at <b>twice</b> the power. */
    public static double blastSpanOf(Entity entity) {
        if (entity instanceof Creeper creeper) {
            return (creeper.isPowered() ? CREEPER_BLAST_RADIUS * 2.0 : CREEPER_BLAST_RADIUS) * 2.0;
        }
        return entity instanceof EndCrystal ? CRYSTAL_BLAST_RADIUS * 2.0 : 0.0;
    }

    /**
     * A <b>representative hit</b> used to estimate damage reduction. Vanilla's reduction depends on the
     * incoming damage (the armor toughness term), so "how much can the Bot take" must be evaluated at some
     * damage level; 8 is roughly one hit from a strong armed mob.
     */
    private static final float NOMINAL_HIT = 8.0f;

    /**
     * How much the Bot can still take: <b>effective health after armor</b>.
     *
     * <p>Raw health alone would rate "full health, no armor" as dangerous as "full health, netherite", while
     * the latter takes four to five times as much. Reduction is not computed here: it is delegated to vanilla
     * {@link CombatRules#getDamageAfterAbsorb}, so armor, toughness, and modded formulas all follow along. The
     * damage source carries no weapon, so the enchantment branch never triggers and there are no side effects
     * ({@code LivingEntity.getDamageAfterArmorAbsorb} wears down armor and cannot be used).
     *
     * @return effective health after reduction; equal to health when there is no armor
     */
    public static double effectiveHealth(LivingEntity self) {
        float health = self.getHealth();
        if (!(self.level() instanceof ServerLevel level)) {
            return health;
        }
        float afterArmor = CombatRules.getDamageAfterAbsorb(self, NOMINAL_HIT,
                level.damageSources().generic(),
                self.getArmorValue(), (float) self.getAttributeValue(Attributes.ARMOR_TOUGHNESS));
        if (afterArmor <= 0.0f) {
            return Double.MAX_VALUE;   // all damage absorbed: the Bot is invulnerable at this level
        }
        return health * (NOMINAL_HIT / afterArmor);
    }

    /**
     * Hostility is the {@link Enemy} marker interface, <b>not {@code Monster}</b>.
     *
     * <p>Slimes, magma cubes, ghasts, and phantoms all {@code extends Mob/FlyingMob implements Enemy}, and the
     * hoglin even {@code extends Animal}. Scanning for {@code Monster} would miss them entirely: the Bot would
     * flee straight through a slime, and the health-threshold fallback would never trigger (the chain would
     * never be woken).
     */
    public static boolean hostile(Entity entity) {
        return entity instanceof Enemy;
    }

    /**
     * Threat field for combat footwork: spacing uses the <b>raw</b> danger radius (without cell slack).
     *
     * <p>This is the <b>inner edge</b> of the footwork ring: outside every mob's reach. The outer edge is the
     * Bot's reach, supplied by the caller. The band is therefore about 1.28 blocks wide, comfortably wider than
     * the 0.71 cell-quantization error.
     */
    public static List<GoalAvoidEntities.Threat> field(LivingEntity victim,
                                                       Iterable<? extends Entity> mobs) {
        List<GoalAvoidEntities.Threat> threats = new ArrayList<>();
        for (Entity mob : mobs) {
            if (mob != null && mob.isAlive()) {
                threats.add(new GoalAvoidEntities.Threat(mob.getX(), mob.getY(), mob.getZ(),
                        dangerRadius(mob, victim), rawDangerRadius(mob, victim)));
            }
        }
        return threats;
    }

    /** Whether this mob is already within its danger radius. Same ruler and coordinates as the decision and pathfinding. */
    public static boolean tooClose(Entity foe, LivingEntity self) {
        return !GoalAvoidEntities.clearOf(self.getBlockX() + 0.5, self.getBlockZ() + 0.5,
                foe.getX(), foe.getZ(), dangerRadius(foe, self));
    }

}
