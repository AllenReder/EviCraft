package dev.mcagent.runtime.core.pathing.moves;

import java.util.EnumMap;
import java.util.Map;

import dev.mcagent.runtime.core.pathing.execute.RouteMutation;

/**
 * Per-tick output of a movement primitive: current status + desired rotation (optional) + keys to hold
 * this tick. The input map is cleared after each {@link Movement#update()} is applied, so keys never
 * stick across ticks.
 */
public class MovementState {

    private MovementStatus status;
    private MovementTarget target = new MovementTarget();
    private final Map<Input, Boolean> inputStates = new EnumMap<>(Input.class);
    private RouteMutation routeMutation;

    public MovementState setStatus(MovementStatus status) {
        this.status = status;
        return this;
    }

    public MovementStatus getStatus() {
        return status;
    }

    public MovementTarget getTarget() {
        return target;
    }

    public MovementState setTarget(MovementTarget target) {
        this.target = target;
        return this;
    }

    public MovementState setInput(Input input, boolean forced) {
        inputStates.put(input, forced);
        return this;
    }

    public Map<Input, Boolean> getInputStates() {
        return inputStates;
    }

    public MovementState setRouteMutation(RouteMutation routeMutation) {
        this.routeMutation = routeMutation;
        return this;
    }

    public RouteMutation getRouteMutation() {
        return routeMutation;
    }

    /** Deliver this tick's movement outputs across the physical execution seam. */
    public void dispatchTo(Movement.ExecutionDelegate execution) {
        if (execution != null) {
            if (target.hasRotation()) {
                execution.applyRotation(target);
            }
            execution.clearInputs();
            inputStates.forEach(execution::applyInput);
            if (routeMutation != null) {
                execution.applyRouteMutation(routeMutation);
            }
        }
        inputStates.clear();
        routeMutation = null;
    }

    /**
     * Desired rotation: target yaw/pitch and a force flag.
     * force=true means mining/placing needs real aim; false means walking heading only, which the
     * execution layer may handle silently (it affects only the movement direction, no real head turn).
     */
    public static final class MovementTarget {

        private final boolean hasRotation;
        private final float yaw;
        private final float pitch;
        private final boolean forceRotations;

        /** No rotation requirement. */
        public MovementTarget() {
            this.hasRotation = false;
            this.yaw = 0;
            this.pitch = 0;
            this.forceRotations = false;
        }

        public MovementTarget(float yaw, float pitch, boolean forceRotations) {
            this.hasRotation = true;
            this.yaw = yaw;
            this.pitch = pitch;
            this.forceRotations = forceRotations;
        }

        public boolean hasRotation() {
            return hasRotation;
        }

        public float getYaw() {
            return yaw;
        }

        public float getPitch() {
            return pitch;
        }

        public boolean hasToForceRotations() {
            return forceRotations;
        }
    }
}
