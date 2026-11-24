package dev.mcagent.runtime.evidence;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Frozen block knowledge of a box of chunk columns, for planning.
 *
 * <p>The sections lie in one dense grid, so reading a cell is two array reads. States may be
 * read from any thread; {@link #block} reads provenance and clocks and is server-thread only.
 */
public final class BlockEvidenceSnapshot {

    private final BlockKnowledge.Section[] sections;
    private final int minSectionX;
    private final int minSectionY;
    private final int minSectionZ;
    private final int sizeX;
    private final int sizeY;
    private final int sizeZ;
    private final long contentVersion;

    BlockEvidenceSnapshot(
            BlockKnowledge.Section[] sections, int minSectionX, int minSectionY, int minSectionZ,
            int sizeX, int sizeY, int sizeZ, long contentVersion) {
        this.sections = sections;
        this.minSectionX = minSectionX;
        this.minSectionY = minSectionY;
        this.minSectionZ = minSectionZ;
        this.sizeX = sizeX;
        this.sizeY = sizeY;
        this.sizeZ = sizeZ;
        this.contentVersion = contentVersion;
    }

    /** Block content version of the knowledge this snapshot was taken from. */
    public long contentVersion() {
        return contentVersion;
    }

    /** The fact at {@code position} with its provenance and clocks; UNKNOWN when not known. */
    public BlockEvidenceCell block(BlockPos position) {
        BlockKnowledge.Section section = section(position);
        return section == null ? BlockEvidenceCell.unknown()
                : section.cell(BlockKnowledge.localIndex(position));
    }

    /** Air for known air, the block state for a known block, {@code null} when unknown. */
    public BlockState knownState(BlockPos position) {
        BlockKnowledge.Section section = section(position);
        return section == null ? null : section.state(BlockKnowledge.localIndex(position));
    }

    public boolean isKnownBlock(BlockPos position) {
        BlockState state = knownState(position);
        return state != null && !state.isAir();
    }

    public boolean isKnown(BlockPos position) {
        return knownState(position) != null;
    }

    private BlockKnowledge.Section section(BlockPos position) {
        int x = (position.getX() >> 4) - minSectionX;
        int y = (position.getY() >> 4) - minSectionY;
        int z = (position.getZ() >> 4) - minSectionZ;
        if (x < 0 || x >= sizeX || y < 0 || y >= sizeY || z < 0 || z >= sizeZ) return null;
        return sections[(x * sizeZ + z) * sizeY + y];
    }
}
