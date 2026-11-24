package dev.mcagent.runtime.evidence;

import net.minecraft.world.level.block.state.BlockState;

import java.util.Objects;

/** One immutable three-state cell in the Embodied World Evidence store. */
public record BlockEvidenceCell(
        State state,
        String blockState,
        String fluid,
        BlockEvidenceSource source,
        long observedTick,
        long observationRevision
) {
    private static final BlockEvidenceCell UNKNOWN = new BlockEvidenceCell(
            State.UNKNOWN, null, null, null, -1L, -1L);

    public enum State {
        UNKNOWN,
        KNOWN_AIR,
        KNOWN_BLOCK
    }

    public BlockEvidenceCell {
        Objects.requireNonNull(state, "state");
        if (state == State.UNKNOWN) {
            if (blockState != null || fluid != null || source != null
                    || observedTick != -1L || observationRevision != -1L) {
                throw new IllegalArgumentException("UNKNOWN must not carry evidence metadata");
            }
        } else {
            Objects.requireNonNull(source, "source");
            if (observedTick < 0 || observationRevision < 1) {
                throw new IllegalArgumentException("known evidence requires non-negative clocks");
            }
            if (state == State.KNOWN_BLOCK) {
                Objects.requireNonNull(blockState, "blockState");
                Objects.requireNonNull(fluid, "fluid");
            } else if (blockState != null || fluid != null) {
                throw new IllegalArgumentException("only KNOWN_BLOCK carries block state and fluid");
            }
        }
    }

    public static BlockEvidenceCell unknown() {
        return UNKNOWN;
    }

    /** Stable wire representation of one physically verified live BlockState. */
    public static String canonicalBlockState(BlockState state) {
        return BlockStateCanonicalizer.block(Objects.requireNonNull(state, "state"));
    }

    /** Loaded-client fact copied from an immutable chunk page at one publication. */
    public static BlockEvidenceCell loadedWorldState(
            BlockState state, long observedTick, long observationRevision) {
        Objects.requireNonNull(state, "state");
        return state.isAir() && state.getFluidState().isEmpty()
                ? new BlockEvidenceCell(State.KNOWN_AIR, null, null,
                        BlockEvidenceSource.LOADED_WORLD_STATE,
                        observedTick, observationRevision)
                : new BlockEvidenceCell(State.KNOWN_BLOCK,
                        BlockStateCanonicalizer.block(state),
                        BlockStateCanonicalizer.fluid(state.getFluidState()),
                        BlockEvidenceSource.LOADED_WORLD_STATE,
                        observedTick, observationRevision);
    }

    /** Whether one exact live cell still agrees with this evidence-bound fact. */
    public boolean matches(BlockState actual) {
        Objects.requireNonNull(actual, "actual");
        return switch (state) {
            case UNKNOWN -> false;
            case KNOWN_AIR -> actual.isAir() && actual.getFluidState().isEmpty();
            case KNOWN_BLOCK -> !actual.isAir()
                    && blockState.equals(BlockStateCanonicalizer.block(actual))
                    && fluid.equals(BlockStateCanonicalizer.fluid(actual.getFluidState()));
        };
    }

    public static BlockEvidenceCell from(BlockObservation observation, long tick, long revision) {
        BlockState block = observation.block();
        return block == null
                ? new BlockEvidenceCell(State.KNOWN_AIR, null, null, observation.source(),
                        tick, revision)
                : new BlockEvidenceCell(State.KNOWN_BLOCK, BlockStateCanonicalizer.block(block),
                        BlockStateCanonicalizer.fluid(block.getFluidState()),
                        observation.source(), tick, revision);
    }
}
