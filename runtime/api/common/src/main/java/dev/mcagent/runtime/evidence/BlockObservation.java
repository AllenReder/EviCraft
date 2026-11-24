package dev.mcagent.runtime.evidence;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;

import java.util.Objects;

/**
 * One source-labelled fact about one cell.
 *
 * @param block the live state found there, or {@code null} when the cell holds air and no fluid
 */
public record BlockObservation(BlockPos position, BlockState block, BlockEvidenceSource source) {
    public BlockObservation {
        position = Objects.requireNonNull(position, "position").immutable();
        Objects.requireNonNull(source, "source");
        if (block != null && block.isAir() && block.getFluidState().isEmpty()) block = null;
    }

    public static BlockObservation knownAir(BlockPos position, BlockEvidenceSource source) {
        return new BlockObservation(position, null, source);
    }

    /** The fact that {@code state} is at {@code position}; an air state is recorded as air. */
    public static BlockObservation of(
            BlockPos position, BlockState state, BlockEvidenceSource source) {
        return new BlockObservation(position, Objects.requireNonNull(state, "state"), source);
    }

    public BlockEvidenceCell.State state() {
        return block == null ? BlockEvidenceCell.State.KNOWN_AIR
                : BlockEvidenceCell.State.KNOWN_BLOCK;
    }
}
