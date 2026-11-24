package dev.mcagent.runtime.core.task.base;

import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.entity.BotPlayer;

/**
 * The "walk within reach, then act" shape shared by every task that navigates to a
 * target and then does one bounded thing there ({@code place_block},
 * {@code break_block}, {@code interact}, a single attack engagement, …). It collapses
 * the identical nav-drive-then-act loop those tasks each hand-wrote onto three small
 * abstract hooks, leaving each concrete task to describe only its target, its
 * arrival test, and its action.
 *
 * <h2>Shape</h2>
 * <ul>
 *   <li>{@link #onStart()} builds the nav from {@link #buildNav()}.</li>
 *   <li>each tick: if {@link #reached()} → {@link #act()}; otherwise drive the nav —
 *       {@code RUNNING}/{@code ARRIVED} keep going, {@code FAILED} routes through
 *       {@link #handleNavFailure(FailureType, String)}.</li>
 * </ul>
 *
 * <h2>Recovery hook</h2>
 * The default {@link #handleNavFailure} is today's behaviour: report the nav's
 * cause via {@link #fail} and terminate. This is the seam a later stage overrides
 * to attach a a task-specific recovery strategy — swap "give up on a nav failure" for "try the
 * next rung" WITHOUT touching the loop or the concrete tasks.
 *
 * @param <R> the concrete {@link TaskRecord} subtype for this task.
 */
public abstract class GoToThenDoTask<R extends TaskRecord> extends AbstractBotTask<R> {

    protected GoToThenDoTask(BotPlayer player, R record) {
        super(player, record);
    }

    /** Build the navigation toward this task's target. Assigned to {@link #nav} on start.
     *  Action tasks on block targets return null: they carry no approach navigation, so the body must
     *  already be within working distance ({@link #reached()}); otherwise they fail with an instructive
     *  message telling the caller to goto first. */
    protected abstract PlayerNav buildNav();

    /**
     * The target cell named by the instructive failure (used for the distance and the goto coordinates).
     * Null means no fixed target cell (entity target, in-place action), and the failure falls back to a
     * generic message. Defaults to null.
     */
    protected net.minecraft.core.BlockPos gotoFirstTarget() {
        return null;
    }

    /** Are we within reach to {@link #act()} this tick? */
    protected abstract boolean reached();

    /** Do the bounded thing at the target; return {@link TaskState#RUNNING} or a terminal state. */
    protected abstract TaskState act();

    @Override
    protected void onStart() {
        nav = buildNav();
    }

    /** Consecutive nav-ARRIVED ticks with {@link #reached()} still false. */
    private int dudTicks = 0;
    /** Grace before arrived-but-not-reached is declared a stance dud — landing,
     *  settling and onGround can lag goal membership by a few ticks. */
    private static final int DUD_GRACE_TICKS = 10;

    @Override
    protected final TaskState onTick() {
        if (reached()) return act();
        if (nav == null) {
            // Action task without approach navigation: out of working distance is an instructive failure; travel belongs to goto
            net.minecraft.core.BlockPos t = gotoFirstTarget();
            if (t != null) {
                double dist = Math.sqrt(player.distanceToSqr(
                        t.getX() + 0.5, t.getY() + 0.5, t.getZ() + 0.5));
                fail("target " + t.getX() + "," + t.getY() + "," + t.getZ() + " is "
                        + String.format("%.1f", dist) + " blocks away — out of working reach."
                        + " goto it first (goto stops right beside a solid block), then call"
                        + " this again.", FailureType.OUT_OF_REACH);
            } else {
                fail("out of working reach and this action does not travel — goto the spot"
                        + " first, then call this again.", FailureType.OUT_OF_REACH);
            }
            return TaskState.FAILED;
        }
        return switch (nav.tick()) {
            case RUNNING -> {
                dudTicks = 0;
                yield TaskState.RUNNING;
            }
            case ARRIVED -> {
                // reached() said no above, so the nav's arrival is a stance-dud
                // candidate: the search's membership is satisfied but the work
                // still can't start from here (out of reach, no sight line).
                // Route it through the SAME recovery ladder a failed path uses —
                // it is just one more way this bounded goal failed to yield a
                // working stance. The grace window absorbs settle transients.
                if (++dudTicks < DUD_GRACE_TICKS) {
                    yield TaskState.RUNNING;
                }
                dudTicks = 0;
                stopNav();
                dev.mcagent.runtime.core.Constants.LOG.info(
                        "[mc_agent-task] STANCE_DUD {} feet={} — nav arrived, reached() still"
                                + " false after {} ticks; routing the recovery ladder",
                        getClass().getSimpleName(), player.blockPosition().toShortString(),
                        DUD_GRACE_TICKS);
                yield handleNavFailure(FailureType.STANCE_DUD,
                        "arrived where the route ends, but the target is still out of"
                                + " reach from there");
            }
            case FAILED -> handleNavFailure(nav.failType(), nav.failReason());
        };
    }

    /**
     * React to the nav giving up. Default: {@code fail(reason, type)} and
     * terminate FAILED. Override to interpose a a task-specific recovery strategy that offers
     * an alternative approach to the same bounded goal before conceding.
     */
    protected TaskState handleNavFailure(FailureType type, String reason) {
        fail(reason, type);
        return TaskState.FAILED;
    }

    @Override
    protected abstract String successMessage();
}
