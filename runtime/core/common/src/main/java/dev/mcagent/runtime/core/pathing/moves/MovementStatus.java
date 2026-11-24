package dev.mcagent.runtime.core.pathing.moves;

/**
 * Execution state machine of a single movement primitive:
 * PREPPING (preparing, mining obstacles) -> WAITING (ready to start) -> RUNNING (executing)
 * -> one of four terminal states.
 */
public enum MovementStatus {

    /** Preparing: still mining blocking blocks or waiting for the environment to be ready. */
    PREPPING(false),
    /** Preparation done; waiting to start execution. */
    WAITING(false),
    /** Executing. */
    RUNNING(false),
    /** Reached the destination. */
    SUCCESS(true),
    /** Judged unreachable (for example, fell out of the valid region midway). */
    UNREACHABLE(true),
    /** Execution failed. */
    FAILED(true),
    /** Canceled externally. */
    CANCELED(true);

    private final boolean complete;

    MovementStatus(boolean complete) {
        this.complete = complete;
    }

    /** Whether this is a terminal state (SUCCESS / UNREACHABLE / FAILED / CANCELED). */
    public boolean isComplete() {
        return complete;
    }
}
