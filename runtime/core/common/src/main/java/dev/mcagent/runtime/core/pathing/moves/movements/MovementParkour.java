package dev.mcagent.runtime.core.pathing.moves.movements;
import dev.mcagent.runtime.core.pathing.moves.AimGeometry;
import dev.mcagent.runtime.core.pathing.execute.RouteMutation;

import java.util.HashSet;
import java.util.Set;

import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Input;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import dev.mcagent.runtime.core.pathing.moves.MovementState;
import dev.mcagent.runtime.core.pathing.moves.MovementStatus;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.WaterFluid;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.SPRINT_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_BLOCK_COST;

/** Parkour jump: run up and clear a 2-4 block gap onto a cell at the same height or one higher; never mines. */
public class MovementParkour extends Movement {

    private static final BlockPos[] EMPTY = new BlockPos[0];

    private final Direction direction;
    private final int dist;
    private final boolean ascend;

    public MovementParkour(ServerPlayer player, BlockPos src, BlockPos dest) {
        super(player, src, dest, EMPTY, dest.below());
        int dx = dest.getX() - src.getX();
        int dz = dest.getZ() - src.getZ();
        this.direction = Direction.getNearest(dx, 0, dz);
        this.dist = Math.abs(dx) + Math.abs(dz);
        this.ascend = dest.getY() > src.getY();
    }

    /**
     * Cost: the actual destination and cost are written into result. Preconditions: master switch, build
     * height limit, adjacent cell empty (no parkour if walking works), nothing dangerous below the adjacent
     * cell, headroom for the jump, the takeoff block is not a ladder/vine/stair/bottom slab, and the Bot is
     * not in (or standing on) water. Each distance 2..maxJump is verified (2 on soul sand, 4 when sprinting,
     * otherwise 3): two cells of clearance in the landing column; a solid landing cell means the parkour
     * ascend check; a standable cell below means a level landing (accepted only if the overshoot cells are
     * safe); otherwise flying further needs one more layer of clearance. With jump placement enabled, search
     * back from the farthest verified distance for a placement face (excluding the direction jumped from).
     */
    public static void cost(CalculationContext context, int x, int y, int z,
                            Direction dir, MutableMoveResult res) {
        if (!context.allowParkour) {
            return;
        }
        if (!context.allowJumpAtBuildLimit && y >= context.worldHeight - 1) {
            return;
        }
        int xDiff = dir.getStepX();
        int zDiff = dir.getStepZ();
        if (!MovementHelper.fullyPassable(context, x + xDiff, y, z + zDiff)) {
            // Most common prune: the adjacent cell is not empty
            return;
        }
        BlockState adj = context.get(x + xDiff, y - 1, z + zDiff);
        if (MovementHelper.canWalkOn(context, x + xDiff, y - 1, z + zDiff, adj)) {
            // No parkour if the Bot can just walk over
            return;
        }
        if (MovementHelper.avoidWalkingInto(adj) && !(adj.getFluidState().getType() instanceof WaterFluid)) {
            return; // lava or similar below the adjacent cell; overshooting is dangerous
        }
        if (!MovementHelper.fullyPassable(context, x + xDiff, y + 1, z + zDiff)) {
            return;
        }
        if (!MovementHelper.fullyPassable(context, x + xDiff, y + 2, z + zDiff)) {
            return;
        }
        if (!MovementHelper.fullyPassable(context, x, y + 2, z)) {
            return;
        }
        BlockState standingOn = context.get(x, y - 1, z);
        if (standingOn.getBlock() == Blocks.VINE || standingOn.getBlock() == Blocks.LADDER
                || standingOn.getBlock() instanceof StairBlock
                || MovementHelper.isBottomSlab(standingOn)) {
            return;
        }
        // Under walk-on-water semantics the water underfoot may not be frozen; do not jump
        if (context.assumeWalkOnWater && !standingOn.getFluidState().isEmpty()) {
            return;
        }
        if (!context.get(x, y, z).getFluidState().isEmpty()) {
            return; // cannot jump from water
        }
        int maxJump;
        if (standingOn.getBlock() == Blocks.SOUL_SAND) {
            maxJump = 2; // can only clear a one-block gap
        } else {
            maxJump = context.canSprint ? 4 : 3;
        }

        // Verify obstacles and landings cell by cell, near to far
        int verifiedMaxJump = 1;
        for (int i = 2; i <= maxJump; i++) {
            int destX = x + xDiff * i;
            int destZ = z + zDiff * i;

            // Body and head cells
            if (!MovementHelper.fullyPassable(context, destX, y + 1, destZ)) {
                break;
            }
            if (!MovementHelper.fullyPassable(context, destX, y + 2, destZ)) {
                break;
            }

            // Solid landing cell: parkour ascend check
            BlockState destInto = context.get(destX, y, destZ);
            if (!MovementHelper.fullyPassable(context, destX, y, destZ, destInto)) {
                if (i <= 3 && context.allowParkourAscend && context.canSprint
                        && MovementHelper.canWalkOn(context, destX, y, destZ, destInto)
                        && checkOvershootSafety(context, destX + xDiff, y + 1, destZ + zDiff)) {
                    res.x = destX;
                    res.y = y + 1;
                    res.z = destZ;
                    res.cost = i * SPRINT_ONE_BLOCK_COST + context.jumpPenalty;
                    return;
                }
                break; // hit a wall: switch to the jump placement scan
            }

            // Level landing: never farmland (it gets trampled); water that Frost Walker can freeze counts
            BlockState landingOn = context.get(destX, y - 1, destZ);
            if ((landingOn.getBlock() != Blocks.FARMLAND
                    && MovementHelper.canWalkOn(context, destX, y - 1, destZ, landingOn))
                    || (Math.min(16, context.frostWalker + 2) >= i
                            && MovementHelper.canUseFrostWalker(context, landingOn))) {
                if (checkOvershootSafety(context, destX + xDiff, y, destZ + zDiff)) {
                    res.x = destX;
                    res.y = y;
                    res.z = destZ;
                    res.cost = costFromJumpDistance(i) + context.jumpPenalty;
                    return;
                }
                break; // overshooting the landing is unsafe: switch to the jump placement scan
            }

            // No landing: one more layer up must be clear to fly further
            if (!MovementHelper.fullyPassable(context, destX, y + 3, destZ)) {
                break;
            }

            verifiedMaxJump = i;
        }

        // Jump placement: place a block under the landing mid-air
        if (!context.allowParkourPlace) {
            return;
        }
        // Search back from the farthest verified distance for a placement position
        for (int i = verifiedMaxJump; i > 1; i--) {
            int destX = x + i * xDiff;
            int destZ = z + i * zDiff;
            BlockState toReplace = context.get(destX, y - 1, destZ);
            double placeCost = context.costOfPlacingAt(destX, y - 1, destZ, toReplace);
            if (placeCost >= COST_INF) {
                continue;
            }
            if (!MovementHelper.isReplaceable(destX, y - 1, destZ, toReplace, context.loadedTest)) {
                continue;
            }
            if (!checkOvershootSafety(context, destX + xDiff, y, destZ + zDiff)) {
                continue;
            }
            for (int j = 0; j < 5; j++) {
                int againstX = destX + MovementPlacement.HORIZONTALS_AND_DOWN[j].getStepX();
                int againstY = y - 1 + MovementPlacement.HORIZONTALS_AND_DOWN[j].getStepY();
                int againstZ = destZ + MovementPlacement.HORIZONTALS_AND_DOWN[j].getStepZ();
                if (againstX == destX - xDiff && againstZ == destZ - zDiff) {
                    continue; // the face towards the takeoff; turning mid-air is too slow to aim at it
                }
                if (MovementHelper.canPlaceAgainst(context, againstX, againstY, againstZ)) {
                    res.x = destX;
                    res.y = y;
                    res.z = destZ;
                    res.cost = costFromJumpDistance(i) + placeCost + context.jumpPenalty;
                    return;
                }
            }
        }
    }

    /** After landing the body overshoots one cell; the two body cells there must not be dangerous. */
    private static boolean checkOvershootSafety(CalculationContext context, int x, int y, int z) {
        return !MovementHelper.avoidWalkingInto(context.get(x, y, z))
                && !MovementHelper.avoidWalkingInto(context.get(x, y + 1, z));
    }

    /** Jump distance -> cost: 2/3 blocks at walking speed, 4 blocks requires sprinting. */
    private static double costFromJumpDistance(int dist) {
        switch (dist) {
            case 2:
                return WALK_ONE_BLOCK_COST * 2;
            case 3:
                return WALK_ONE_BLOCK_COST * 3;
            case 4:
                return SPRINT_ONE_BLOCK_COST * 4;
            default:
                throw new IllegalStateException("Invalid jump distance " + dist);
        }
    }

    @Override
    public double calculateCost(CalculationContext context, MutableMoveResult result) {
        cost(context, src.getX(), src.getY(), src.getZ(), direction, result);
        if (result.x != dest.getX() || result.y != dest.getY() || result.z != dest.getZ()) {
            return COST_INF;
        }
        return result.cost;
    }

    /** Two cells per step along the direction from src. */
    @Override
    protected Set<BlockPos> calculateValidPositions() {
        Set<BlockPos> set = new HashSet<>();
        for (int i = 0; i <= dist; i++) {
            for (int y = 0; y < 2; y++) {
                set.add(src.relative(direction, i).above(y));
            }
        }
        return set;
    }

    /** Momentum is uncontrollable after takeoff; never cancelable once RUNNING. */
    @Override
    protected boolean safeToCancel(MovementState state) {
        return state.getStatus() != MovementStatus.RUNNING;
    }

    @Override
    public MovementState updateState(MovementState state) {
        super.updateState(state);
        if (state.getStatus() != MovementStatus.RUNNING) {
            return state;
        }
        BlockPos feet = feet(player);
        if (feet.getY() < src.getY()) {
            // Fell down
            return state.setStatus(MovementStatus.UNREACHABLE);
        }
        if (dist >= 4 || ascend) {
            state.setInput(Input.SPRINT, true);
        }
        AimGeometry.moveTowards(player, state, dest);
        if (feet.equals(dest)) {
            Block d = world.getBlockState(dest).getBlock();
            if (d == Blocks.VINE || d == Blocks.LADDER) {
                // Landing on a vine/ladder counts as success
                return state.setStatus(MovementStatus.SUCCESS);
            }
            if (player.getY() - feet.getY() < 0.094) { // lily pad tolerance
                state.setStatus(MovementStatus.SUCCESS);
            }
        } else if (!feet.equals(src)) {
            if (feet.equals(src.relative(direction)) || player.getY() - src.getY() > 0.0001) {
                // Past the first cell or already airborne
                if (NavSettings.get().allowPlace
                        && MovementPlacement.selectForLocation(player, dest.below(), false)
                        && !MovementHelper.canWalkOn(world, dest.below())
                        && !player.onGround()
                        && MovementPlacement.attemptToPlaceABlock(state, player, world, dest.below(), true, false)
                                == MovementPlacement.PlaceResult.READY_TO_PLACE) {
                    // preferDown: prefer the downward face so turning the head mid-air does not disturb the arc
                    state.setRouteMutation(new RouteMutation.Place(dest.below()));
                }
                if (dist == 3 && !ascend) {
                    // Two-block gap: no jump within 0.7 of the start, so an early jump does not fall short
                    double xDiff = (src.getX() + 0.5) - player.getX();
                    double zDiff = (src.getZ() + 0.5) - player.getZ();
                    double distFromStart = Math.max(Math.abs(xDiff), Math.abs(zDiff));
                    if (distFromStart < 0.7) {
                        return state;
                    }
                }
                state.setInput(Input.JUMP, true);
            } else if (!feet.equals(dest.relative(direction, -1))) {
                // Off course: release sprint and back up to the takeoff line to retry
                state.setInput(Input.SPRINT, false);
                if (feet.equals(src.relative(direction, -1))) {
                    AimGeometry.moveTowards(player, state, src);
                } else {
                    AimGeometry.moveTowards(player, state, src.relative(direction, -1));
                }
            }
        }
        return state;
    }
}
