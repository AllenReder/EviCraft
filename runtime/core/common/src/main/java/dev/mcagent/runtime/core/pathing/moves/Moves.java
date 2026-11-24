package dev.mcagent.runtime.core.pathing.moves;

import dev.mcagent.runtime.core.pathing.moves.movements.MovementAscend;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDescend;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDiagonal;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDownward;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementFall;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementParkour;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementPillar;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementTraverse;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

/**
 * Enumeration of every movement primitive x every direction; the search loop iterates it to produce
 * neighbor edges. Members with a static offset fill the result directly in {@link #apply}; dynamicXZ/
 * dynamicY members (descend may become a fall, diagonal may change height, parkour has a variable
 * distance) override apply and let the cost function write the actual destination.
 */
public enum Moves {

    DOWNWARD(0, -1, 0) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementDownward(context.player, src, src.below());
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementDownward.cost(context, x, y, z);
        }
    },

    PILLAR(0, +1, 0) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementPillar(context.player, src, src.above());
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementPillar.cost(context, x, y, z);
        }
    },

    TRAVERSE_NORTH(0, 0, -1) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementTraverse(context.player, src, src.north());
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementTraverse.cost(context, x, y, z, x, z - 1);
        }
    },

    TRAVERSE_SOUTH(0, 0, +1) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementTraverse(context.player, src, src.south());
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementTraverse.cost(context, x, y, z, x, z + 1);
        }
    },

    TRAVERSE_EAST(+1, 0, 0) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementTraverse(context.player, src, src.east());
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementTraverse.cost(context, x, y, z, x + 1, z);
        }
    },

    TRAVERSE_WEST(-1, 0, 0) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementTraverse(context.player, src, src.west());
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementTraverse.cost(context, x, y, z, x - 1, z);
        }
    },

    ASCEND_NORTH(0, +1, -1) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementAscend(context.player, src, src.offset(0, 1, -1));
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementAscend.cost(context, x, y, z, x, z - 1);
        }
    },

    ASCEND_SOUTH(0, +1, +1) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementAscend(context.player, src, src.offset(0, 1, 1));
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementAscend.cost(context, x, y, z, x, z + 1);
        }
    },

    ASCEND_EAST(+1, +1, 0) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementAscend(context.player, src, src.offset(1, 1, 0));
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementAscend.cost(context, x, y, z, x + 1, z);
        }
    },

    ASCEND_WEST(-1, +1, 0) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return new MovementAscend(context.player, src, src.offset(-1, 1, 0));
        }

        @Override
        public double cost(CalculationContext context, int x, int y, int z) {
            return MovementAscend.cost(context, x, y, z, x - 1, z);
        }
    },

    DESCEND_EAST(+1, -1, 0, false, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return descendOrFall(context, src, this);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementDescend.cost(context, x, y, z, x + 1, z, result);
        }
    },

    DESCEND_WEST(-1, -1, 0, false, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return descendOrFall(context, src, this);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementDescend.cost(context, x, y, z, x - 1, z, result);
        }
    },

    DESCEND_NORTH(0, -1, -1, false, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return descendOrFall(context, src, this);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementDescend.cost(context, x, y, z, x, z - 1, result);
        }
    },

    DESCEND_SOUTH(0, -1, +1, false, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return descendOrFall(context, src, this);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementDescend.cost(context, x, y, z, x, z + 1, result);
        }
    },

    DIAGONAL_NORTHEAST(+1, 0, -1, false, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return diagonal(context, src, this);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementDiagonal.cost(context, x, y, z, x + 1, z - 1, result);
        }
    },

    DIAGONAL_NORTHWEST(-1, 0, -1, false, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return diagonal(context, src, this);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementDiagonal.cost(context, x, y, z, x - 1, z - 1, result);
        }
    },

    DIAGONAL_SOUTHEAST(+1, 0, +1, false, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return diagonal(context, src, this);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementDiagonal.cost(context, x, y, z, x + 1, z + 1, result);
        }
    },

    DIAGONAL_SOUTHWEST(-1, 0, +1, false, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return diagonal(context, src, this);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementDiagonal.cost(context, x, y, z, x - 1, z + 1, result);
        }
    },

    PARKOUR_NORTH(0, 0, -4, true, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return parkour(context, src, Direction.NORTH);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementParkour.cost(context, x, y, z, Direction.NORTH, result);
        }
    },

    PARKOUR_SOUTH(0, 0, +4, true, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return parkour(context, src, Direction.SOUTH);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementParkour.cost(context, x, y, z, Direction.SOUTH, result);
        }
    },

    PARKOUR_EAST(+4, 0, 0, true, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return parkour(context, src, Direction.EAST);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementParkour.cost(context, x, y, z, Direction.EAST, result);
        }
    },

    PARKOUR_WEST(-4, 0, 0, true, true) {
        @Override
        public Movement apply0(CalculationContext context, BlockPos src) {
            return parkour(context, src, Direction.WEST);
        }

        @Override
        public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
            MovementParkour.cost(context, x, y, z, Direction.WEST, result);
        }
    };

    /** Whether the destination varies with terrain (variable parkour distance). */
    public final boolean dynamicXZ;
    /** Whether the destination height varies with terrain (descend may become a fall, diagonal may be +-1). */
    public final boolean dynamicY;

    public final int xOffset;
    public final int yOffset;
    public final int zOffset;

    Moves(int x, int y, int z, boolean dynamicXZ, boolean dynamicY) {
        this.xOffset = x;
        this.yOffset = y;
        this.zOffset = z;
        this.dynamicXZ = dynamicXZ;
        this.dynamicY = dynamicY;
    }

    Moves(int x, int y, int z) {
        this(x, y, z, false, false);
    }

    /**
     * Build an executable movement instance from src (used during path assembly); dynamic members return
     * null when the cost is infeasible.
     */
    public abstract Movement apply0(CalculationContext context, BlockPos src);

    /**
     * Compute the destination and cost of moving in this direction from (x,y,z). Static members fill the
     * result from the offset; dynamic members override this and let the cost function write the actual
     * destination.
     */
    public void apply(CalculationContext context, int x, int y, int z, MutableMoveResult result) {
        if (dynamicXZ || dynamicY) {
            throw new UnsupportedOperationException("A move with a dynamic offset must override apply");
        }
        result.x = x + xOffset;
        result.y = y + yOffset;
        result.z = z + zOffset;
        result.cost = cost(context, x, y, z);
    }

    public double cost(CalculationContext context, int x, int y, int z) {
        throw new UnsupportedOperationException("A move must override cost or apply");
    }

    /** Descend dispatch: exactly one block lower is a descend, lower is a fall, null if infeasible. */
    private static Movement descendOrFall(CalculationContext context, BlockPos src, Moves move) {
        MutableMoveResult res = new MutableMoveResult();
        move.apply(context, src.getX(), src.getY(), src.getZ(), res);
        if (res.cost >= ActionCosts.COST_INF) {
            return null;
        }
        BlockPos dest = new BlockPos(res.x, res.y, res.z);
        if (res.y == src.getY() - 1) {
            return new MovementDescend(context.player, src, dest);
        }
        return new MovementFall(context.player, src, dest);
    }

    private static Movement diagonal(CalculationContext context, BlockPos src, Moves move) {
        MutableMoveResult res = new MutableMoveResult();
        move.apply(context, src.getX(), src.getY(), src.getZ(), res);
        if (res.cost >= ActionCosts.COST_INF) {
            return null;
        }
        return new MovementDiagonal(context.player, src, new BlockPos(res.x, res.y, res.z));
    }

    private static Movement parkour(CalculationContext context, BlockPos src, Direction direction) {
        MutableMoveResult res = new MutableMoveResult();
        MovementParkour.cost(context, src.getX(), src.getY(), src.getZ(), direction, res);
        if (res.cost >= ActionCosts.COST_INF) {
            return null;
        }
        return new MovementParkour(context.player, src, new BlockPos(res.x, res.y, res.z));
    }
}
