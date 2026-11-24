package dev.mcagent.runtime.core.pathing.astar;

import java.util.Optional;

/** Outcome of one path calculation: result type plus a nullable path. */
public final class PathCalcResult {

    public enum Type {
        /** Found a complete path to the goal. */
        SUCCESS_TO_GOAL,
        /** Found a partial segment that makes progress toward the goal. */
        SUCCESS_SEGMENT,
        /** The calculation was cooperatively cancelled. */
        CANCELLATION,
        /** The search used up its budget without a usable path. */
        FAILURE,
        /** The calculation threw an exception. */
        EXCEPTION
    }

    private final Type type;
    private final NavPath path;

    public PathCalcResult(Type type) {
        this(type, null);
    }

    public PathCalcResult(Type type, NavPath path) {
        this.type = type;
        this.path = path;
        boolean success = type == Type.SUCCESS_TO_GOAL || type == Type.SUCCESS_SEGMENT;
        if (success && path == null) {
            throw new IllegalArgumentException("A successful result must have a path");
        }
        if (!success && path != null) {
            throw new IllegalArgumentException("A non-successful result must not have a path");
        }
    }

    public Type getType() {
        return type;
    }

    public Optional<NavPath> getPath() {
        return Optional.ofNullable(path);
    }
}
