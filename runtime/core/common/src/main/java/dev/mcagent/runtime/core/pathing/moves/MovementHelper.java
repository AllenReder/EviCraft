package dev.mcagent.runtime.core.pathing.moves;

import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.core.pathing.execute.RouteMutation;

import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.AirBlock;
import net.minecraft.world.level.block.CauldronBlock;
import net.minecraft.world.level.block.AbstractSkullBlock;
import net.minecraft.world.level.block.AmethystClusterBlock;
import net.minecraft.world.level.block.AzaleaBlock;
import net.minecraft.world.level.block.BambooStalkBlock;
import net.minecraft.world.level.block.BaseFireBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CarpetBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.EndPortalBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.InfestedBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.PointedDripstoneBlock;
import net.minecraft.world.level.block.ScaffoldingBlock;
import net.minecraft.world.level.block.ShulkerBoxBlock;
import net.minecraft.world.level.block.SkullBlock;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.StainedGlassBlock;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.TrapDoorBlock;
import net.minecraft.world.level.block.WaterlilyBlock;
import net.minecraft.world.level.block.piston.MovingPistonBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BooleanProperty;
import net.minecraft.world.level.block.state.properties.Half;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.level.block.state.properties.StairsShape;
import net.minecraft.world.level.material.FlowingFluid;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.level.material.WaterFluid;
import net.minecraft.world.level.pathfinder.PathComputationType;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;

/**
 * Static block predicates shared by movement primitives and the search (BlockGetter domain): walkable
 * through / jumpable through / standable / mining ban / fluid flow / break cost, and so on.
 * Position-independent checks are split into a three-state prefilter (YES/NO/MAYBE), with a positional
 * check only for MAYBE, so most cells are decided from the BlockState alone.
 */
public final class MovementHelper {

    private MovementHelper() {}

    /** Three-state result: whether the BlockState alone decides; MAYBE needs a positional check. */
    public enum Ternary {
        YES, MAYBE, NO
    }

    // ==================== Walk through (can the body occupy the cell) ====================

    public static boolean canWalkThrough(CalculationContext context, int x, int y, int z) {
        return canWalkThrough(context, x, y, z, context.get(x, y, z));
    }

    public static boolean canWalkThrough(CalculationContext context, int x, int y, int z, BlockState state) {
        if ((state.getBlock() instanceof DoorBlock || state.getBlock() instanceof FenceGateBlock)
                && state.hasProperty(net.minecraft.world.level.block.state.properties.BlockStateProperties.OPEN)
                && !state.getValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.OPEN)
                && !context.routeMutations.permits(
                        new RouteMutation.Open(new BlockPos(x, y, z)))) {
            return false;
        }
        return canWalkThrough(context.view, context.loadedTest, x, y, z, state);
    }

    /** Live-world overload (all chunks treated as loaded). */
    public static boolean canWalkThrough(BlockGetter level, BlockPos pos) {
        return canWalkThrough(level, ChunkLoadedTest.ALWAYS,
                pos.getX(), pos.getY(), pos.getZ(), level.getBlockState(pos));
    }

    public static boolean canWalkThrough(BlockGetter view, ChunkLoadedTest loaded,
                                         int x, int y, int z, BlockState state) {
        Ternary result = canWalkThroughBlockState(state);
        if (result == Ternary.YES) {
            return true;
        }
        if (result == Ternary.NO) {
            return false;
        }
        return canWalkThroughPosition(view, loaded, x, y, z, state);
    }

    /** Three-state prefilter: BlockState only. */
    public static Ternary canWalkThroughBlockState(BlockState state) {
        Block block = state.getBlock();
        if (block instanceof AirBlock) {
            return Ternary.YES;
        }
        if (block instanceof BaseFireBlock || block == Blocks.TRIPWIRE || block == Blocks.COBWEB
                || block == Blocks.END_PORTAL || block == Blocks.COCOA
                || block instanceof AbstractSkullBlock || block == Blocks.BUBBLE_COLUMN
                || block instanceof ShulkerBoxBlock || block instanceof SlabBlock
                || block instanceof TrapDoorBlock || block == Blocks.HONEY_BLOCK
                || block == Blocks.END_ROD || block == Blocks.SWEET_BERRY_BUSH
                || block == Blocks.POINTED_DRIPSTONE || block instanceof AmethystClusterBlock
                || block instanceof AzaleaBlock || block == Blocks.BIG_DRIPLEAF
                || block == Blocks.POWDER_SNOW) {
            return Ternary.NO;
        }
        if (NavSettings.get().blocksToAvoid().contains(block)) {
            return Ternary.NO;
        }
        if (block instanceof DoorBlock || block instanceof FenceGateBlock) {
            // Wooden doors/fence gates are assumed openable (the execution layer right-clicks); iron doors
            // cannot be opened without redstone and are treated as solid walls
            if (block == Blocks.IRON_DOOR) {
                return Ternary.NO;
            }
            return Ternary.YES;
        }
        if (block instanceof CarpetBlock) {
            return Ternary.MAYBE;
        }
        if (block instanceof SnowLayerBlock) {
            // Snow on top of a cached chunk may lack its layer count; defer to the positional check
            return Ternary.MAYBE;
        }
        FluidState fluidState = state.getFluidState();
        if (!fluidState.isEmpty()) {
            if (fluidState.getAmount() != 8) {
                return Ternary.NO; // non-full fluid (flowing) is not walkable
            }
            return Ternary.MAYBE;
        }
        if (block instanceof CauldronBlock) {
            return Ternary.NO;
        }
        return state.isPathfindable(PathComputationType.LAND) ? Ternary.YES : Ternary.NO;
    }

    /** Positional check for MAYBE: carpet / snow layers / full fluid. */
    public static boolean canWalkThroughPosition(BlockGetter view, ChunkLoadedTest loaded,
                                                 int x, int y, int z, BlockState state) {
        Block block = state.getBlock();

        if (block instanceof CarpetBlock) {
            // Carpet is a thin layer; it is passable only if the cell below it is standable
            return canWalkOn(view, loaded, x, y - 1, z);
        }

        if (block instanceof SnowLayerBlock) {
            // Unloaded chunks have no layer count; allow it (otherwise long paths across snowfields fail)
            if (!loaded.isLoaded(x, z)) {
                return true;
            }
            // Vanilla passability is < 5 layers, but with 2 blocks of headroom >= 3 layers do not fit
            if (state.getValue(SnowLayerBlock.LAYERS) >= 3) {
                return false;
            }
            return canWalkOn(view, loaded, x, y - 1, z);
        }

        FluidState fluidState = state.getFluidState();
        if (!fluidState.isEmpty()) {
            if (isFlowing(view, x, y, z, state)) {
                return false; // the current would push the player off the path
            }
            if (NavSettings.get().assumeWalkOnWater) {
                return false; // under walk-on-water semantics, water columns are not passable
            }
            BlockState up = view.getBlockState(new BlockPos(x, y + 1, z));
            if (!up.getFluidState().isEmpty() || up.getBlock() instanceof WaterlilyBlock) {
                return false; // fluid or a lily pad above; passing through would mean diving
            }
            return fluidState.getType() instanceof WaterFluid; // only water columns are swimmable
        }

        return state.isPathfindable(PathComputationType.LAND);
    }

    // ==================== Fully unobstructed (can be jumped through) ====================

    /**
     * Stricter than walk-through: excludes doors/fence gates that need a right-click, slowing vines/
     * ladders/cobwebs, and any fluid. Used for parkour and headroom checks.
     */
    public static Ternary fullyPassableBlockState(BlockState state) {
        Block block = state.getBlock();
        if (block instanceof AirBlock) {
            return Ternary.YES;
        }
        if (block instanceof BaseFireBlock
                || block == Blocks.TRIPWIRE
                || block == Blocks.COBWEB
                || block == Blocks.VINE
                || block == Blocks.LADDER
                || block == Blocks.COCOA
                || block instanceof AzaleaBlock
                || block instanceof DoorBlock
                || block instanceof FenceGateBlock
                || block instanceof SnowLayerBlock
                || !state.getFluidState().isEmpty()
                || block instanceof TrapDoorBlock
                || block instanceof EndPortalBlock
                || block instanceof SkullBlock
                || block instanceof ShulkerBoxBlock) {
            return Ternary.NO;
        }
        return state.isPathfindable(PathComputationType.LAND) ? Ternary.YES : Ternary.NO;
    }

    public static boolean fullyPassable(CalculationContext context, int x, int y, int z) {
        return fullyPassable(context.get(x, y, z));
    }

    public static boolean fullyPassable(CalculationContext context, int x, int y, int z, BlockState state) {
        return fullyPassable(state);
    }

    public static boolean fullyPassable(BlockGetter level, BlockPos pos) {
        return fullyPassable(level.getBlockState(pos));
    }

    public static boolean fullyPassable(BlockState state) {
        return fullyPassableBlockState(state) == Ternary.YES;
    }

    // ==================== Walk on (can the cell serve as ground) ====================

    public static boolean canWalkOn(CalculationContext context, int x, int y, int z) {
        return canWalkOn(context.view, context.loadedTest, x, y, z, context.get(x, y, z));
    }

    public static boolean canWalkOn(CalculationContext context, int x, int y, int z, BlockState state) {
        return canWalkOn(context.view, context.loadedTest, x, y, z, state);
    }

    /** Live-world overload. */
    public static boolean canWalkOn(BlockGetter level, BlockPos pos) {
        return canWalkOn(level, ChunkLoadedTest.ALWAYS,
                pos.getX(), pos.getY(), pos.getZ(), level.getBlockState(pos));
    }

    public static boolean canWalkOn(BlockGetter view, ChunkLoadedTest loaded, int x, int y, int z) {
        return canWalkOn(view, loaded, x, y, z, view.getBlockState(new BlockPos(x, y, z)));
    }

    public static boolean canWalkOn(BlockGetter view, ChunkLoadedTest loaded,
                                    int x, int y, int z, BlockState state) {
        Ternary result = canWalkOnBlockState(state);
        if (result == Ternary.YES) {
            return true;
        }
        if (result == Ternary.NO) {
            return false;
        }
        return canWalkOnPosition(view, loaded, x, y, z, state);
    }

    /** Three-state prefilter: BlockState only. */
    public static Ternary canWalkOnBlockState(BlockState state) {
        Block block = state.getBlock();
        if (isBlockNormalCube(state) && block != Blocks.MAGMA_BLOCK
                && block != Blocks.BUBBLE_COLUMN && block != Blocks.HONEY_BLOCK) {
            return Ternary.YES;
        }
        if (block instanceof AzaleaBlock) {
            return Ternary.YES;
        }
        if (block == Blocks.LADDER || (block == Blocks.VINE && NavSettings.get().allowVines)) {
            return Ternary.YES;
        }
        if (block == Blocks.FARMLAND || block == Blocks.DIRT_PATH || block == Blocks.SOUL_SAND) {
            return Ternary.YES;
        }
        if (block == Blocks.ENDER_CHEST || block == Blocks.CHEST || block == Blocks.TRAPPED_CHEST) {
            return Ternary.YES;
        }
        if (block == Blocks.GLASS || block instanceof StainedGlassBlock) {
            return Ternary.YES;
        }
        if (block instanceof StairBlock) {
            return Ternary.YES;
        }
        if (isWater(state)) {
            return Ternary.MAYBE;
        }
        if (isLava(state) && NavSettings.get().assumeWalkOnLava) {
            return Ternary.MAYBE;
        }
        if (block instanceof SlabBlock) {
            if (!NavSettings.get().allowWalkOnBottomSlab) {
                // Only non-bottom slabs are standable
                return state.getValue(SlabBlock.TYPE) != SlabType.BOTTOM ? Ternary.YES : Ternary.NO;
            }
            return Ternary.YES;
        }
        return Ternary.NO;
    }

    /**
     * Positional check for MAYBE (water/lava). Swimming semantics for water: by default one can stand only
     * in a water cell with more water above (floating in a water column); with walk-on-water, only on a
     * surface with no water above. The two are mutually exclusive (XOR).
     */
    public static boolean canWalkOnPosition(BlockGetter view, ChunkLoadedTest loaded,
                                            int x, int y, int z, BlockState state) {
        if (isWater(state)) {
            BlockState upState = view.getBlockState(new BlockPos(x, y + 1, z));
            Block up = upState.getBlock();
            if (up == Blocks.LILY_PAD || up instanceof CarpetBlock) {
                return true;
            }
            if (isFlowing(view, x, y, z, state) || upState.getFluidState().getType() == Fluids.FLOWING_WATER) {
                // The only standable case on flowing water: water above and walk-on-water off
                return isWater(upState) && !NavSettings.get().assumeWalkOnWater;
            }
            return isWater(upState) ^ NavSettings.get().assumeWalkOnWater;
        }

        if (isLava(state) && !isFlowing(view, x, y, z, state) && NavSettings.get().assumeWalkOnLava) {
            return true;
        }

        return false; // anything unrecognized is not standable; prefer a detour
    }

    /** Whether Frost Walker can freeze this cell into ice (still water source and the enchantment present). */
    public static boolean canUseFrostWalker(CalculationContext context, BlockState state) {
        return context.frostWalker != 0
                && state.getBlock() == Blocks.WATER
                && state.getValue(LiquidBlock.LEVEL) == 0;
    }

    /**
     * Whether the cell must be solid to stand on or walk over it (used by the Frost Walker check).
     * Ladders/vines do not count; a fluid covered by a top slab/upside-down stair/closed top trapdoor/
     * scaffolding/leaves etc. still counts as having a solid top.
     */
    public static boolean mustBeSolidToWalkOn(CalculationContext context, int x, int y, int z, BlockState state) {
        Block block = state.getBlock();
        if (block == Blocks.LADDER || block == Blocks.VINE) {
            return false;
        }
        if (!state.getFluidState().isEmpty()) {
            if (block instanceof SlabBlock) {
                if (state.getValue(SlabBlock.TYPE) != SlabType.BOTTOM) {
                    return true;
                }
            } else if (block instanceof StairBlock) {
                if (state.getValue(StairBlock.HALF) == Half.TOP) {
                    return true;
                }
                StairsShape shape = state.getValue(StairBlock.SHAPE);
                if (shape == StairsShape.INNER_LEFT || shape == StairsShape.INNER_RIGHT) {
                    return true;
                }
            } else if (block instanceof TrapDoorBlock) {
                if (!state.getValue(TrapDoorBlock.OPEN) && state.getValue(TrapDoorBlock.HALF) == Half.TOP) {
                    return true;
                }
            } else if (block == Blocks.SCAFFOLDING) {
                return true;
            } else if (block instanceof LeavesBlock) {
                return true;
            }
            if (context.assumeWalkOnWater) {
                return false;
            }
            if (context.getBlock(x, y + 1, z) instanceof LiquidBlock) {
                return false;
            }
        }
        return true;
    }

    // ==================== Mining bans ====================

    /**
     * Whether mining (x,y,z) is <b>physically</b> forbidden: outside the world border (shrunk by one cell,
     * since blocks beyond it cannot be placed against or mined); ice (turns into water and disrupts the
     * path), infested blocks, and the liquid and unsupported falling-block rules for the cell above and
     * the four horizontal neighbors. The protective hard ban (do_not_break tag) is not here; it belongs to
     * {@link CalculationContext#breakCostMultiplierAt}, and that tag is its single source of truth.
     */
    public static boolean avoidBreaking(CalculationContext context, int x, int y, int z, BlockState state) {
        if (context.worldBorder != null
                && !(x > context.worldBorder.getMinX()
                        && x + 1 < context.worldBorder.getMaxX()
                        && z > context.worldBorder.getMinZ()
                        && z + 1 < context.worldBorder.getMaxZ())) {
            return true;
        }
        Block b = state.getBlock();
        return b == Blocks.ICE
                || b instanceof InfestedBlock
                || avoidAdjacentBreaking(context, x, y + 1, z, true)
                || avoidAdjacentBreaking(context, x + 1, y, z, false)
                || avoidAdjacentBreaking(context, x - 1, y, z, false)
                || avoidAdjacentBreaking(context, x, y, z + 1, false)
                || avoidAdjacentBreaking(context, x, y, z - 1, false);
    }

    /**
     * Whether neighbor (x,y,z) makes mining the cell next to it dangerous. Only the cell above and the four
     * horizontal directions are checked, not below. A falling block above is allowed (the chained cost of
     * mining the whole column is already counted); a liquid above is always banned. Horizontally: an
     * unsupported falling block would collapse on update, so banned; a liquid source spreads horizontally,
     * so banned; a flowing liquid is banned whenever the cell below it is not liquid (it would flow
     * sideways).
     */
    public static boolean avoidAdjacentBreaking(CalculationContext context, int x, int y, int z, boolean directlyAbove) {
        BlockState state = context.get(x, y, z);
        Block block = state.getBlock();
        if (!directlyAbove
                && block instanceof FallingBlock
                && NavSettings.get().avoidUpdatingFallingBlocks
                && FallingBlock.isFree(context.get(x, y - 1, z))) {
            return true;
        }
        // Only pure liquid blocks count (waterlogged blocks may have a closed bottom)
        if (block instanceof LiquidBlock) {
            if (directlyAbove || NavSettings.get().strictLiquidCheck) {
                return true;
            }
            int level = state.getValue(LiquidBlock.LEVEL);
            if (level == 0) {
                return true; // source blocks spread horizontally
            }
            return !(context.getBlock(x, y - 1, z) instanceof LiquidBlock);
        }
        return !state.getFluidState().isEmpty();
    }

    // ==================== Break cost ====================

    public static double getMiningDurationTicks(CalculationContext context, int x, int y, int z, boolean includeFalling) {
        return getMiningDurationTicks(context, x, y, z, context.get(x, y, z), includeFalling);
    }

    /**
     * Cost (ticks) of mining through the cell. Already passable: 0; fluid: INF; mining banned: INF;
     * otherwise 1/speed + the extra penalty, times the context multiplier. With {@code includeFalling},
     * recursively adds the cost of the whole falling-block column above.
     */
    public static double getMiningDurationTicks(CalculationContext context, int x, int y, int z,
                                                BlockState state, boolean includeFalling) {
        if (!canWalkThrough(context, x, y, z, state)) {
            if (!state.getFluidState().isEmpty()) {
                return COST_INF;
            }
            double mult = context.breakCostMultiplierAt(x, y, z, state);
            if (mult >= COST_INF) {
                return COST_INF;
            }
            if (avoidBreaking(context, x, y, z, state)) {
                return COST_INF;
            }
            double strVsBlock = context.toolSet.getStrVsBlock(state);
            if (strVsBlock <= 0) {
                return COST_INF;
            }
            double result = 1 / strVsBlock;
            result += context.breakBlockAdditionalCost;
            result *= mult;
            if (includeFalling) {
                BlockState above = context.get(x, y + 1, z);
                if (above.getBlock() instanceof FallingBlock) {
                    result += getMiningDurationTicks(context, x, y + 1, z, above, true);
                }
            }
            return result;
        }
        return 0; // nothing to mine, so no need to check falling blocks above
    }

    // ==================== Placement ====================

    /**
     * Whether a placement can replace this cell: air, a single snow layer (allowed in unloaded chunks),
     * tall grass/large fern, and other vanilla replaceable blocks.
     */
    public static boolean isReplaceable(int x, int y, int z, BlockState state, ChunkLoadedTest loaded) {
        Block block = state.getBlock();
        if (block instanceof AirBlock) {
            return true;
        }
        if (block instanceof SnowLayerBlock) {
            if (!loaded.isLoaded(x, z)) {
                return true;
            }
            return state.getValue(SnowLayerBlock.LAYERS) == 1;
        }
        if (block == Blocks.LARGE_FERN || block == Blocks.TALL_GRASS) {
            return true;
        }
        return state.canBeReplaced();
    }

    public static boolean canPlaceAgainst(CalculationContext context, int x, int y, int z) {
        return canPlaceAgainst(context, x, y, z, context.get(x, y, z));
    }

    public static boolean canPlaceAgainst(CalculationContext context, int x, int y, int z, BlockState state) {
        if (!placeableWithinBorder(context.worldBorder, x, z)) {
            return false;
        }
        return canPlaceAgainst(state);
    }

    public static boolean canPlaceAgainst(BlockGetter level, BlockPos pos) {
        if (level instanceof net.minecraft.world.level.Level live
                && !placeableWithinBorder(live.getWorldBorder(), pos.getX(), pos.getZ())) {
            return false;
        }
        return canPlaceAgainst(level.getBlockState(pos));
    }

    /**
     * Whether the cell to place against is far enough from the world border: shrunk by one cell on each
     * side, since a block touching the border cannot have its face selected by right-click. An unknown
     * border (null) is unrestricted.
     */
    public static boolean placeableWithinBorder(net.minecraft.world.level.border.WorldBorder border,
                                                int x, int z) {
        if (border == null) {
            return true;
        }
        return x > border.getMinX() && x + 1 < border.getMaxX()
                && z > border.getMinZ() && z + 1 < border.getMaxZ();
    }

    /**
     * Whether the center of this block's side can be aimed at as a placement face: full solid blocks or
     * glass. Thin blocks (carpet and the like) that are technically valid but hard to aim at do not count.
     */
    public static boolean canPlaceAgainst(BlockState state) {
        return isBlockNormalCube(state)
                || state.getBlock() == Blocks.GLASS
                || state.getBlock() instanceof StainedGlassBlock;
    }

    // ==================== Door / fence gate passage ====================

    /** Whether a wooden door can be walked through right now (not if the player is in the door cell). */
    public static boolean isDoorPassable(BlockGetter level, BlockPos doorPos, BlockPos playerPos) {
        if (playerPos.equals(doorPos)) {
            return false;
        }
        BlockState state = level.getBlockState(doorPos);
        if (!(state.getBlock() instanceof DoorBlock)) {
            return true;
        }
        return isHorizontalBlockPassable(doorPos, state, playerPos, DoorBlock.OPEN);
    }

    /** Whether a fence gate can be walked through right now (OPEN only). */
    public static boolean isGatePassable(BlockGetter level, BlockPos gatePos, BlockPos playerPos) {
        if (playerPos.equals(gatePos)) {
            return false;
        }
        BlockState state = level.getBlockState(gatePos);
        if (!(state.getBlock() instanceof FenceGateBlock)) {
            return true;
        }
        return state.getValue(FenceGateBlock.OPEN);
    }

    /**
     * Passage check for a facing door panel: when the approach axis matches the panel's facing axis, it
     * must be open; when perpendicular, it is out of the way only when closed (the panel sits at the cell
     * edge).
     */
    public static boolean isHorizontalBlockPassable(BlockPos blockPos, BlockState blockState,
                                                    BlockPos playerPos, BooleanProperty propertyOpen) {
        if (playerPos.equals(blockPos)) {
            return false;
        }
        var facing = blockState.getValue(HorizontalDirectionalBlock.FACING).getAxis();
        boolean open = blockState.getValue(propertyOpen);

        net.minecraft.core.Direction.Axis playerFacing;
        if (playerPos.north().equals(blockPos) || playerPos.south().equals(blockPos)) {
            playerFacing = net.minecraft.core.Direction.Axis.Z;
        } else if (playerPos.east().equals(blockPos) || playerPos.west().equals(blockPos)) {
            playerFacing = net.minecraft.core.Direction.Axis.X;
        } else {
            return true;
        }
        return (facing == playerFacing) == open;
    }

    // ==================== Dangerous cells ====================

    /** Cells never to walk into: any fluid, magma blocks, cactus, berry bushes, fire, etc. */
    public static boolean avoidWalkingInto(BlockState state) {
        Block block = state.getBlock();
        return !state.getFluidState().isEmpty()
                || block == Blocks.MAGMA_BLOCK
                || block == Blocks.CACTUS
                || block == Blocks.SWEET_BERRY_BUSH
                || block instanceof BaseFireBlock
                || block == Blocks.END_PORTAL
                || block == Blocks.COBWEB
                || block == Blocks.BUBBLE_COLUMN;
    }

    // ==================== Slab / fluid basics ====================

    /** A slab occupying the bottom half. */
    public static boolean isBottomSlab(BlockState state) {
        return state.getBlock() instanceof SlabBlock
                && state.getValue(SlabBlock.TYPE) == SlabType.BOTTOM;
    }

    /** Whether this is water (including flowing). */
    public static boolean isWater(BlockState state) {
        Fluid f = state.getFluidState().getType();
        return f == Fluids.WATER || f == Fluids.FLOWING_WATER;
    }

    /** Whether this is lava (including flowing). */
    public static boolean isLava(BlockState state) {
        Fluid f = state.getFluidState().getType();
        return f == Fluids.LAVA || f == Fluids.FLOWING_LAVA;
    }

    /** Whether this is any liquid. */
    public static boolean isLiquid(BlockState state) {
        return !state.getFluidState().isEmpty();
    }

    /** Possibly flowing: a fluid that is not full. */
    public static boolean possiblyFlowing(BlockState state) {
        FluidState fluidState = state.getFluidState();
        return fluidState.getType() instanceof FlowingFluid
                && fluidState.getAmount() != 8;
    }

    /**
     * Whether the fluid in this cell is flowing: non-full means flowing; a full source block is also
     * treated as flowing if any of its four horizontal neighbors may be flowing (pool edge).
     */
    public static boolean isFlowing(BlockGetter view, int x, int y, int z, BlockState state) {
        FluidState fluidState = state.getFluidState();
        if (!(fluidState.getType() instanceof FlowingFluid)) {
            return false;
        }
        if (fluidState.getAmount() != 8) {
            return true;
        }
        return possiblyFlowing(view.getBlockState(new BlockPos(x + 1, y, z)))
                || possiblyFlowing(view.getBlockState(new BlockPos(x - 1, y, z)))
                || possiblyFlowing(view.getBlockState(new BlockPos(x, y, z + 1)))
                || possiblyFlowing(view.getBlockState(new BlockPos(x, y, z - 1)));
    }

    /**
     * Full solid cube check: the collision shape is a full block, excluding blocks with irregular or moving
     * shapes (bamboo, moving piston, scaffolding, shulker box, pointed dripstone, amethyst cluster).
     * False if getting the shape throws.
     */
    public static boolean isBlockNormalCube(BlockState state) {
        Block block = state.getBlock();
        if (block instanceof BambooStalkBlock
                || block instanceof MovingPistonBlock
                || block instanceof ScaffoldingBlock
                || block instanceof ShulkerBoxBlock
                || block instanceof PointedDripstoneBlock
                || block instanceof AmethystClusterBlock) {
            return false;
        }
        try {
            return Block.isShapeFullBlock(state.getCollisionShape(null, null));
        } catch (Exception ignored) {
            // Odd blocks whose collision shape cannot be read are treated as not solid
        }
        return false;
    }

}
