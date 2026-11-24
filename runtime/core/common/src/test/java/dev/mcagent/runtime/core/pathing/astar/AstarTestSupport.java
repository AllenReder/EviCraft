package dev.mcagent.runtime.core.pathing.astar;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;

import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;

import net.minecraft.core.BlockPos;

/** Shared fakes for the astar unit tests: goals, fake movements, fake paths, and a straight-path factory. */
final class AstarTestSupport {

    private AstarTestSupport() {}

    /** Goal that is never reached; its heuristic is always 0. */
    static final Goal NEVER_GOAL = new Goal() {
        @Override
        public boolean isInGoal(int x, int y, int z) {
            return false;
        }

        @Override
        public double heuristic(int x, int y, int z) {
            return 0;
        }
    };

    /** Goal that every position satisfies. */
    static final Goal ALWAYS_GOAL = new Goal() {
        @Override
        public boolean isInGoal(int x, int y, int z) {
            return true;
        }

        @Override
        public double heuristic(int x, int y, int z) {
            return 0;
        }
    };

    /** Fake movement with a fixed cost and no player (container semantics only; never executed). */
    static final class TestMovement extends Movement {

        TestMovement(BlockPos src, BlockPos dest, double cost) {
            super(null, src, dest, new BlockPos[0]);
            override(cost);
        }

        @Override
        public double calculateCost(CalculationContext context, MutableMoveResult result) {
            return getCost();
        }

        @Override
        protected Set<BlockPos> calculateValidPositions() {
            return Set.of(getSrc(), getDest());
        }
    }

    /** Fake path whose content is exactly the given list. */
    static final class FakePath extends PathBase {

        private final List<BlockPos> positions;
        private final List<Movement> movements;
        private final Goal goal;

        FakePath(List<BlockPos> positions, List<Movement> movements, Goal goal) {
            this.positions = positions;
            this.movements = movements;
            this.goal = goal;
        }

        @Override
        public List<Movement> movements() {
            return Collections.unmodifiableList(movements);
        }

        @Override
        public List<BlockPos> positions() {
            return Collections.unmodifiableList(positions);
        }

        @Override
        public Goal getGoal() {
            return goal;
        }

        @Override
        public int getNumNodesConsidered() {
            return 0;
        }
    }

    /**
     * Straight path along +x: {@code length} cells starting at startX, with y=64 and z=0, and a fake
     * movement of cost 1 per step.
     */
    static FakePath line(int startX, int length, Goal goal) {
        List<BlockPos> positions = new ArrayList<>();
        List<Movement> movements = new ArrayList<>();
        for (int i = 0; i < length; i++) {
            positions.add(new BlockPos(startX + i, 64, 0));
        }
        for (int i = 0; i < length - 1; i++) {
            movements.add(new TestMovement(positions.get(i), positions.get(i + 1), 1));
        }
        return new FakePath(positions, movements, goal);
    }
}
