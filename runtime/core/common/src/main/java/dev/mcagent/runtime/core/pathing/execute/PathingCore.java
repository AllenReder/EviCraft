package dev.mcagent.runtime.core.pathing.execute;

import java.util.Optional;
import java.util.function.Function;
import java.util.function.Supplier;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.pathing.astar.Favoring;
import dev.mcagent.runtime.core.pathing.astar.NavPath;
import dev.mcagent.runtime.core.pathing.astar.PathCalcResult;
import dev.mcagent.runtime.core.pathing.bridge.SearchDispatcher;
import dev.mcagent.runtime.core.pathing.bridge.SearchHandle;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.ChunkLoadedTest;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.entity.BotPlayer;

import net.minecraft.core.BlockPos;

/**
 * Segment-planning state machine: goal → first-segment search → execute → plan the next segment
 * ahead → seamless handoff, until the goal is reached or navigation is cancelled. Holds three slots,
 * current (segment being executed), next (computed next segment) and inProgress (in-flight search),
 * plus the cost context for this navigation.
 *
 * <p>One {@link #tick()} per tick: first record the fake start (expectedSegmentStart), then handle
 * pause/cancel requests, in-flight search validity, current-segment advance, segment-end routing, early
 * handoff and splicing, and plan-ahead triggering; finally commit this tick's input/view records to the
 * entity.
 *
 * <p>Instantiable on its own: construction needs only the player, a search dispatcher and cost-context
 * factories, with no task layer attached.
 */
public final class PathingCore {

    private final BotPlayer player;
    private final ExecHarness harness;

    /** For tests that observe failure reports; production never calls this. */
    public ExecHarness harness() {
        return harness;
    }
    private final SearchDispatcher dispatcher;
    /**
     * Search cost-context factory: samples a frozen snapshot on every dispatch (refreshing inventory,
     * enchantments and semantic switches), so the whole search uses one consistent measure.
     */
    private final Function<Goal, SearchPlan> searchPlanFactory;
    /**
     * Execution cost-context factory: a live world view, sampled when the executor rechecks costs each
     * tick. Uses the same cost functions as the search side, but reads the current world.
     */
    private final Supplier<CalculationContext> executionContextFactory;

    private PathExecutor current;
    private PathExecutor next;
    /**
     * Consecutive orphan first segments tolerated; beyond this the first segment counts as failed and
     * the upper layer decides.
     */
    private static final int MAX_ORPHAN_DISCARDS = 3;
    private int orphanDiscards;
    /**
     * Consecutive adopted segments tolerated that produced no movement and no displacement; beyond this
     * the first segment counts as failed.
     */
    private static final int MAX_STERILE_SEGMENTS = 4;
    private int sterileSegments;
    private int dispatches;
    private final java.util.TreeMap<String, Integer> outcomes = new java.util.TreeMap<>();

    private SearchHandle inProgress;
    /** A* expansion start of the in-flight search (the handle does not carry it; recorded on submit). */
    private BlockPos inProgressStart;
    private Goal goal;
    private CalculationContext context;
    private BlockPos expectedSegmentStart;

    /** Return value of the last current.onTick() (safe to interrupt). */
    private boolean safeToCancel = true;
    private boolean cancelRequested;
    private boolean calcFailedLastTick;
    private long speculativeReplanGameTime;
    /**
     * A segment cut at UNKNOWN terrain would otherwise redispatch against the identical observation
     * snapshot every tick, repeating large snapshot work on the server thread. Five ticks matches the
     * live-goal replan cadence: it bounds the evidence wait without changing costs, movement execution,
     * or the ordinary path flow.
     */
    private static final int SPECULATIVE_REPLAN_TICKS = 5;

    public PathingCore(BotPlayer player, SearchDispatcher dispatcher,
                       Supplier<CalculationContext> searchContextFactory,
                       Supplier<CalculationContext> executionContextFactory) {
        this(player, dispatcher,
                goal -> new SearchPlan(goal, searchContextFactory.get()),
                executionContextFactory);
    }

    public PathingCore(BotPlayer player, SearchDispatcher dispatcher,
                       Function<Goal, SearchPlan> searchPlanFactory,
                       Supplier<CalculationContext> executionContextFactory) {
        this.player = player;
        this.harness = new ExecHarness(player, executionContextFactory);
        this.dispatcher = dispatcher;
        this.searchPlanFactory = searchPlanFactory;
        this.executionContextFactory = executionContextFactory;
    }

    public record SearchPlan(Goal goal, CalculationContext context) {
        public SearchPlan {
            java.util.Objects.requireNonNull(goal, "goal");
            java.util.Objects.requireNonNull(context, "context");
        }
    }

    /**
     * Convenience constructor where search and execution share one snapshot: execution-time rechecks
     * read the search's context directly. <b>Note</b>: execution-time cost rechecks therefore cannot see
     * world changes (the snapshot is frozen). Production must use the two-factory constructor (the
     * execution side captures a fresh knowledge snapshot); this one is for tests only.
     */
    public PathingCore(BotPlayer player, SearchDispatcher dispatcher,
                       Supplier<CalculationContext> contextFactory) {
        this(player, dispatcher, contextFactory, null);
    }

    // ==================== Public API ====================

    /**
     * Sets the goal and starts pathing. Goal invalidation: if the current segment's destination was in
     * the old goal but is not in the new one, the old segment is discarded (soft cancel, keys kept, the
     * next tick replans seamlessly). No new search starts when already in the goal or when a segment or
     * in-flight search already exists.
     *
     * @return whether a new search was actually started
     */
    public boolean setGoalAndPath(Goal newGoal) {
        if (NavSettings.get().cancelOnGoalInvalidation && goalInvalidatedBy(newGoal)) {
            Constants.LOG.debug("Current segment end no longer accepted by the new goal, soft cancel");
            softCancelIfSafe();
        }
        this.goal = newGoal;
        if (goal == null) {
            return false;
        }
        BlockPos feet = PathExecutor.playerFeet(player);
        if (goal.isInGoal(feet.getX(), feet.getY(), feet.getZ())) {
            return false;
        }
        if (current != null || inProgress != null) {
            return false;
        }
        expectedSegmentStart = pathStart();
        startSearch(expectedSegmentStart);
        return true;
    }

    /** Goal invalidation: the current segment's destination was in the old goal but is not in the new one. */
    private boolean goalInvalidatedBy(Goal newGoal) {
        if (current == null || goal == null || newGoal == null) {
            return false;
        }
        BlockPos dest = current.getPath().getDest();
        return goal.isInGoal(dest.getX(), dest.getY(), dest.getZ())
                && !newGoal.isInGoal(dest.getX(), dest.getY(), dest.getZ());
    }

    /**
     * Soft cancel: cancels the in-flight search and drops the segments but keeps keys, so the body keeps
     * its momentum and the next tick's replan takes over seamlessly. When unsafe, only the in-flight
     * search is cancelled.
     */
    public void softCancelIfSafe() {
        if (inProgress != null) {
            inProgress.cancel();
        }
        if (!isSafeToCancel()) {
            return;
        }
        current = null;
        next = null;
        cancelRequested = true;
    }

    /** Whether the Bot is currently following a path. */
    public boolean isPathing() {
        return current != null;
    }

    /** Whether it is currently safe to interrupt (false e.g. while placing over a gap or mid-parkour). */
    public boolean isSafeToCancel() {
        return current == null || safeToCancel;
    }

    /** Whether a first-segment computation failed in the last tick. */
    public boolean calcFailedLastTick() {
        return calcFailedLastTick;
    }

    public Goal getGoal() {
        return goal;
    }

    public PathExecutor getCurrent() {
        return current;
    }

    public PathExecutor getNext() {
        return next;
    }

    public boolean hasInProgressSearch() {
        return inProgress != null;
    }

    /**
     * Distribution of search outcomes so far (diagnostics: distinguishes "no path found" from "only a
     * partial path found").
     */
    public String outcomeSummary() {
        return dispatches + " dispatched/" + outcomes
                + " segment[" + (current == null ? "none" : current.progressSummary()) + "]";
    }

    /**
     * Current best partial path of the in-flight search; empty when no search is running or no candidate
     * exists yet.
     */
    public Optional<NavPath> inProgressBestPath() {
        return inProgress == null ? Optional.empty() : inProgress.bestPathSoFar();
    }

    public BotPlayer player() {
        return player;
    }

    // ==================== Live instance registry ====================

    /** Most recently ticked core per Bot (read by side consumers such as debug visualization). */
    private static final java.util.concurrent.ConcurrentHashMap<java.util.UUID, PathingCore> LIVE =
            new java.util.concurrent.ConcurrentHashMap<>();

    /** Most recently active core of each Bot (entries for removed entities are pruned on access). */
    public static java.util.Collection<PathingCore> liveCores() {
        LIVE.values().removeIf(core -> core.player.isRemoved());
        return LIVE.values();
    }

    // ==================== Per tick ====================

    /**
     * Advances one tick. Records the fake start before executing (execution moves the Bot, and the
     * search start must be the pre-execution one); at the end commits input/view and applies the sprint
     * decision.
     */
    public void tick() {
        LIVE.put(player.getUUID(), this);
        expectedSegmentStart = pathStart();
        calcFailedLastTick = false;
        tickPath();
        harness.commitIfDirty();
        if (current != null) {
            player.setSprinting(current.isSprinting());
        }
    }

    private void tickPath() {
        pollSearchResult();
        if (cancelRequested) {
            cancelRequested = false;
            harness.clearAllKeys();
        }
        // In-flight search validity: if its start is neither the current segment's destination nor the
        // feet/fake start, and its best partial path contains neither, the player was knocked away or
        // teleported and the computation is void
        if (inProgress != null) {
            BlockPos calcFrom = inProgressStart;
            BlockPos feet = PathExecutor.playerFeet(player);
            Optional<NavPath> currentBest = inProgress.bestPathSoFar();
            if ((current == null || !current.getPath().getDest().equals(calcFrom))
                    && !calcFrom.equals(feet) && !calcFrom.equals(expectedSegmentStart)
                    && (currentBest.isEmpty()
                            || (!currentBest.get().positions().contains(feet)
                                && !currentBest.get().positions().contains(expectedSegmentStart)))) {
                Constants.LOG.debug("In-flight search start is stale, cancelling that calculation");
                inProgress.cancel();
            }
        }
        if (current == null) {
            return;
        }
        BlockPos feetBefore = PathExecutor.playerFeet(player);
        safeToCancel = current.onTick();
        if (current.failed() || current.finished()) {
            noteSegmentEnd(current, feetBefore);
            if (current.getPath().speculativeFrontier()) {
                speculativeReplanGameTime = player.level().getGameTime()
                        + SPECULATIVE_REPLAN_TICKS;
            }
            current = null;
            BlockPos feet = PathExecutor.playerFeet(player);
            if (goal == null || goal.isInGoal(feet.getX(), feet.getY(), feet.getZ())) {
                Constants.LOG.debug("Reached the goal");
                next = null;
                sterileSegments = 0;
                return;
            }
            if (next != null && !next.getPath().positions().contains(feet)
                    && !next.getPath().positions().contains(expectedSegmentStart)) {
                // The segment failed midway and the Bot is no longer on the planned next segment; drop it
                Constants.LOG.debug("Next segment does not contain the current position, discarding");
                next = null;
            }
            if (next != null) {
                Constants.LOG.debug("Seamlessly switched to the planned next segment");
                current = next;
                next = null;
                current.onTick(); // do not waste this tick; advance immediately
                return;
            }
            if (inProgress != null) {
                return; // segment just ended; wait for the in-flight computation
            }
            startSearch(expectedSegmentStart);
            return;
        }
        // Current segment in progress: switch early if the Bot is exactly on a position of the next segment
        if (safeToCancel && next != null && next.snipsnapifpossible()) {
            Constants.LOG.debug("Switching to the next segment early");
            current = next;
            next = null;
            current.onTick();
            return;
        }
        if (NavSettings.get().splicePath) {
            current = current.trySplice(next);
        }
        if (next != null && current.getPath().getDest().equals(next.getPath().getDest())) {
            next = null;
        }
        if (inProgress != null) {
            return;
        }
        if (next != null) {
            return;
        }
        BlockPos dest = current.getPath().getDest();
        if (goal == null || goal.isInGoal(dest.getX(), dest.getY(), dest.getZ())) {
            return; // the current segment already reaches the goal
        }
        // Remaining cost excludes the current movement: a very long final movement should not block planning
        // ahead
        double ticksRemaining = current.getPath().ticksRemainingFrom(current.getPosition() + 1);
        if (ticksRemaining < NavSettings.get().planningTickLookahead) {
            Constants.LOG.debug("About {} ticks left in the current segment, planning the follow-up segment early", (int) ticksRemaining);
            startSearch(current.getPath().getDest());
        }
    }

    // ==================== Search dispatch and collection ====================

    private void startSearch(BlockPos start) {
        if (inProgress != null) {
            throw new IllegalStateException("A search is already in flight");
        }
        if (goal == null) {
            return;
        }
        if (current == null && player.level().getGameTime() < speculativeReplanGameTime) {
            return;
        }
        // Resample the frozen snapshot on every dispatch: inventory, tools, hunger and semantic switches
        // (sacred/deniedPlace) are taken as of the dispatch moment
        SearchPlan plan = searchPlanFactory.apply(goal);
        goal = plan.goal();
        context = plan.context();
        BlockPos feetAtCapture = PathExecutor.playerFeet(player);
        if (goal.isInGoal(feetAtCapture.getX(), feetAtCapture.getY(), feetAtCapture.getZ())) {
            return;
        }
        long primaryTimeout;
        long failureTimeout;
        NavSettings settings = NavSettings.get();
        if (current == null) {
            primaryTimeout = settings.primaryTimeoutMS;
            failureTimeout = settings.failureTimeoutMS;
        } else {
            primaryTimeout = settings.planAheadPrimaryTimeoutMS;
            failureTimeout = settings.planAheadFailureTimeoutMS;
        }
        // The goal decides what to avoid: combat goals carry their own threat table (position plus each
        // threat's danger radius); other navigation uses the global switch (off by default).
        Favoring favoring = new Favoring(current == null ? null : current.getPath(), context,
                dev.mcagent.runtime.core.pathing.astar.Avoidance.forGoal(goal, player, context));
        // When the real feet position is on the same level as the expansion start and within 1 on X and Z,
        // use the feet position as realStart (input for the fake start)
        BlockPos feet = PathExecutor.playerFeet(player);
        BlockPos realStart = start;
        if (feet.getY() == start.getY()
                && Math.abs(feet.getX() - start.getX()) <= 1
                && Math.abs(feet.getZ() - start.getZ()) <= 1) {
            realStart = feet;
        }
        inProgressStart = start;
        dispatches++;
        inProgress = dispatcher.submit(realStart, start, goal, context, favoring,
                primaryTimeout, failureTimeout);
    }

    /**
     * Sterile-segment bookkeeping. A failed segment that dies the moment it is adopted, with the Bot not
     * moving a single block, means the planner produces a path the executor rejects. An UNKNOWN boundary
     * produces an equivalent idle loop: post-processing keeps only the start, yielding a speculative
     * segment with zero movements; the executor completes it normally but the body does not move either.
     * In both cases the replanning input is unchanged, so the same result repeats.
     *
     * <p>This loop happens entirely inside {@code core.tick()}: the segment is born and dies within the
     * same call, so the outer layer always sees "no segment", and PlayerNav's execution-failure
     * bookkeeping ("had a segment last tick, none now") never fires, giving a silent livelock. After
     * enough consecutive sterile segments, report a first-segment failure so the upper layer can skip
     * the cell. Same principle as orphan segments: every outcome must converge to a verdict.
     */
    private void noteSegmentEnd(PathExecutor segment, BlockPos feetBefore) {
        boolean noDisplacement = PathExecutor.playerFeet(player).equals(feetBefore);
        boolean emptySpeculativeFinish = segment.finished()
                && segment.getPath().speculativeFrontier()
                && segment.getPath().movements().isEmpty();
        if (!noDisplacement || (!segment.failed() && !emptySpeculativeFinish)) {
            sterileSegments = 0;
            return;
        }
        if (++sterileSegments < MAX_STERILE_SEGMENTS) {
            return;
        }
        Constants.LOG.info(
                "[mc_agent-path] {} consecutive segments produced no movement and the position did not change (segment length {}, cause {}), "
                        + "treating as first-segment failure: repeated planning made no progress",
                sterileSegments, segment.getPath().length(),
                emptySpeculativeFinish ? "zero-movement speculative frontier" : segment.failureCause());
        sterileSegments = 0;
        calcFailedLastTick = true;
    }

    /**
     * Counts search outcomes by kind and periodically logs them at INFO. This table locates redispatch
     * livelocks: how many dispatches, how many of each outcome, and which branch is consuming ticks. The
     * per-branch logs are debug level and are not persisted in release builds.
     */
    private void countOutcome(String kind) {
        outcomes.merge(kind, 1, Integer::sum);
        if (dispatches % 128 != 0) {
            return;
        }
        Constants.LOG.info("[mc_agent-path-outcome] dispatched {} outcomes {} goal={} pos={} segment={}",
                dispatches, outcomes, goal,
                PathExecutor.playerFeet(player).toShortString(),
                current == null ? "none" : current.getPath().length());
    }

    /**
     * Collects the in-flight search: a first segment must contain the fake start (otherwise it is an
     * orphan), and a follow-up segment must start where the current one ends.
     */
    private void pollSearchResult() {
        if (inProgress == null) {
            return;
        }
        PathCalcResult result = inProgress.poll();
        if (result == null) {
            return;
        }
        inProgress = null;
        inProgressStart = null;
        Optional<PathExecutor> executor = result.getPath().map(this::newExecutor);
        if (current == null) {
            if (executor.isPresent()) {
                if (executor.get().getPath().positions().contains(expectedSegmentStart)) {
                    orphanDiscards = 0;
                    current = executor.get();
                    if (!current.getPath().speculativeFrontier()) {
                        speculativeReplanGameTime = 0;
                    }
                    countOutcome("first segment accepted:" + result.getType() + "x"
                            + executor.get().getPath().length());
                } else {
                    countOutcome("orphan segment");
                    // Orphan segments must be counted: discarding yields neither a walkable segment nor a
                    // verdict, and the upper layer redispatches whenever there is no segment and no
                    // in-flight search. Silent discards become a redispatch livelock of hundreds per
                    // second, the body never moves, and the task layer never gets a failure. Enough
                    // consecutive discards mean no walkable path exists from this start, so report a
                    // first-segment failure and let the upper layer skip the cell.
                    if (++orphanDiscards >= MAX_ORPHAN_DISCARDS) {
                        Constants.LOG.info(
                                "[mc_agent-path] {} consecutive orphan segments: start {} not on the result path"
                                        + " (path start {}, length {}), treating as first-segment failure",
                                orphanDiscards, expectedSegmentStart,
                                executor.get().getPath().getSrc(),
                                executor.get().getPath().length());
                        orphanDiscards = 0;
                        calcFailedLastTick = true;
                    } else {
                        Constants.LOG.debug("Discarding orphan path segment with mismatched start");
                    }
                }
            } else {
                countOutcome("no path:" + result.getType());
                if (result.getType() != PathCalcResult.Type.CANCELLATION
                        && result.getType() != PathCalcResult.Type.EXCEPTION) {
                    Constants.LOG.debug("First segment calculation failed");
                    orphanDiscards = 0;
                    calcFailedLastTick = true;
                }
            }
        } else {
            if (next == null) {
                if (executor.isPresent()) {
                    if (executor.get().getPath().getSrc().equals(current.getPath().getDest())) {
                        next = executor.get();
                        countOutcome("follow-up accepted:" + result.getType());
                    } else {
                        countOutcome("follow-up disconnected");
                        Constants.LOG.debug("Discarding follow-up segment whose start does not meet the current segment end");
                    }
                } else {
                    countOutcome("follow-up no path");
                    Constants.LOG.debug("Follow-up segment calculation failed");
                }
            } else {
                Constants.LOG.warn("Next segment already exists when the result arrived, discarding the result");
            }
        }
    }

    private PathExecutor newExecutor(NavPath path) {
        Supplier<CalculationContext> recost =
                executionContextFactory != null ? executionContextFactory : () -> context;
        // The chunk-boundary pause queries the live world (in memory only, never triggers loading), so
        // the pause lifts as soon as a late chunk finishes generating instead of being pinned by the
        // search-time frozen snapshot
        var liveView = dev.mcagent.runtime.core.pathing.cache.LoadedOnlyView.of(player.level());
        ChunkLoadedTest liveLoaded =
                liveView instanceof dev.mcagent.runtime.core.pathing.cache.LoadedOnlyView v
                        ? v::isLoaded : context.loadedTest;
        return new PathExecutor(path, player, harness,
                recost,
                () -> inProgress == null ? Optional.empty() : inProgress.bestPathSoFar(),
                liveLoaded);
    }

    // ==================== Fake start ====================

    /**
     * Search start for a new segment (a fake start when the block underfoot cannot be stood on). Same
     * semantics as Movement.pathStart, to which this delegates.
     */
    public BlockPos pathStart() {
        return Movement.pathStart(player);
    }


    /**
     * Unconditional full stop: cancels the in-flight search, drops the current and next segments,
     * abandons the goal, clears keys and stops digging. Ignores safeToCancel: when an external caller
     * demands a complete stop (task cleanup), the caller is responsible for the body state.
     */
    public void forceCancel() {
        if (inProgress != null) {
            inProgress.cancel();
            inProgress = null;
            inProgressStart = null;
        }
        current = null;
        next = null;
        goal = null;
        harness.clearAllKeys();
        harness.stopBreaking();
    }
}
