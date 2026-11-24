package dev.mcagent.runtime.core.pathing.moves;

/**
 * Chunk-loaded predicate: given the XZ of a block coordinate, reports whether its chunk is loaded
 * (or captured by a snapshot). Injected by the caller as a lambda.
 */
@FunctionalInterface
public interface ChunkLoadedTest {

    /** Always treated as loaded (live world). */
    ChunkLoadedTest ALWAYS = (x, z) -> true;

    boolean isLoaded(int blockX, int blockZ);
}
