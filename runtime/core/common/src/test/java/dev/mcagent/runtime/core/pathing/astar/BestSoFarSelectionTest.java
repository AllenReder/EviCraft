package dev.mcagent.runtime.core.pathing.astar;

import java.util.Optional;

import org.junit.jupiter.api.Test;

import dev.mcagent.runtime.core.pathing.goals.Goal;

import net.minecraft.core.BlockPos;

import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.NEVER_GOAL;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Selection criteria for the seven bestSoFar tiers, and the PathNode construction contract. */
class BestSoFarSelectionTest {

    /** Test search with a no-op calculate0; tests set the seven-tier array directly. */
    private static final class TestSearch extends AbstractNodeCostSearch {

        TestSearch(int startX, int startY, int startZ, Goal goal) {
            super(new BlockPos(startX, startY, startZ), startX, startY, startZ, goal, null);
        }

        @Override
        protected Optional<NavPath> calculate0(long primaryTimeout, long failureTimeout) {
            return Optional.empty();
        }
    }

    /** Builds a node linked back to start and assigns its cost. */
    private static PathNode chained(PathNode previous, int x, int y, int z, double cost, Goal goal) {
        PathNode node = new PathNode(x, y, z, goal);
        node.previous = previous;
        node.cost = cost;
        return node;
    }

    @Test
    void startNodeNullYieldsEmpty() {
        TestSearch search = new TestSearch(0, 64, 0, NEVER_GOAL);
        assertTrue(search.bestPathSoFar().isEmpty());
    }

    @Test
    void allTiersTooCloseYieldsEmpty() {
        TestSearch search = new TestSearch(0, 64, 0, NEVER_GOAL);
        search.startNode = chained(null, 0, 64, 0, 0, NEVER_GOAL);
        // Every tier holds the node 4 blocks from the start (distance squared 16 ≤ 25)
        PathNode near = chained(search.startNode, 4, 64, 0, 10, NEVER_GOAL);
        for (int i = 0; i < 7; i++) {
            search.bestSoFar[i] = near;
        }
        assertTrue(search.bestPathSoFar().isEmpty());
    }

    @Test
    void exactlyFiveBlocksIsNotEnough() {
        // The criterion is strictly greater than 25; exactly 5 blocks (25) is not enough
        TestSearch search = new TestSearch(0, 64, 0, NEVER_GOAL);
        search.startNode = chained(null, 0, 64, 0, 0, NEVER_GOAL);
        search.bestSoFar[0] = chained(search.startNode, 5, 64, 0, 10, NEVER_GOAL);
        assertTrue(search.bestPathSoFar().isEmpty());
    }

    @Test
    void firstQualifyingTierWins() {
        TestSearch search = new TestSearch(0, 64, 0, NEVER_GOAL);
        search.startNode = chained(null, 0, 64, 0, 0, NEVER_GOAL);
        // Tiers 0 and 1 empty, tier 2 is 6 blocks out, tier 3 farther: pick tier 2 (first qualifying)
        PathNode tier2 = chained(search.startNode, 6, 64, 0, 30, NEVER_GOAL);
        PathNode tier3 = chained(search.startNode, 20, 64, 0, 90, NEVER_GOAL);
        search.bestSoFar[2] = tier2;
        search.bestSoFar[3] = tier3;
        Optional<NavPath> result = search.bestPathSoFar();
        assertTrue(result.isPresent());
        assertEquals(new BlockPos(6, 64, 0), result.get().getDest());
    }

    @Test
    void nearTierIsSkippedForFartherLaterTier() {
        TestSearch search = new TestSearch(0, 64, 0, NEVER_GOAL);
        search.startNode = chained(null, 0, 64, 0, 0, NEVER_GOAL);
        // Tier 0 is too close (3 blocks), tier 4 is far enough: skip tier 0 and fall through to tier 4
        search.bestSoFar[0] = chained(search.startNode, 3, 64, 0, 10, NEVER_GOAL);
        search.bestSoFar[4] = chained(search.startNode, 10, 64, 0, 60, NEVER_GOAL);
        Optional<NavPath> result = search.bestPathSoFar();
        assertTrue(result.isPresent());
        assertEquals(new BlockPos(10, 64, 0), result.get().getDest());
    }

    @Test
    void returnedPathTracesBackToStart() {
        TestSearch search = new TestSearch(0, 64, 0, NEVER_GOAL);
        search.startNode = chained(null, 0, 64, 0, 0, NEVER_GOAL);
        PathNode mid = chained(search.startNode, 3, 64, 0, 15, NEVER_GOAL);
        PathNode far = chained(mid, 7, 64, 0, 35, NEVER_GOAL);
        search.bestSoFar[0] = far;
        NavPath path = search.bestPathSoFar().orElseThrow();
        assertEquals(3, path.length());
        assertEquals(new BlockPos(0, 64, 0), path.getSrc());
        assertEquals(new BlockPos(7, 64, 0), path.getDest());
    }

    @Test
    void nanHeuristicThrowsAtNodeConstruction() {
        Goal nanGoal = new Goal() {
            @Override
            public boolean isInGoal(int x, int y, int z) {
                return false;
            }

            @Override
            public double heuristic(int x, int y, int z) {
                return Double.NaN;
            }
        };
        assertThrows(IllegalStateException.class, () -> new PathNode(0, 64, 0, nanGoal));
    }

    @Test
    void searchIsSingleUse() {
        TestSearch search = new TestSearch(0, 64, 0, NEVER_GOAL);
        assertEquals(PathCalcResult.Type.FAILURE, search.calculate(100, 200).getType());
        assertThrows(IllegalStateException.class, () -> search.calculate(100, 200));
    }
}
