package dev.mcagent.runtime.core.pathing.astar;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import org.junit.jupiter.api.Test;

import static dev.mcagent.runtime.core.pathing.astar.AstarTestSupport.NEVER_GOAL;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Binary heap stress test: insertion, decrease-key, and ordered pops. */
class BinaryHeapOpenSetStressTest {

    private static PathNode node(int i, double combinedCost) {
        PathNode n = new PathNode(i, 0, 0, NEVER_GOAL);
        n.combinedCost = combinedCost;
        return n;
    }

    @Test
    void drainsInNonDecreasingOrder() {
        Random random = new Random(42);
        BinaryHeapOpenSet heap = new BinaryHeapOpenSet();
        int count = 5000;
        for (int i = 0; i < count; i++) {
            heap.insert(node(i, random.nextDouble() * 1000));
        }
        assertEquals(count, heap.size());
        double last = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < count; i++) {
            PathNode popped = heap.removeLowest();
            assertTrue(popped.combinedCost >= last,
                    "pop " + i + " out of order: " + popped.combinedCost + " < " + last);
            assertEquals(-1, popped.heapPosition, "popped node should be marked as not in the heap");
            last = popped.combinedCost;
        }
        assertTrue(heap.isEmpty());
    }

    @Test
    void decreaseKeyMovesNodeForward() {
        Random random = new Random(7);
        BinaryHeapOpenSet heap = new BinaryHeapOpenSet();
        List<PathNode> nodes = new ArrayList<>();
        int count = 2000;
        for (int i = 0; i < count; i++) {
            PathNode n = node(i, 500 + random.nextDouble() * 1000);
            nodes.add(n);
            heap.insert(n);
        }
        // Decrease-key on a random half of the nodes
        for (int i = 0; i < count / 2; i++) {
            PathNode n = nodes.get(random.nextInt(count));
            n.combinedCost = random.nextDouble() * n.combinedCost;
            heap.update(n);
        }
        double last = Double.NEGATIVE_INFINITY;
        while (!heap.isEmpty()) {
            PathNode popped = heap.removeLowest();
            assertTrue(popped.combinedCost >= last);
            last = popped.combinedCost;
        }
    }

    @Test
    void decreaseKeyToMinimumSurfacesImmediately() {
        BinaryHeapOpenSet heap = new BinaryHeapOpenSet();
        List<PathNode> nodes = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            PathNode n = node(i, 100 + i);
            nodes.add(n);
            heap.insert(n);
        }
        PathNode target = nodes.get(99);
        target.combinedCost = 1;
        heap.update(target);
        assertSame(target, heap.removeLowest());
    }

    @Test
    void interleavedInsertAndRemove() {
        Random random = new Random(123);
        BinaryHeapOpenSet heap = new BinaryHeapOpenSet();
        int alive = 0;
        double lastPopped = Double.NEGATIVE_INFINITY;
        for (int round = 0; round < 10000; round++) {
            if (alive == 0 || random.nextBoolean()) {
                heap.insert(node(round, random.nextDouble() * 1000));
                alive++;
                // An insert may add a node smaller than earlier pops, so reset the pop-order baseline
                lastPopped = Double.NEGATIVE_INFINITY;
            } else {
                PathNode popped = heap.removeLowest();
                assertTrue(popped.combinedCost >= lastPopped);
                lastPopped = popped.combinedCost;
                alive--;
            }
        }
        assertEquals(alive, heap.size());
    }
}
