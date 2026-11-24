package dev.mcagent.runtime.core.pathing.astar;

import java.util.Arrays;

/**
 * Array-backed binary min-heap for the open set, ordered by combinedCost. The heapPosition cached on each
 * node supports decrease-key (update). Indices start at 1; parent/child links use bit shifts.
 */
public final class BinaryHeapOpenSet {

    /** Initial capacity (2^10). */
    private static final int INITIAL_CAPACITY = 1024;

    private PathNode[] array;
    private int size;

    public BinaryHeapOpenSet() {
        this(INITIAL_CAPACITY);
    }

    public BinaryHeapOpenSet(int size) {
        this.size = 0;
        this.array = new PathNode[size];
    }

    public int size() {
        return size;
    }

    public boolean isEmpty() {
        return size == 0;
    }

    /** Insert: append at the end, then sift up. */
    public void insert(PathNode value) {
        if (size >= array.length - 1) {
            array = Arrays.copyOf(array, array.length << 1);
        }
        size++;
        value.heapPosition = size;
        array[size] = value;
        update(value);
    }

    /** Decrease-key: after combinedCost shrinks, sift up from the current position. */
    public void update(PathNode val) {
        int index = val.heapPosition;
        int parentInd = index >>> 1;
        double cost = val.combinedCost;
        PathNode parentNode = array[parentInd];
        while (index > 1 && parentNode.combinedCost > cost) {
            array[index] = parentNode;
            array[parentInd] = val;
            val.heapPosition = parentInd;
            parentNode.heapPosition = index;
            index = parentInd;
            parentInd = index >>> 1;
            parentNode = array[parentInd];
        }
    }

    /** Pops the node with the smallest combinedCost: move the last element to the root, then sift down. */
    public PathNode removeLowest() {
        if (size == 0) {
            throw new IllegalStateException("Cannot pop from an empty heap");
        }
        PathNode result = array[1];
        PathNode val = array[size];
        array[1] = val;
        val.heapPosition = 1;
        array[size] = null;
        size--;
        result.heapPosition = -1;
        if (size < 2) {
            return result;
        }
        int index = 1;
        int smallerChild = 2;
        double cost = val.combinedCost;
        do {
            PathNode smallerChildNode = array[smallerChild];
            double smallerChildCost = smallerChildNode.combinedCost;
            if (smallerChild < size) {
                PathNode rightChildNode = array[smallerChild + 1];
                double rightChildCost = rightChildNode.combinedCost;
                if (smallerChildCost > rightChildCost) {
                    smallerChild++;
                    smallerChildCost = rightChildCost;
                    smallerChildNode = rightChildNode;
                }
            }
            if (cost <= smallerChildCost) {
                break;
            }
            array[index] = smallerChildNode;
            array[smallerChild] = val;
            val.heapPosition = smallerChild;
            smallerChildNode.heapPosition = index;
            index = smallerChild;
        } while ((smallerChild <<= 1) <= size);
        return result;
    }
}
