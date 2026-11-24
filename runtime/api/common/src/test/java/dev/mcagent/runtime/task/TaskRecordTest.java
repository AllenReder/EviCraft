package dev.mcagent.runtime.task;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The line between standing and bounded tasks, which rests on this one number.
 *
 * <p>A deadline answers "how long should this take". A standing task <b>never finishes</b>, so it gets
 * {@link TaskRecord#NO_DEADLINE}: a game tick that never arrives. The criterion is therefore local and
 * needs no extra declaration: {@code TaskDispatch} uses it to word the acknowledgement, and the client
 * uses it to tell the model that this task will send no task_finished.
 */
class TaskRecordTest {

    private static final class Fake extends TaskRecord {
        Fake(long deadline) {
            super("fake", "call-1", deadline);
        }

        @Override public String describe() {
            return "fake";
        }
    }

    @Test
    void noDeadlineNeverArrives() {
        // A game day is 24000 ticks; this value is trillions of years away, so it never arrives.
        long aVeryLongGameLater = 24_000L * 365 * 1_000_000;
        assertTrue(TaskRecord.NO_DEADLINE > aVeryLongGameLater);
    }

    @Test
    void freezingAStandingTaskCannotOverflow() {
        // Each preempted tick adds one to the deadline (TaskSlot.freeze). With MAX_VALUE, a few reflex
        // preemptions of a standing task would overflow it to a negative value; gameTime >= deadline would
        // then hold at once and the Bot's work would time out without warning. Half the range is headroom.
        Fake standing = new Fake(TaskRecord.NO_DEADLINE);
        for (int i = 0; i < 1000; i++) {
            standing.extendDeadlineTo(standing.getDeadlineGameTime() + 1);
        }
        assertTrue(standing.getDeadlineGameTime() > 0, "deadline overflowed to a negative value");
        assertTrue(standing.getDeadlineGameTime() >= TaskRecord.NO_DEADLINE);
    }

    @Test
    void standingIsTellableFromTheDeadlineAlone() {
        // No separate standing field is needed: the deadline itself says whether the task has an end.
        assertTrue(new Fake(TaskRecord.NO_DEADLINE).getDeadlineGameTime() >= TaskRecord.NO_DEADLINE);
        assertFalse(new Fake(12_000L).getDeadlineGameTime() >= TaskRecord.NO_DEADLINE);
    }

    @Test
    void aSleepingTaskStillGrowsOld() {
        // The "just accepted" gate exists for a model that dispatches two jobs in one batch of tool calls.
        // Its criterion must be <b>the record's age</b>, not the number of ticks the task ran: follow goes
        // dormant next to its target (canRun returns false) and the slot is not ticked. With the tick count,
        // a follow task running for ten minutes would still count as just accepted, every request to pick up
        // a drop would be refused, and the refusal would tell the model to wait for a task_finished that a
        // standing task never sends.
        //
        // The criterion asks how old the record is, regardless of whether it ever ran.
        Fake sleeping = new Fake(TaskRecord.NO_DEADLINE);
        sleeping.markStarted(100L);

        assertTrue(sleeping.acceptedThisTick(100L), "on the accepting tick, it is freshly accepted");
        assertFalse(sleeping.acceptedThisTick(101L), "not on the next tick, even if it never ran a single tick");
        assertFalse(sleeping.acceptedThisTick(100L + 20 * 600L), "certainly not ten minutes later");
    }

    @Test
    void anUnstartedRecordIsNotFresh() {
        // markStarted was never called (startedGameTime = -1): -1 being smaller than every tick must neither
        // match by accident nor make every tick count as just accepted.
        assertFalse(new Fake(1000L).acceptedThisTick(0L));
    }

    @Test
    void deadlinesOnlyEverMoveLater() {
        // Freezing only ever moves the deadline later: a preemption must not erase grace already granted.
        Fake bounded = new Fake(1000L);
        bounded.extendDeadlineTo(2000L);
        bounded.extendDeadlineTo(1500L);
        org.junit.jupiter.api.Assertions.assertEquals(2000L, bounded.getDeadlineGameTime());
    }
}
