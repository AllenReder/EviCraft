package dev.mcagent.runtime.core.pathing.execute;

import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.pathing.bridge.PoolSearchDispatcher;
import dev.mcagent.runtime.core.pathing.calc.NavGoal;
import dev.mcagent.runtime.core.pathing.execute.PathExecutor;
import dev.mcagent.runtime.core.pathing.execute.PathingCore;
import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.core.pathing.util.NavProfiler;
import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import it.unimi.dsi.fastutil.longs.LongSet;
import it.unimi.dsi.fastutil.longs.LongSets;
import net.minecraft.core.BlockPos;

/**
 * Task-layer entry point for navigation: hands a compiled navigation contract
 * ({@link GoalCompiler.Compiled}) to the segment-planning state machine {@link PathingCore} and exposes
 * a three-state contract ({@link Status}):
 * <ul>
 *   <li>the caller's {@code reached} predicate is always checked first; true means ARRIVED;</li>
 *   <li>when the search goal is already satisfied underfoot (nothing to walk), ARRIVED is returned
 *       stably. The task layer uses this to detect "in place but not satisfied" (STANCE_DUD) and
 *       handle it; it never decays into a one-tick target lost;</li>
 *   <li>a goal center that moves more than 2 blocks triggers a re-root; execution failures are
 *       re-searched automatically by the state machine, and this layer only keeps the give-up
 *       bookkeeping (see {@link #accountReplan}).</li>
 * </ul>
 *
 * <p>The engine retries forever; when to give up is task-level semantics and lives here: if
 * {@link #MAX_STALLED_REPLANS} consecutive failed replans bring no goal-heuristic improvement of at
 * least {@link #REPLAN_PROGRESS_EPS_H}, the result is FAILED(BOXED_IN); {@link #MAX_REPLANS} is a hard
 * fuse.
 *
 * <p>Two semantic switches, sacred (the target's own blocks, never broken or buried) and deniedPlace
 * (blocks the execution layer proved cannot be placed), pass through every {@link CalculationContext}
 * this navigation builds: the search uses a frozen snapshot and execution rechecks use the live world,
 * with the same switches and the same measure.
 */
public final class PlayerNav {

    public enum Status { RUNNING, ARRIVED, FAILED }

    /** Hard fuse on replans (a sanity cap, not the real give-up condition). */
    private static final int MAX_REPLANS = 200;
    /** The real give-up condition: this many consecutive failed replans without real progress. */
    private static final int MAX_STALLED_REPLANS = 6;
    /**
     * Heuristic decrease that counts as real progress: roughly one block of advance on the goal's own
     * scale (traverse about 3.56 weighted, ascend about 3.16, descend about 3.89). Progress is measured by
     * the goal heuristic at the feet, not by Euclidean distance to center(): a yLevel goal's center is
     * (0, level, 0), so Euclidean distance would be swamped by meaningless horizontal offset.
     */
    private static final double REPLAN_PROGRESS_EPS_H = 4.0;
    /** Re-root when the goal center moves more than this squared distance (2 blocks). */
    private static final double GOAL_MOVED_SQR = 4.0;

    /**
     * <b>Replan cadence</b> (ticks) for live goals ({@link #trackGoal}).
     *
     * <p>Triggering only on {@code center()} displacement is not enough: for a danger-field goal,
     * {@code center()} is just the one mob the Bot is fighting, and <b>other mobs moving do not change
     * it</b>. Threat coordinates are snapshotted when the path is opened, so without a cadence the Bot
     * would avoid where mobs stood seconds ago: the field is right, the readings are stale.
     *
     * <p>Five ticks is about one block of mob movement, and a short-range A* is fast, so this cadence
     * keeps the receding horizon actually receding.
     */
    private static final int LIVE_GOAL_REPLAN_TICKS = 5;

    private final BotPlayer player;
    private final NavigationIntent intent;
    private final Supplier<BlockPos> blockGoalSupplier;
    private BlockPos currentBlockTarget;
    private GoalCompiler.Compiled capturedBlockGoal;
    private final BooleanSupplier reached;
    private final ContextProvider contextProvider;
    private final boolean revalidateGoalEachTick;
    /**
     * The speed parameter stays in the signature, but execution does not support variable speed (all
     * movement uses vanilla input physics), so it is routed to a sprint gate: speed &lt; 1.0 means slow,
     * and sprinting is disabled during every tick of this navigation (see the allowSprint wrapper in
     * {@link #tick}).
     */
    private final boolean sprintAllowed;

    /**
     * Segment-planning state machine: search dispatch, segment execution, seamless handoff and automatic
     * re-search on failure all live there.
     */
    private final PathingCore core;

    /** For tests that observe failure reports; production never calls this. */
    public PathingCore core() {
        return core;
    }

    /**
     * Sacred blocks of the most recently pulled goal (keyed by {@code BlockPos.asLong()}). Refreshed on
     * every goal pull: goal and sacred are one contract and must not be read separately.
     */
    private LongSet sacred = LongSets.emptySet();
    /**
     * Blocks the execution layer proved cannot be placed (e.g. NO_SUPPORT). Accumulated for this
     * navigation and passed into every later search, so deterministic re-searches do not keep planning
     * the same impossible scaffold.
     *
     * <p>Filled in the execution-failure branch of {@link #tick}: a placement failure surfaces as the
     * movement primitive reporting FAILED, the segment is cancelled for replanning, and the structured
     * failure and its target are read from the failed executor before {@code deniedPlace.add(...)}.
     */
    private final LongOpenHashSet deniedPlace = new LongOpenHashSet();

    /**
     * The search goal is satisfied underfoot but the caller's reached is not: hold ARRIVED stably so the
     * task layer can judge STANCE_DUD (change stance, blacklist that member), never decaying into a
     * misleading one-tick target lost. When the goal really moves, re-root and clear this as usual.
     */
    private boolean searchSatisfied;
    /** Goal center most recently sent to the state machine (baseline for re-root decisions). */
    private BlockPos plannedCenter;

    private int replans;
    private int ticksSincePlan;
    private int stalledReplans;
    /** Best (lowest) goal heuristic reached at the feet; the measure for stalled replans. */
    private double bestGoalH = Double.MAX_VALUE;
    private String failReason = "target unreachable";
    private FailureType failType = FailureType.NO_PATH;
    /** Cause of the latest execution failure (names the recurring failing movement in the give-up report). */
    private String lastExecFailure;
    /** Terminal latch: once FAILED is decided it stays (failReason is no longer overwritten). */
    private boolean failedTerminal;
    private boolean stopped;

    /** Most recent search context (input for the failure report, e.g. whether scaffold blocks exist). */
    private CalculationContext lastSearchContext;

    /**
     * Single-block goal compiled by intent (walkable block = stand on it; occupied block = arrive when
     * adjacent, without consuming the target).
     */
    public PlayerNav(BotPlayer player, BlockPos goal, double speed, BooleanSupplier reached) {
        this(player, () -> goal, speed, reached);
    }

    /**
     * Movable single-block goal: recompiled by intent on every pull (tightens to standing on it once the
     * block is cleared).
     */
    public PlayerNav(BotPlayer player, Supplier<BlockPos> goalSupplier, double speed,
                     BooleanSupplier reached) {
        this(player, speed, reached, NavigationIntent.fullTraversal(() -> null),
                false, contextFor(player), goalSupplier);
    }

    /** Compiled-contract entrance: goal, sacred and arrival inputs delivered together. */
    public static PlayerNav to(BotPlayer player, Supplier<GoalCompiler.Compiled> compiled,
                               double speed, BooleanSupplier reached) {
        return new PlayerNav(player, speed, reached, compiled);
    }

    /** Compiled-contract entrance with one immutable task-scoped mutation policy. */
    public static PlayerNav to(BotPlayer player, Supplier<GoalCompiler.Compiled> compiled,
                               double speed, BooleanSupplier reached,
                               RouteMutationPolicy routeMutations) {
        return new PlayerNav(player, speed, reached,
                new NavigationIntent(compiled, routeMutations), false, contextFor(player));
    }

    /** Compiled-contract entrance with task-specific search/execution cost contexts. */
    public static PlayerNav to(BotPlayer player, Supplier<GoalCompiler.Compiled> compiled,
                               double speed, BooleanSupplier reached,
                               ContextProvider contextProvider) {
        return new PlayerNav(player, speed, reached, compiled, false, contextProvider);
    }

    /** Compiled-contract entrance that rereads the goal and protected blocks every tick. */
    public static PlayerNav toRevalidating(BotPlayer player, Supplier<GoalCompiler.Compiled> compiled,
                                           double speed, BooleanSupplier reached,
                                           ContextProvider contextProvider) {
        return new PlayerNav(player, speed, reached, compiled, true, contextProvider);
    }

    /** Same as above, with the default search/execution contexts. */
    public static PlayerNav toRevalidating(BotPlayer player, Supplier<GoalCompiler.Compiled> compiled,
                                           double speed, BooleanSupplier reached) {
        return new PlayerNav(player, speed, reached, compiled, true);
    }

    /**
     * Bare custom goal (runAway, column, etc.). Carries no sacred set; intents with a block target
     * should use {@link #to} / {@link GoalCompiler} so the target is protected.
     */
    public static PlayerNav toGoal(BotPlayer player, Supplier<NavGoal> goalSupplier,
                                   double speed, BooleanSupplier reached) {
        return new PlayerNav(player, speed, reached, bare(goalSupplier));
    }

    /** Bare custom goal with one immutable task-scoped mutation policy. */
    public static PlayerNav toGoal(BotPlayer player, Supplier<NavGoal> goalSupplier,
                                   double speed, BooleanSupplier reached,
                                   RouteMutationPolicy routeMutations) {
        return new PlayerNav(player, speed, reached,
                new NavigationIntent(bare(goalSupplier), routeMutations),
                false, contextFor(player));
    }

    /**
     * Bare-goal navigation for a goal that <b>moves</b>. Two things: every tick, recheck whether the
     * Bot is still in the goal and keep walking if it left; every {@link #LIVE_GOAL_REPLAN_TICKS} ticks,
     * re-pull the goal so the threat snapshot keeps up.
     *
     * <p>{@link #toGoal} returns {@code ARRIVED} forever once the search is satisfied and stops driving
     * movement. That is right for fixed coordinates but freezes the Bot when keeping position relative
     * to a mob. Chasing and close-range positioning both need this variant.
     */
    public static PlayerNav trackGoal(BotPlayer player, Supplier<NavGoal> goalSupplier,
                                      double speed, BooleanSupplier reached) {
        return new PlayerNav(player, speed, reached, bare(goalSupplier), true);
    }

    /**
     * Wraps a bare goal into a compiled contract with no sacred set (engineGoal is derived through the
     * vocabulary mapping).
     */
    private static Supplier<GoalCompiler.Compiled> bare(Supplier<NavGoal> goals) {
        return () -> {
            NavGoal g = goals.get();
            return g == null ? null
                    : new GoalCompiler.Compiled(g, LongSets.emptySet());
        };
    }

    private PlayerNav(BotPlayer player, double speed, BooleanSupplier reached,
                      Supplier<GoalCompiler.Compiled> compiledSupplier) {
        this(player, speed, reached, NavigationIntent.fullTraversal(compiledSupplier),
                false, contextFor(player));
    }

    private PlayerNav(BotPlayer player, double speed, BooleanSupplier reached,
                      Supplier<GoalCompiler.Compiled> compiledSupplier,
                      boolean revalidateGoalEachTick) {
        this(player, speed, reached, NavigationIntent.fullTraversal(compiledSupplier),
                revalidateGoalEachTick, contextFor(player));
    }

    private static ContextProvider contextFor(BotPlayer player) {
        return new dev.mcagent.runtime.core.pathing.bridge.WorldKnowledgeContextProvider();
    }

    private PlayerNav(BotPlayer player, double speed, BooleanSupplier reached,
                      Supplier<GoalCompiler.Compiled> compiledSupplier,
                      boolean revalidateGoalEachTick, ContextProvider contextProvider) {
        this(player, speed, reached, NavigationIntent.fullTraversal(compiledSupplier),
                revalidateGoalEachTick, contextProvider);
    }

    private PlayerNav(BotPlayer player, double speed, BooleanSupplier reached,
                      NavigationIntent intent,
                      boolean revalidateGoalEachTick, ContextProvider contextProvider) {
        this(player, speed, reached, intent, revalidateGoalEachTick, contextProvider, null);
    }

    private PlayerNav(BotPlayer player, double speed, BooleanSupplier reached,
                      NavigationIntent intent,
                      boolean revalidateGoalEachTick, ContextProvider contextProvider,
                      Supplier<BlockPos> blockGoalSupplier) {
        this.player = player;
        this.intent = intent;
        this.blockGoalSupplier = blockGoalSupplier;
        this.sprintAllowed = speed >= 1.0;
        this.reached = reached;
        this.contextProvider = java.util.Objects.requireNonNull(contextProvider, "contextProvider");
        this.revalidateGoalEachTick = revalidateGoalEachTick;
        this.core = new PathingCore(player, PoolSearchDispatcher.INSTANCE,
                this::searchPlan, this::executionContext);
    }

    private PathingCore.SearchPlan searchPlan(Goal fallbackGoal) {
        if (blockGoalSupplier == null || currentBlockTarget == null) {
            return new PathingCore.SearchPlan(fallbackGoal, searchContext());
        }
        ContextProvider.BlockSearchPlan plan = contextProvider.planBlockSearch(
                player, currentBlockTarget, deniedPlace, intent.routeMutations());
        capturedBlockGoal = plan.compiled();
        sacred = capturedBlockGoal.sacred();
        return new PathingCore.SearchPlan(capturedBlockGoal.engineGoal(), plan.context());
    }

    /**
     * Frozen search context: snapshot world plus snapshot inventory, with the semantic switches passed
     * through.
     */
    private CalculationContext searchContext() {
        CalculationContext ctx = contextProvider.forSearch(
                player, sacred, deniedPlace, intent.routeMutations());
        lastSearchContext = ctx;
        return ctx;
    }

    /** Execution-recheck context: fresh knowledge snapshot plus current inventory, same semantic switches. */
    private CalculationContext executionContext() {
        return contextProvider.forExecution(
                player, sacred, deniedPlace, intent.routeMutations());
    }

    public interface ContextProvider {
        default BlockSearchPlan planBlockSearch(
                BotPlayer player, BlockPos target, LongSet deniedPlace,
                RouteMutationPolicy routeMutations) {
            return new dev.mcagent.runtime.core.pathing.bridge.WorldKnowledgeContextProvider()
                    .planBlockSearch(player, target, deniedPlace, routeMutations);
        }

        record BlockSearchPlan(GoalCompiler.Compiled compiled, CalculationContext context) {}

        CalculationContext forSearch(BotPlayer player, LongSet sacred, LongSet deniedPlace,
                                     RouteMutationPolicy routeMutations);
        CalculationContext forExecution(BotPlayer player, LongSet sacred, LongSet deniedPlace,
                                        RouteMutationPolicy routeMutations);
    }

    /** Whether ARRIVED-IN-PLACE was already logged (edge-triggered dedup). */
    private boolean arrivedInPlaceLogged;

    public Status tick() {
        NavProfiler.tickFrame();
        if (reached.getAsBoolean()) {
            return Status.ARRIVED;
        }
        if (failedTerminal) {
            return Status.FAILED;
        }
        if (stopped) {
            failReason = "target lost";
            failType = FailureType.TARGET_LOST;
            return Status.FAILED;
        }

        // Pull goal and sacred together: they are one contract
        long tCompile = NavProfiler.begin();
        GoalCompiler.Compiled compiled;
        if (blockGoalSupplier == null) {
            compiled = intent.compiled().get();
        } else {
            BlockPos target = blockGoalSupplier.get();
            if (target == null) {
                compiled = null;
            } else {
                currentBlockTarget = target.immutable();
                compiled = capturedBlockGoal != null
                                && capturedBlockGoal.goal().center().equals(currentBlockTarget)
                        ? capturedBlockGoal
                        : GoalCompiler.blockKnowledge(false, false, currentBlockTarget);
            }
        }
        NavProfiler.end("goal.compile", tCompile);
        if (compiled == null) {
            return fail(FailureType.TARGET_LOST, "target lost");
        }
        sacred = compiled.sacred();
        NavGoal navGoal = compiled.goal();

        // Goal center moved more than 2 blocks: re-root (the progress measure resets; the state machine
        // soft-cancels the old segment itself)
        if (plannedCenter != null && navGoal.center().distSqr(plannedCenter) > GOAL_MOVED_SQR) {
            searchSatisfied = false;
            bestGoalH = Double.MAX_VALUE;
            ticksSincePlan = 0;
            plannedCenter = navGoal.center();
            withSprintGate(() -> core.setGoalAndPath(compiled.engineGoal()));
            return Status.RUNNING;
        }
        // Live goal: re-pull on cadence. The progress measure is not reset; it detects being stuck and must
        // not be cleared by the cadence.
        if (revalidateGoalEachTick && ++ticksSincePlan >= LIVE_GOAL_REPLAN_TICKS) {
            ticksSincePlan = 0;
            searchSatisfied = false;
            plannedCenter = navGoal.center();
            withSprintGate(() -> core.setGoalAndPath(compiled.engineGoal()));
            return Status.RUNNING;
        }
        if (plannedCenter == null) {
            plannedCenter = navGoal.center();
        }

        if (searchSatisfied) {
            if (!revalidateGoalEachTick) {
                return Status.ARRIVED;
            }
            BlockPos feet = PathExecutor.playerFeet(player);
            if (compiled.engineGoal().isInGoal(feet.getX(), feet.getY(), feet.getZ())) {
                return Status.ARRIVED;
            }
            searchSatisfied = false;
        }

        PathExecutor before = core.getCurrent();
        long tExec = NavProfiler.begin();
        withSprintGate(() -> {
            // (Re)send the goal when the state machine is idle (first time, or a result was discarded as
            // an orphan); setGoalAndPath does not dispatch when already in the goal or when a segment or
            // in-flight search exists
            if (revalidateGoalEachTick || core.getGoal() == null
                    || (core.getCurrent() == null && !core.hasInProgressSearch())) {
                core.setGoalAndPath(compiled.engineGoal());
            }
            core.tick();
        });
        NavProfiler.end("core.tick", tExec);

        // First-segment search failed: build the failure report and terminate. Check the caller's
        // predicate once more first: the body may have moved into a satisfying position this tick, and
        // ARRIVED takes precedence over failure
        if (core.calcFailedLastTick()) {
            Status verdict = fail(FailureType.NO_PATH, noPathAutopsy(navGoal));
            return reached.getAsBoolean() ? Status.ARRIVED : verdict;
        }

        // Execution failure (segment cancelled, state machine already re-searching): give-up bookkeeping
        PathExecutor after = core.getCurrent();
        if (before != null && after != before && before.failed()) {
            lastExecFailure = before.failureCause();
            // deniedPlace producer: blocks proven unplaceable go into this navigation's deny set, so
            // deterministic re-searches do not keep planning the same impossible scaffold. Only placement
            // targets are recorded: break/open failures have no equivalent spatial meaning. The field
            // dies with this navigation, so dynamic obstructions are never recorded as permanently
            // unreachable.
            PhysicalVerificationAuthority.Failure movementFailure = before.movementFailure();
            if (movementFailure != null && before.failedPlaceTarget() != null
                    && isDeniedPlacement(movementFailure)) {
                deniedPlace.add(before.failedPlaceTarget().asLong());
            }
            Status verdict = accountReplan(navGoal);
            if (verdict != null) {
                return verdict;
            }
        }

        // Arrival: the state machine is idle and the feet satisfy the search goal → stable ARRIVED.
        // Covers two cases: the path finished inside the goal, and already satisfied in place
        // (setGoalAndPath never dispatched because the feet were already in the goal).
        Goal engineGoal = core.getGoal();
        if (engineGoal != null && core.getCurrent() == null && !core.hasInProgressSearch()) {
            BlockPos feet = PathExecutor.playerFeet(player);
            if (engineGoal.isInGoal(feet.getX(), feet.getY(), feet.getZ())) {
                searchSatisfied = true;
                if (!arrivedInPlaceLogged) {
                    // Log once on the entering edge only: when the task layer keeps rebuilding the
                    // navigation, the same stay re-enters this branch every tick and would flood the log
                    arrivedInPlaceLogged = true;
                    Constants.LOG.info(
                            "[mc_agent-path] ARRIVED-IN-PLACE feet={} goal-center={} -- search goal is already satisfied at"
                                    + " the feet, pinning the verdict for the task layer to decide",
                            feet.toShortString(), plannedCenter.toShortString());
                }
                return Status.ARRIVED;
            }
        }
        return Status.RUNNING;
    }

    /**
     * Where the speed parameter takes effect: every drive step of this navigation is wrapped in the
     * allowSprint gate, and slow (speed &lt; 1.0) disables sprinting globally. The search context's
     * canSprint snapshot and the executor's per-tick sprint decision both read this one switch; the
     * original value is restored afterward, so other Bots are unaffected.
     */
    private void withSprintGate(Runnable body) {
        NavSettings settings = NavSettings.get();
        boolean saved = settings.allowSprint;
        settings.allowSprint = saved && sprintAllowed;
        try {
            body.run();
        } finally {
            settings.allowSprint = saved;
        }
    }

    /**
     * Whether the failure proves the placement target unusable (a permanent spatial verdict, not
     * transient).
     */
    private static boolean isDeniedPlacement(PhysicalVerificationAuthority.Failure failure) {
        return switch (failure.code()) {
            case NO_SUPPORT, ITEM_NOT_FOUND,
                    UNSUPPORTED_SHAPE, OCCUPIED, OBSTRUCTED, UNSAFE -> true;
            default -> false;
        };
    }

    /**
     * Bookkeeping for one failed replan. Progress is the goal's own heuristic evaluated at the feet
     * (yLevel looks only at height, column only horizontally, composite at the nearest member, runAway
     * goes more negative while fleeing; each is naturally correct). Real improvement resets the streak;
     * otherwise a streak of {@link #MAX_STALLED_REPLANS} yields BOXED_IN. Returns null to keep running.
     */
    private Status accountReplan(NavGoal liveGoal) {
        BlockPos feet = PathExecutor.playerFeet(player);
        double h = liveGoal.progressHeuristic(feet);
        if (bestGoalH - h >= REPLAN_PROGRESS_EPS_H) {
            bestGoalH = h;
            stalledReplans = 0;
        } else if (++stalledReplans >= MAX_STALLED_REPLANS) {
            Status verdict = fail(FailureType.BOXED_IN,
                    "gave up: no real progress toward the target over "
                            + MAX_STALLED_REPLANS + " consecutive attempts"
                            + (lastExecFailure != null
                                    ? "; the recurring failure: " + lastExecFailure : ""));
            return reached.getAsBoolean() ? Status.ARRIVED : verdict;
        }
        if (replans++ >= MAX_REPLANS) {
            Status verdict = fail(FailureType.BOXED_IN,
                    "gave up after " + MAX_REPLANS + " replans");
            return reached.getAsBoolean() ? Status.ARRIVED : verdict;
        }
        return null;
    }

    /** Terminal verdict: stops the body and pins the reason; later ticks keep returning FAILED. */
    private Status fail(FailureType type, String reason) {
        failReason = reason;
        failType = type;
        failedTerminal = true;
        core.forceCancel();
        return Status.FAILED;
    }

    /**
     * Explanatory failure report for an empty search result, in plain language passed directly to the
     * model: distance to the target, whether scaffold blocks are carried, and what could unlock a route.
     * Search statistics are not exposed through the async handle, so this builds a structured verdict
     * from the information available.
     */
    private String noPathAutopsy(NavGoal goal) {
        BlockPos feet = PathExecutor.playerFeet(player);
        BlockPos center = goal.center();
        double dist = Math.sqrt(feet.distSqr(center));
        StringBuilder r = new StringBuilder("no path to target");
        r.append(String.format(" (from %s toward %s, about %.0f blocks away;"
                        + " the search burned its whole budget without finding a route",
                feet.toShortString(), center.toShortString(), dist));
        if (lastSearchContext != null && !lastSearchContext.hasThrowaway) {
            r.append("; carrying no scaffolding blocks to bridge or pillar with");
        }
        if (!deniedPlace.isEmpty()) {
            r.append("; ").append(deniedPlace.size())
                    .append(" scaffold spot(s) already proven unplaceable this navigation");
        }
        r.append(')');
        String reason = r.toString();
        Constants.LOG.info("[mc_agent-path] NO-PATH start={} goal={} | {}",
                feet.toShortString(), center.toShortString(), reason);
        return reason;
    }

    public boolean isSafeToCancel() {
        return core.isSafeToCancel();
    }

    public BlockPos pathStart() {
        return core.pathStart();
    }

    /** Plain-language failure report after FAILED (passed directly to the LLM). */
    public String failReason() {
        return failReason;
    }

    /** Structured cause of FAILED; the task layer's recovery ladder branches on the enum. */
    public FailureType failType() {
        return failType;
    }

    /**
     * Ticks since the last real progress (movement completed, relocation, active digging): the liveness
     * signal for progress-lease task deadlines. Reads 0 between plans (no executing segment): a search
     * within budget is itself progress, just not walking.
     */
    public int stallTicks() {
        PathExecutor current = core.getCurrent();
        return current == null ? 0 : current.ticksSinceProgress();
    }

    /** Search-outcome distribution summary, forwarded from the core (for diagnostic logs). */
    public String outcomeSummary() {
        return core.outcomeSummary();
    }

    /**
     * The planner is in flight and no segment is executing: the body is standing still waiting for the
     * async search. The task layer uses this to freeze the task deadline. Deadlines measure ticks of
     * body work, and wall-clock search latency must not count as task timeout (the faster ticks run
     * relative to real time, the worse the distortion; on a server with uncapped tick rate it can burn
     * the whole budget before the first search returns).
     */
    public boolean planningInFlight() {
        return core.hasInProgressSearch() && core.getCurrent() == null;
    }

    /**
     * Stops navigation: cancels the in-flight search, drops segments, clears keys, stops digging, halts
     * the body and releases sneak.
     */
    public void stop() {
        stopped = true;
        searchSatisfied = false;
        try {
            core.forceCancel();
        } finally {
            InputDriver.halt(player);
            // Locomotion must settle even if cancellation cleanup throws.
            player.setShiftKeyDown(false);
        }
    }

    /**
     * Stands still for this tick: clears movement input and releases sneak, but keeps the goal, the
     * current segment and the in-flight search, so the next {@link #tick()} resumes from the current
     * state without a cold-start search. Call it every tick during in-place work that needs the body
     * still (e.g. stationary digging); it is not a substitute for {@link #stop()} (terminal release).
     */
    public void pause() {
        InputDriver.halt(player);
        player.setShiftKeyDown(false);
    }
}
