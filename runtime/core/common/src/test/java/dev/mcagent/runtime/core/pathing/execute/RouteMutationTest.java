package dev.mcagent.runtime.core.pathing.execute;

import java.util.EnumSet;
import java.util.ArrayList;
import java.util.List;

import dev.mcagent.runtime.core.pathing.moves.Input;
import dev.mcagent.runtime.core.pathing.moves.MovementState;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RouteMutationTest {

    @Test
    void fullTraversalDefaultPermitsEveryTypedMutation() {
        RouteMutationPolicy policy = RouteMutationPolicy.fullTraversal();
        BlockPos target = new BlockPos(4, 65, -2);

        assertTrue(policy.permits(new RouteMutation.Open(target)));
        assertTrue(policy.permits(new RouteMutation.Break(target)));
        assertTrue(policy.permits(new RouteMutation.Place(target)));
    }

    @Test
    void policyAndTargetsAreImmutableSnapshots() {
        EnumSet<RouteMutation.Kind> requested = EnumSet.of(RouteMutation.Kind.OPEN);
        RouteMutationPolicy policy = RouteMutationPolicy.of(requested);
        BlockPos.MutableBlockPos mutableTarget = new BlockPos.MutableBlockPos(1, 2, 3);
        RouteMutation.Open open = new RouteMutation.Open(mutableTarget);

        requested.add(RouteMutation.Kind.PLACE);
        mutableTarget.set(9, 9, 9);

        assertTrue(policy.permits(open));
        assertFalse(policy.permits(new RouteMutation.Place(open.target())));
        assertEquals(new BlockPos(1, 2, 3), open.target());
    }

    @Test
    void executionSeamKeepsOpenSeparateFromPlaceAndUnrelatedUse() {
        BlockPos door = new BlockPos(7, 64, 1);
        BlockPos scaffold = new BlockPos(8, 63, 1);
        RecordingExecution execution = new RecordingExecution();
        MovementState opening = new MovementState()
                .setRouteMutation(new RouteMutation.Open(door));
        MovementState unrelatedUse = new MovementState()
                .setInput(Input.CLICK_RIGHT, true);
        MovementState placing = new MovementState()
                .setRouteMutation(new RouteMutation.Place(scaffold));

        opening.dispatchTo(execution);
        unrelatedUse.dispatchTo(execution);
        placing.dispatchTo(execution);

        assertInstanceOf(RouteMutation.Open.class, execution.mutations.get(0));
        assertEquals(door, execution.mutations.get(0).target());
        assertInstanceOf(RouteMutation.Place.class, execution.mutations.get(1));
        assertEquals(scaffold, execution.mutations.get(1).target());
        assertEquals(List.of(Input.CLICK_RIGHT), execution.inputs);
    }

    private static final class RecordingExecution
            implements dev.mcagent.runtime.core.pathing.moves.Movement.ExecutionDelegate {
        private final List<RouteMutation> mutations = new ArrayList<>();
        private final List<Input> inputs = new ArrayList<>();

        @Override
        public void applyRouteMutation(RouteMutation mutation) {
            mutations.add(mutation);
        }

        @Override
        public void applyRotation(MovementState.MovementTarget target) {}

        @Override
        public void clearInputs() {}

        @Override
        public void applyInput(Input input, boolean held) {
            if (held) inputs.add(input);
        }
    }

    @Test
    void navigationIntentDefaultsToFullTraversal() {
        java.util.function.Supplier<dev.mcagent.runtime.core.pathing.goal.GoalCompiler.Compiled> compiled =
                () -> null;
        NavigationIntent intent = NavigationIntent.fullTraversal(compiled);

        assertSame(compiled, intent.compiled());
        assertTrue(intent.routeMutations().permits(RouteMutation.Kind.OPEN));
        assertTrue(intent.routeMutations().permits(RouteMutation.Kind.BREAK));
        assertTrue(intent.routeMutations().permits(RouteMutation.Kind.PLACE));
    }
}
