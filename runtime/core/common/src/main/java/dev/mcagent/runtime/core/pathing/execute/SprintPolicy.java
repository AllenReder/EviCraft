package dev.mcagent.runtime.core.pathing.execute;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.WorkProfile;
import dev.mcagent.runtime.core.pathing.astar.NavPath;
import dev.mcagent.runtime.core.pathing.cache.ExecutionWorldView;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementAscend;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDescend;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDiagonal;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementFall;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementParkour;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementTraverse;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.entity.BotPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Vec3i;
import net.minecraft.world.phys.Vec3;

import java.util.function.Supplier;

/**
 * Overall sprint decision: from the current movement type and its neighbors, decides whether to sprint
 * this tick, plus the resulting path skips and key presses (jump straight onto a step, V-valley dash,
 * chained descents, fall overshoot).
 *
 * <p><b>Pure decision, no state changes.</b> Every side effect is expressed as an explicit field of
 * {@link Decision} and applied by the executor in <b>one place</b>; this class only reads the world and
 * computes a verdict. Mutating pathPosition, re-entering onTick, or pressing keys from here would
 * reintroduce unbounded recursion. The one exception is {@link MovementDescend#forceSafeMode}: that is
 * the descend primitive's own safety mode, a property of the movement rather than executor state.
 */
final class SprintPolicy {

    /**
     * One sprint verdict.
     *
     * @param sprint  whether to sprint this tick
     * @param skipTo  skip: advance the path index directly to here and rerun the advance pipeline
     *                (-1 = no skip). Used by step jumps, V-valleys, chained descents and fall snapping
     * @param jumpUp  press jump after the skip (takeoff for a step jump)
     * @param jumpDown release jump (dash out of a V-valley bottom on momentum, no new jump)
     * @param steer   steering target for a fall overshoot: clear keys, then force look and forward
     *                (null = none)
     */
    record Decision(boolean sprint, int skipTo, boolean jumpUp, boolean jumpDown, Vec3 steer) {
        static final Decision NO = new Decision(false, -1, false, false, null);
        static final Decision YES = new Decision(true, -1, false, false, null);
    }

    private final NavPath path;
    private final BotPlayer player;
    /** Context for recomputing costs at execution time (needed for the Frost Walker check). */
    private final Supplier<CalculationContext> contextSupplier;

    SprintPolicy(NavPath path, BotPlayer player, Supplier<CalculationContext> contextSupplier) {
        this.path = path;
        this.player = player;
        this.contextSupplier = contextSupplier;
    }

    /**
     * Decides sprinting for this tick. {@code requested} is the SPRINT key the movement primitive asked
     * for before it was confiscated (the executor confiscates it; this only receives the result).
     */
    Decision decide(ExecutionWorldView world, int pathPosition, boolean requested) {
        // Same criterion as the cost model: sprinting allowed and enough food
        if (!(NavSettings.get().allowSprint
                && (!WorkProfile.of(player).hasHunger()
                        || player.getFoodData().getFoodLevel() > 6))) {
            return Decision.NO;
        }
        Movement current = path.movements().get(pathPosition);

        // Traverse then ascend: skip the traverse and jump straight up from here
        if (current instanceof MovementTraverse traverse && pathPosition < path.length() - 3) {
            Movement next = path.movements().get(pathPosition + 1);
            if (next instanceof MovementAscend ascend
                    && sprintableAscend(world, traverse, ascend, path.movements().get(pathPosition + 2))
                    && skipNow(world, current)) {
                Constants.LOG.debug("Skipping the flat walk, jumping straight up");
                return new Decision(true, pathPosition + 1, true, false, null);
            }
        }

        if (requested) {
            return Decision.YES;
        }

        // Descend and ascend never request sprint themselves (they do not know what follows); decide here
        // from context
        if (current instanceof MovementDescend descend) {
            if (pathPosition < path.length() - 2) {
                Movement next = path.movements().get(pathPosition + 1);
                CalculationContext context = contextSupplier.get();
                if (MovementHelper.canUseFrostWalker(context, context.get(next.getDest().below()))) {
                    // Frost Walker only freezes when crossing a block edge on the ground, so the Bot may
                    // overshoot. Force slow straight movement when the next step is a same-direction
                    // traverse/parkour (unless it is parkour and a throwaway block can be placed instead)
                    if (next instanceof MovementTraverse || next instanceof MovementParkour) {
                        boolean couldPlaceInstead = NavSettings.get().allowPlace
                                && context.hasThrowaway && next instanceof MovementParkour;
                        boolean sameFlatDirection =
                                !current.getDirection().above().offset(next.getDirection()).equals(BlockPos.ZERO)
                                && current.getDirection().above().cross(next.getDirection()).equals(BlockPos.ZERO);
                        if (sameFlatDirection && !couldPlaceInstead) {
                            descend.forceSafeMode();
                        }
                    }
                }
            }
            if (descend.safeMode() && !descend.skipToAscend()) {
                return Decision.NO; // unsafe to rush down
            }
            if (pathPosition < path.length() - 2) {
                Movement next = path.movements().get(pathPosition + 1);
                if (next instanceof MovementAscend
                        && current.getDirection().above().equals(next.getDirection().below())) {
                    // V shape: same-direction descend then ascend; skip to the ascend and dash through
                    Constants.LOG.debug("V-shaped dip, skipping the descent and ascending directly");
                    return new Decision(true, pathPosition + 1, false, false, null);
                }
                if (canSprintFromDescendInto(world, current, next)) {
                    if (next instanceof MovementDescend && pathPosition < path.length() - 3) {
                        Movement nextNext = path.movements().get(pathPosition + 2);
                        if (nextNext instanceof MovementDescend
                                && !canSprintFromDescendInto(world, next, nextNext)) {
                            return Decision.NO; // the next link of the descent chain does not connect; do not dash
                        }
                    }
                    if (PathExecutor.playerFeet(player).equals(current.getDest())) {
                        return new Decision(true, pathPosition + 1, false, false, null);
                    }
                    return Decision.YES;
                }
            }
        }
        if (current instanceof MovementAscend && pathPosition != 0) {
            Movement prev = path.movements().get(pathPosition - 1);
            if (prev instanceof MovementDescend
                    && prev.getDirection().above().equals(current.getDirection().below())) {
                // V-valley bottom: momentum remains; once high enough, release jump and dash up
                BlockPos center = current.getSrc().above();
                // 0.07 margin absorbs the lower top surface of farmland/soul sand
                if (player.position().y >= center.getY() - 0.07) {
                    return new Decision(true, -1, false, true, null);
                }
            }
            if (pathPosition < path.length() - 2 && prev instanceof MovementTraverse traverse
                    && sprintableAscend(world, traverse, (MovementAscend) current,
                            path.movements().get(pathPosition + 1))) {
                return Decision.YES;
            }
        }
        if (current instanceof MovementFall fall) {
            Vec3 overrideTarget = overrideFallTarget(world, fall, pathPosition);
            if (overrideTarget != null) {
                BlockPos fallDest = overrideFallDest(world, fall, pathPosition);
                if (!path.positions().contains(fallDest)) {
                    throw new IllegalStateException("Fall overshoot landing " + fallDest + " is not on the path");
                }
                if (PathExecutor.playerFeet(player).equals(fallDest)) {
                    return new Decision(true, path.positions().indexOf(fallDest), false, false, null);
                }
                // Sprint down without slowing: clear keys, force look at the target and forward (applied by
                // the executor)
                return new Decision(true, -1, false, false, overrideTarget);
            }
        }
        return Decision.NO;
    }

    /**
     * Fall overshoot: with a drop of at most 3 and nothing to break, collect up to 2 following
     * same-direction traverses whose columns are fully passable and whose landings are standable, then
     * move the target just short of the extended end (len − 0.4) and sprint straight over. Returns the
     * extended aim point, or null if overshoot is not possible.
     */
    private Vec3 overrideFallTarget(ExecutionWorldView world, MovementFall movement, int pathPosition) {
        int extension = overrideFallExtension(world, movement, pathPosition);
        if (extension == 0) {
            return null;
        }
        Vec3i dir = movement.getDirection();
        Vec3i flatDir = new Vec3i(dir.getX(), 0, dir.getZ());
        double len = extension - 0.4;
        BlockPos dest = movement.getDest();
        return new Vec3(flatDir.getX() * len + dest.getX() + 0.5,
                dest.getY(),
                flatDir.getZ() * len + dest.getZ() + 0.5);
    }

    /** Extended landing position of a fall overshoot (a position that exists on the path). */
    private BlockPos overrideFallDest(ExecutionWorldView world, MovementFall movement, int pathPosition) {
        int extension = overrideFallExtension(world, movement, pathPosition);
        Vec3i dir = movement.getDirection();
        return movement.getDest().offset(dir.getX() * extension, 0, dir.getZ() * extension);
    }

    /** Number of same-direction traverses the overshoot can extend over (0 = no overshoot). */
    private int overrideFallExtension(ExecutionWorldView world, MovementFall movement, int pathPosition) {
        Vec3i dir = movement.getDirection();
        if (dir.getY() < -3) {
            return 0;
        }
        var level = world;
        if (!movement.toBreak(level).isEmpty()) {
            return 0;
        }
        Vec3i flatDir = new Vec3i(dir.getX(), 0, dir.getZ());
        int i;
        outer:
        for (i = pathPosition + 1; i < path.length() - 1 && i < pathPosition + 3; i++) {
            Movement next = path.movements().get(i);
            if (!(next instanceof MovementTraverse)) {
                break;
            }
            if (!flatDir.equals(next.getDirection())) {
                break;
            }
            for (int y = next.getDest().getY(); y <= movement.getSrc().getY() + 1; y++) {
                BlockPos chk = new BlockPos(next.getDest().getX(), y, next.getDest().getZ());
                if (!MovementHelper.fullyPassable(level, chk)) {
                    break outer;
                }
            }
            if (!world.canWalkOnPlannedSupport(next.getDest().below())) {
                break;
            }
        }
        i--;
        return i - pathPosition;
    }

    /**
     * Takeoff timing for a traverse-to-ascend jump: centered, and headroom behind is clear or the Bot
     * has moved far enough.
     */
    private boolean skipNow(ExecutionWorldView world, Movement current) {
        double offTarget = Math.abs(current.getDirection().getX()
                        * (current.getSrc().getZ() + 0.5 - player.position().z))
                + Math.abs(current.getDirection().getZ()
                        * (current.getSrc().getX() + 0.5 - player.position().x));
        if (offTarget > 0.1) {
            return false;
        }
        BlockPos headBonk = current.getSrc().subtract(current.getDirection()).above(2);
        if (MovementHelper.fullyPassable(world, headBonk)) {
            return true;
        }
        // Headroom behind is blocked: move out more than 0.8 before jumping to avoid hitting the head
        double flatDist = Math.abs(current.getDirection().getX()
                        * (headBonk.getX() + 0.5 - player.position().x))
                + Math.abs(current.getDirection().getZ()
                        * (headBonk.getZ() + 0.5 - player.position().z));
        return flatDist > 0.8;
    }

    /**
     * Whether a traverse followed by an ascend can be sprint-jumped: collinear in the same direction, both
     * landings standable, nothing to break on the ascend, three blocks of the takeoff and front columns
     * fully passable, and no dangerous block at the two head positions.
     */
    private boolean sprintableAscend(ExecutionWorldView world, MovementTraverse current, MovementAscend next, Movement nextNext) {
        if (!NavSettings.get().sprintAscends) {
            return false;
        }
        if (!current.getDirection().equals(next.getDirection().below())) {
            return false;
        }
        if (nextNext.getDirection().getX() != next.getDirection().getX()
                || nextNext.getDirection().getZ() != next.getDirection().getZ()) {
            return false;
        }
        var level = world;
        if (!world.canWalkOnPlannedSupport(current.getDest().below())) {
            return false;
        }
        if (!world.canWalkOnPlannedSupport(next.getDest().below())) {
            return false;
        }
        if (!next.toBreak(level).isEmpty()) {
            return false;
        }
        for (int x = 0; x < 2; x++) {
            for (int y = 0; y < 3; y++) {
                BlockPos chk = current.getSrc().above(y);
                if (x == 1) {
                    chk = chk.offset(current.getDirection());
                }
                if (!MovementHelper.fullyPassable(level, chk)) {
                    return false;
                }
            }
        }
        if (MovementHelper.avoidWalkingInto(level.getBlockState(current.getSrc().above(3)))) {
            return false;
        }
        return !MovementHelper.avoidWalkingInto(level.getBlockState(next.getDest().above(2)));
    }

    /**
     * Whether a descend can sprint into the next step: always for a same-direction descend; for a
     * same-direction traverse or a diagonal when the block past the landing is standable.
     */
    private boolean canSprintFromDescendInto(ExecutionWorldView world, Movement current, Movement next) {
        if (next instanceof MovementDescend && next.getDirection().equals(current.getDirection())) {
            return true;
        }
        if (!world.canWalkOnPlannedSupport(
                current.getDest().offset(current.getDirection()))) {
            return false;
        }
        if (next instanceof MovementTraverse && next.getDirection().equals(current.getDirection())) {
            return true;
        }
        return next instanceof MovementDiagonal && NavSettings.get().allowOvershootDiagonalDescend;
    }
}
