package dev.mcagent.runtime.core.combat;

import java.util.List;

/**
 * The <b>whole situation</b> for this tick: the Bot itself plus every hostile mob present.
 *
 * <h2>Why not just "the Bot and its current target"</h2>
 * A decision that describes only one target has nowhere to put global concerns such as "should I evade":
 * the Bot can be fighting a slime three blocks away while a creeper stands 3.3 blocks away, unknown to the
 * decision. Hanging global fields on a single-target description is a patch, not a fix: every new global
 * concern adds another field, and "whom to hit" itself needs the whole field (pick the nearest, skip the
 * unhittable, keep the one hit last tick).
 *
 * <p>So the input is the situation itself, and {@link AttackPlan} derives both <b>what to do</b> and
 * <b>to whom</b> from it.
 *
 * @param effectiveHealth how much damage the Bot can still take after armor, see {@link Menace#effectiveHealth}
 * @param hasMelee        a melee weapon is in the inventory (fists do not count: fighting back bare-handed
 *                        against something that hits back is not a way out)
 * @param hasRanged       a bow/crossbow usable right now (with arrows, or a loaded crossbow)
 * @param foes            hostile mobs present, in no particular order
 */
public record Battlefield(double effectiveHealth,
                          boolean hasMelee,
                          boolean hasRanged,
                          List<Foe> foes) {

    /**
     * One foe on the field.
     *
     * @param id         runtime entity id
     * @param distance   distance from the Bot
     * @param explosive  it can explode, whether or not it is exploding now; approach with margin and stay
     *                   outside its ignition line
     * @param armed      it is <b>about to explode now</b>: the fuse is burning, or it is an end crystal that
     *                   explodes when hit
     * @param engaging   it is targeting the Bot (locked on, or just hit it)
     * @param reachable  <b>the last path search found a route</b>. Reachability is topological, not a matter
     *                   of distance, and only pathfinding can tell: a skeleton three blocks away across a
     *                   cliff is close but has no path
     * @param authorized attacking it is allowed. In named mode this is the model's list; in indiscriminate
     *                   mode it means "chasing the Bot"
     */
    public record Foe(int id,
                      double distance,
                      boolean explosive,
                      boolean armed,
                      boolean engaging,
                      boolean reachable,
                      boolean authorized) {

        }

    public Foe byId(int id) {
        for (Foe f : foes) {
            if (f.id() == id) {
                return f;
            }
        }
        return null;
    }
}
