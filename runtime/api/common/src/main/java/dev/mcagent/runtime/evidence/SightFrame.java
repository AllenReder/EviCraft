package dev.mcagent.runtime.evidence;

import net.minecraft.world.level.block.state.BlockState;

/**
 * Cells one observation frame saw, grouped by chunk section. Each section carries two 4096-bit
 * sets (bit index {@code x | z << 4 | y << 8}): cells a sight ray passed through as air, and
 * non-air cells a sight ray hit. Valid only until the sensor that produced it samples again.
 */
interface SightFrame {

    int sectionCount();

    int sectionX(int section);

    int sectionY(int section);

    int sectionZ(int section);

    long[] air(int section);

    long[] block(int section);

    /** Live state of a cell from {@link #block}. */
    BlockState state(int section, int localIndex);
}
