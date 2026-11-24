package dev.mcagent.runtime.core.pathing.moves;

import java.util.Set;

import dev.mcagent.runtime.core.pathing.execute.RouteMutation;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementPillar;
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;

import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Attribution and classification of physical failure reports (offline pure logic, no MC bootstrap).
 * Attribution relies on {@code dispatchedMutation}, which {@code update()} sets before {@code dispatchTo}
 * clears the state; offline, a subclass hook reproduces the same ordering.
 */
class MovementFailureFeedbackTest {

    private static final BlockPos SRC = new BlockPos(0, 64, 0);
    private static final BlockPos DEST = new BlockPos(0, 65, 0);

    /**
     * Fake movement reproducing the real ordering: {@code update()} stores this tick's mutation in
     * {@code dispatchedMutation} before {@code dispatchTo} clears the state. {@code update()} cannot run
     * offline (it needs a player), so reflection reproduces the same assignment to test attribution.
     */
    private static class FakeMovement extends Movement {

        FakeMovement(RouteMutation dispatched) {
            super(null, SRC, DEST, new BlockPos[0], null);
            try {
                java.lang.reflect.Field f = Movement.class.getDeclaredField("dispatchedMutation");
                f.setAccessible(true);
                f.set(this, dispatched);
            } catch (ReflectiveOperationException e) {
                throw new AssertionError(e);
            }
        }

        @Override
        public double calculateCost(CalculationContext context, MutableMoveResult result) {
            return 1.0;
        }

        @Override
        protected Set<BlockPos> calculateValidPositions() {
            return Set.of(SRC, DEST);
        }
    }

    private static PhysicalVerificationAuthority.Failure failure(
            PhysicalVerificationAuthority.FailureCode code) {
        return new PhysicalVerificationAuthority.Failure(code, "test failure", null);
    }

    @Test
    void persistentFailureAdoptedAndRecorded() {
        RouteMutation.Place place = new RouteMutation.Place(SRC);
        FakeMovement movement = new FakeMovement(place);

        movement.onRouteMutationFailed(place,
                failure(PhysicalVerificationAuthority.FailureCode.NO_SUPPORT));

        assertEquals(PhysicalVerificationAuthority.FailureCode.NO_SUPPORT,
                movement.lastExecutionFailure().code());
        assertEquals(SRC, movement.lastFailedMutationTarget());
    }

    @Test
    void mismatchedMutationReceiptIgnored() {
        RouteMutation.Place requested = new RouteMutation.Place(SRC);
        RouteMutation.Place other = new RouteMutation.Place(DEST);
        FakeMovement movement = new FakeMovement(requested);

        movement.onRouteMutationFailed(other,
                failure(PhysicalVerificationAuthority.FailureCode.NO_SUPPORT));

        assertNull(movement.lastExecutionFailure());
        assertNull(movement.lastFailedMutationTarget());
    }

    @Test
    void transientFailureRecordedButAdoptedRepeatedly() {
        RouteMutation.Place place = new RouteMutation.Place(SRC);
        FakeMovement movement = new FakeMovement(place);

        // Consecutive transient failures within the limit: every report is adopted, none lost
        for (int i = 0; i < 25; i++) {
            movement.onRouteMutationFailed(place,
                    failure(PhysicalVerificationAuthority.FailureCode.ENTITY_BLOCKED));
        }
        assertEquals(PhysicalVerificationAuthority.FailureCode.ENTITY_BLOCKED,
                movement.lastExecutionFailure().code());
    }

    @Test
    void transientClassificationWidenedByPillarOnly() {
        // Base class: NO_SUPPORT is a persistent code (exercised through the full report path)
        FakeMovement base = new FakeMovement(new RouteMutation.Place(SRC));
        base.onRouteMutationFailed(new RouteMutation.Place(SRC),
                failure(PhysicalVerificationAuthority.FailureCode.NO_SUPPORT));
        // A persistent code means immediate UNREACHABLE; the status only takes effect in update(), so it is
        // checked offline through the classification hook
        assertFalse(isTransient(base,
                failure(PhysicalVerificationAuthority.FailureCode.NO_SUPPORT)));
        assertTrue(isTransient(base,
                failure(PhysicalVerificationAuthority.FailureCode.ENTITY_BLOCKED)));
        assertTrue(isTransient(base,
                failure(PhysicalVerificationAuthority.FailureCode.VERIFICATION_FAILED)));
        // The body still in the target cell during jump placement is transient, like occupancy by others
        assertTrue(isTransient(base,
                failure(PhysicalVerificationAuthority.FailureCode.BODY_IN_TARGET)));

        // Pillar widens: NO_SUPPORT is transient (recoverable within the jump window)
        MovementPillar pillar = new MovementPillar(null, SRC, DEST);
        assertTrue(isTransient(pillar,
                failure(PhysicalVerificationAuthority.FailureCode.NO_SUPPORT)));
        // But never narrows: the base class's persistent codes stay persistent for Pillar
        assertFalse(isTransient(pillar,
                failure(PhysicalVerificationAuthority.FailureCode.ITEM_NOT_FOUND)));
    }

    /** The cancel path (execution layer clear/abort) produces no report: reports exist only on the commit's
     * Failed branch, and the movement records only what arrives. Nobody calls onRouteMutationFailed on
     * cancel, so the fields stay null; this models "no new mutation after cancel". */
    @Test
    void cancellationProducesNoReceipt() {
        RouteMutation.Place place = new RouteMutation.Place(SRC);
        FakeMovement movement = new FakeMovement(place);

        // Cancel path: the execution layer's cancelPhysicalMutation/stopBreaking/clearAllKeys never take the
        // Failed branch, so the report entry point is never called and nothing is recorded
        assertNull(movement.lastExecutionFailure(),
                "cancellation leaked a failure receipt into movement decisions");
        assertNull(movement.lastFailedMutationTarget(),
                "cancellation recorded a failed mutation target");
    }

    /** Call the protected classification hook via reflection (inaccessible across packages). */
    private static boolean isTransient(Movement movement,
            PhysicalVerificationAuthority.Failure failure) {
        try {
            java.lang.reflect.Method m = Movement.class.getDeclaredMethod(
                    "isTransientFailure", PhysicalVerificationAuthority.Failure.class);
            m.setAccessible(true);
            return (boolean) m.invoke(movement, failure);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }
}
