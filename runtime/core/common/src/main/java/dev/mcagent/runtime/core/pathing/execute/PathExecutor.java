package dev.mcagent.runtime.core.pathing.execute;
import dev.mcagent.runtime.core.pathing.bridge.WorldKnowledgeContextProvider;
import dev.mcagent.runtime.core.pathing.cache.ExecutionWorldView;
import dev.mcagent.runtime.core.pathing.moves.AimGeometry;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Supplier;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.pathing.astar.NavPath;
import dev.mcagent.runtime.core.pathing.astar.SplicedPath;
import dev.mcagent.runtime.core.pathing.astar.CutoffPath;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.ChunkLoadedTest;
import dev.mcagent.runtime.core.pathing.moves.Input;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import dev.mcagent.runtime.core.pathing.moves.MovementState;
import dev.mcagent.runtime.core.pathing.moves.MovementStatus;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDescend;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDownward;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementFall;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.entity.BotPlayer;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;

/**
 * Path executor: drives one computed path to completion, movement by movement. One
 * {@link #onTick()} per tick, with this chain of responsibilities:
 * end-of-path advance → position relocation (backward/forward scan) → two-band off-path watchdog →
 * loaded-boundary pause → cost verification (lookahead recomputation on entering a new movement) →
 * per-tick cost-increase abort for this movement → turn-back pause → movement state-machine dispatch →
 * overall sprint decision → per-movement timeout.
 *
 * <p>Sprinting does not go through keys: the SPRINT key requested by a movement primitive is
 * confiscated, and the executor decides sprinting from the surrounding movements (step jumps, chained
 * descents, V-valleys, fall overshoot) and writes the entity's sprint state directly.
 */
public final class PathExecutor {

    /** Cancel immediately when farther than this from the path. */
    static final double MAX_MAX_DIST_FROM_PATH = 3;
    /** Start the off-path timer when farther than this from the path. */
    static final double MAX_DIST_FROM_PATH = 2;
    /** Cancel when the off-path timer exceeds this many ticks (10 seconds). */
    static final double MAX_TICKS_AWAY = 200;

    private final NavPath path;
    private final BotPlayer player;
    private final ExecHarness harness;
    /** Fresh knowledge snapshot for recomputing costs at execution time (main thread). */
    private final Supplier<CalculationContext> contextSupplier;
    /**
     * Current best partial path of the in-flight search; empty when no search is running or no
     * candidate exists yet.
     */
    private final Supplier<Optional<NavPath>> inProgressBestPath;
    private final ChunkLoadedTest loadedTest;

    private int pathPosition;
    private int ticksAway;
    private int ticksOnCurrent;
    /**
     * Ticks since the last real progress (movement completed, relocation, active digging); liveness
     * signal.
     */
    private int ticksSinceProgress;
    /**
     * Consecutive ticks the Bot is not on any valid position of the path; cancel and replan past the
     * limit.
     */
    private int ticksNotInValid;
    private static final int MAX_TICKS_NOT_IN_VALID = 20;
    /**
     * Guard on recursive advances within one onTick. After a backward scan or SUCCESS advance, onTick
     * recurses; if a movement's SUCCESS check is inconsistent with its validPositions, this can spin
     * until the stack overflows. Exceeding the path length is treated as a pathological loop and
     * cancels instead of recursing further.
     */
    private int tickRecursionDepth;
    /** Ring buffer of recent advances (pos@feet:reason), used to trace the loop when the guard fires. */
    private final String[] recentSteps = new String[16];
    private int recentStepsHead;
    private Double currentMovementOriginalCostEstimate;
    private Integer costEstimateIndex;
    /**
     * The three block sets of the remaining path need rebuilding (set when their contents changed
     * since the last tick).
     */
    private boolean recalcBP = true;
    /** All blocks the remaining path will break (maintained every tick; for visualization/queries). */
    private HashSet<BlockPos> toBreak = new HashSet<>();
    /** All positions where the remaining path will place blocks. */
    private HashSet<BlockPos> toPlace = new HashSet<>();
    /** All blocks the remaining path will walk into. */
    private HashSet<BlockPos> toWalkInto = new HashSet<>();
    private boolean failed;
    /** Cancellation cause (input for failure diagnosis and give-up decisions); null if not failed. */
    private String failureCause;
    /**
     * Structured physical failure report that failed this segment (PlayerNav uses it to route
     * deniedPlace); null if none.
     */
    private dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority.Failure movementFailure;
    /** Mutation target at the time of failure (for deniedPlace bookkeeping); null if none. */
    private net.minecraft.core.BlockPos failedPlaceTarget;
    private boolean sprintNextTick;
    /** Sprint decision (pure); its side effects are applied in one place in onTick0. */
    private final SprintPolicy sprint;

    public PathExecutor(NavPath path, BotPlayer player, ExecHarness harness,
                        Supplier<CalculationContext> contextSupplier,
                        Supplier<Optional<NavPath>> inProgressBestPath,
                        ChunkLoadedTest loadedTest) {
        this.path = path;
        this.player = player;
        this.harness = harness;
        this.contextSupplier = contextSupplier;
        this.inProgressBestPath = inProgressBestPath;
        this.loadedTest = loadedTest;
        this.sprint = new SprintPolicy(path, player, contextSupplier);
        this.pathPosition = 0;
    }

    /**
     * Feet convention: entity y plus 0.1251 (so the lower top of soul sand/farmland still counts as the
     * block above), raised one more block when inside a slab/stair block. Delegates to
     * {@link Movement#feet}: the executor and the movement primitives share one measure, which avoids
     * advance/retreat loops caused by misaligned half-block tops.
     */
    public static BlockPos playerFeet(ServerPlayer player) {
        return Movement.feet(player);
    }

    /**
     * Advances one tick (top-level entry: resets the recursion-depth guard, delegates to
     * {@link #onTick0()}).
     *
     * @return true when a movement just completed or the path entered a stable state such as a pause;
     *         false when the position was just relocated (this tick already re-ran recursively); while
     *         a movement is in progress, that movement's safeToCancel.
     */
    public boolean onTick() {
        tickRecursionDepth = 0;
        recentStepsHead = 0;
        java.util.Arrays.fill(recentSteps, null);
        return onTick0();
    }

    /** Records an advance in the ring buffer for tracing loops when the guard fires. */
    private void recordStep(String step) {
        recentSteps[recentStepsHead] = step;
        recentStepsHead = (recentStepsHead + 1) % recentSteps.length;
    }

    /**
     * Recursive implementation: re-invoked after a backward scan or SUCCESS advance; the depth guard
     * stops runaway recursion.
     */
    private boolean onTick0() {
        if (tickRecursionDepth++ > path.length()) {
            // Recursion after backward scans/SUCCESS advances exceeded the path length: some movement's
            // SUCCESS check is inconsistent with its validPositions and the executor is spinning.
            // Cancel to stop it.
            BlockPos feet = playerFeet(player);
            Movement m = path.movements().get(Math.min(pathPosition, path.movements().size() - 1));
            StringBuilder trace = new StringBuilder();
            for (int i = 0; i < recentSteps.length; i++) {
                String s = recentSteps[(recentStepsHead + i) % recentSteps.length];
                if (s != null) {
                    trace.append('[').append(s).append("] ");
                }
            }
            Constants.LOG.warn("onTick recursion exceeded path length {}, cancelling idle advance. pos={} feet={} movement={} src={} dest={} valid={} trace: {}",
                    path.length(), pathPosition, feet, m.getClass().getSimpleName(),
                    m.getSrc(), m.getDest(), m.getValidPositions(), trace);
            cancel("executor advanced without progress (SUCCESS inconsistent with valid positions, over " + path.length() + " steps)");
            return false;
        }
        if (pathPosition == path.length() - 1) {
            pathPosition++; // the last position has no movement; finish directly
        }
        if (pathPosition >= path.length()) {
            return true;
        }
        Movement movement = path.movements().get(pathPosition);
        ExecutionWorldView world = WorldKnowledgeContextProvider.executionView(player);
        movement.setExecutionWorld(world);
        try {
            return tickMovement(movement, world);
        } finally {
            // Path history keeps completed movements, but must not retain their knowledge snapshots.
            movement.setExecutionWorld(null);
        }
    }

    private boolean tickMovement(Movement movement, ExecutionWorldView world) {
        movement.setExecutionDelegate(harness);
        harness.setFailureDelegate(movement);
        BlockPos feet = playerFeet(player);
        boolean inValid = movement.getValidPositions().contains(feet);
        if (tickRecursionDepth < 6 && !inValid) {
            Constants.LOG.debug("[diag] pos={} feet={} movement={} src={} dest={} valid={} contains={}",
                    pathPosition, feet, movement.getClass().getSimpleName(),
                    movement.getSrc(), movement.getDest(),
                    movement.getValidPositions(), inValid);
        }
        if (!inValid) {
            // Backward scan: after knockback or a lag rollback the Bot is inside an already-executed
            // movement; step back and redo it
            int back = findBackwardMatch(path.movements(), pathPosition, feet);
            if (back != -1) {
                int previousPos = pathPosition;
                pathPosition = back;
                for (int j = pathPosition; j <= previousPos; j++) {
                    path.movements().get(j).reset();
                }
                recordStep("back " + previousPos + "->" + back + " feet=" + feet);
                onChangeInPathPosition();
                onTick0();
                return false;
            }
            // Forward scan: starting at +3 (+1 reports its own success, +2 is not checked); if the Bot is
            // inside a later movement, skip ahead to it
            int forward = findForwardSkip(path.movements(), pathPosition, feet);
            if (forward != -1) {
                pathPosition = forward - 1;
                recordStep("fwd ->" + (forward - 1) + " feet=" + feet);
                onChangeInPathPosition();
                onTick0();
                return false;
            }
            // Neither scan matches: the Bot is not on any valid position of this path. Every movement
            // assumes the Bot starts at its source; once that breaks, pressing on only burns the timeout
            // before replanning while the Bot stands still. Slabs/stairs auto-stepping the Bot up or
            // sideways by one block are enough to cause this, and stair-heavy builds make it common.
            // Allow a short grace period (it may be a momentary excursion), then cancel so the planner
            // replans from the Bot's actual position.
            // The check must use the same source as the movement's own validity test: when the block
            // under the feet has no support (e.g. standing on the edge of a pillar top), the search
            // uses the neighboring block as a fake start and the movement accepts it too. Checking
            // feet alone would be stricter than the movement and would kill healthy paths.
            if (movement.getValidPositions().contains(Movement.pathStart(player, world))) {
                ticksNotInValid = 0;
            } else if (++ticksNotInValid > MAX_TICKS_NOT_IN_VALID) {
                Constants.LOG.info(
                        "[mc_agent-path] position off path for {} ticks (at {}, expected {}), cancelling to replan",
                        ticksNotInValid, feet.toShortString(),
                        movement.getSrc().toShortString());
                cancel("position " + feet.toShortString() + " is not on any valid position of the path");
                return false;
            }
        } else {
            ticksNotInValid = 0;
        }
        double distFromPath = closestPathPosDist();
        if (possiblyOffPath(distFromPath, MAX_DIST_FROM_PATH)) {
            ticksAway++;
            if (ticksAway > MAX_TICKS_AWAY) {
                Constants.LOG.debug("Too far from path for too long, cancelling ({} ticks)", ticksAway);
                cancel("off the path for " + ticksAway + " ticks without returning");
                return false;
            }
        } else {
            ticksAway = 0;
        }
        if (possiblyOffPath(distFromPath, MAX_MAX_DIST_FROM_PATH)) {
            Constants.LOG.debug("Too far from path, cancelling immediately");
            cancel("position is more than " + (int) MAX_MAX_DIST_FROM_PATH + " blocks off the path");
            return false;
        }
        // For movements within pathPosition±10, drop the cached block sets and recompute them against
        // the current world; if any set changed, rebuild the full block sets of the remaining path (the
        // data source for visualization and external queries). The sets read the same knowledge view
        // as this tick's movement decisions.
        var level = world;
        for (int i = pathPosition - 10; i < pathPosition + 10; i++) {
            if (i < 0 || i >= path.movements().size()) {
                continue;
            }
            Movement m = path.movements().get(i);
            List<BlockPos> prevBreak = m.toBreak(level);
            List<BlockPos> prevPlace = m.toPlace(level);
            List<BlockPos> prevWalkInto = m.toWalkInto(level);
            m.resetBlockCache();
            if (!prevBreak.equals(m.toBreak(level))) {
                recalcBP = true;
            }
            if (!prevPlace.equals(m.toPlace(level))) {
                recalcBP = true;
            }
            if (!prevWalkInto.equals(m.toWalkInto(level))) {
                recalcBP = true;
            }
        }
        if (recalcBP) {
            HashSet<BlockPos> newBreak = new HashSet<>();
            HashSet<BlockPos> newPlace = new HashSet<>();
            HashSet<BlockPos> newWalkInto = new HashSet<>();
            for (int i = pathPosition; i < path.movements().size(); i++) {
                Movement m = path.movements().get(i);
                newBreak.addAll(m.toBreak(level));
                newPlace.addAll(m.toPlace(level));
                newWalkInto.addAll(m.toWalkInto(level));
            }
            toBreak = newBreak;
            toPlace = newPlace;
            toWalkInto = newWalkInto;
            recalcBP = false;
        }
        if (pathPosition < path.movements().size() - 1) {
            Movement next = path.movements().get(pathPosition + 1);
            if (!loadedTest.isLoaded(next.getDest().getX(), next.getDest().getZ())) {
                Constants.LOG.debug("Next movement ends at the edge of loaded chunks, pausing");
                harness.clearAllKeys();
                return true;
            }
        }
        boolean canCancel = movement.safeToCancel();
        CalculationContext context = contextSupplier.get();
        if (costEstimateIndex == null || costEstimateIndex != pathPosition) {
            // Entering a new movement: pin the estimate from path computation as the baseline and verify
            // ahead
            costEstimateIndex = pathPosition;
            currentMovementOriginalCostEstimate = movement.getCost();
            prepareSupplies(movement, world);
            int lookahead = NavSettings.get().costVerificationLookahead;
            int deadFuture = firstFutureImpossible(path.movements(), pathPosition, lookahead, context);
            if (deadFuture != -1 && canCancel) {
                Constants.LOG.debug("World changed, an upcoming movement is no longer possible, cancelling");
                cancel("world changed, " + describe(path.movements().get(deadFuture)) + " is no longer possible");
                return true;
            }
        }
        double currentCost = movement.recalculateCost(context);
        if (currentCost >= COST_INF && canCancel) {
            Constants.LOG.debug("World changed, the current movement is no longer possible, cancelling");
            cancel("world changed, " + describe(movement) + " is no longer possible");
            return true;
        }
        if (!movement.calculatedWhileLoaded()
                && costIncreaseExceedsTolerance(currentMovementOriginalCostEstimate, currentCost,
                        NavSettings.get().maxCostIncrease)
                && canCancel) {
            // Applies only to movements estimated in unloaded chunks, whose estimate may not match the
            // terrain once loaded. Increases on movements computed while loaded are knock-on effects of
            // this path itself and are ignored
            Constants.LOG.debug("Movement cost estimate rose from {} to {}, cancelling", currentMovementOriginalCostEstimate, currentCost);
            cancel(describe(movement) + " cost estimate after loading rose from "
                    + (int) (double) currentMovementOriginalCostEstimate + " to " + (int) currentCost);
            return true;
        }
        if (shouldPause(world)) {
            Constants.LOG.debug("The in-flight search's best path passes back under the feet, pausing");
            harness.clearAllKeys();
            return true;
        }
        // Digging straight down can only continue from the descend's landing column; if the previous
        // step overshoots to fakeDest, Downward immediately reports UNREACHABLE in the wrong column.
        // The executor knows the adjacent movements, so before this tick's movement.update it requires
        // Descend to land exactly on dest.
        if (movement instanceof MovementDescend descend
                && pathPosition + 1 < path.movements().size()
                && path.movements().get(pathPosition + 1) instanceof MovementDownward) {
            descend.forceSafeMode();
        }
        MovementStatus movementStatus = movement.update();
        if (movementStatus == MovementStatus.UNREACHABLE || movementStatus == MovementStatus.FAILED) {
            Constants.LOG.debug("Movement reported {}, cancelling", movementStatus);
            // Capture the structured physical failure before cancelling (cancel keeps no movement
            // reference and splicing replaces the executor instance, so it must be read now).
            movementFailure = movement.lastExecutionFailure();
            failedPlaceTarget = movement.lastFailedMutationTarget();
            String cause = describe(movement) + " execution reported " + movementStatus;
            if (movementFailure != null) {
                cause += " (" + movementFailure.code().wireValue() + ": " + movementFailure.message() + ")";
            }
            cancel(cause);
            return true;
        }
        if (movementStatus == MovementStatus.SUCCESS) {
            pathPosition++;
            recordStep("success ->" + pathPosition + " feet=" + playerFeet(player));
            onChangeInPathPosition();
            onTick0();
            return true;
        } else {
            // Confiscate the SPRINT key requested by the primitive (the executor writes sprint state
            // directly, not via keys) and pass the request to the policy as a fact; all side effects of
            // the decision are applied here.
            boolean sprintRequested = harness.isKeyRequested(Input.SPRINT);
            harness.forceKey(Input.SPRINT, false);
            SprintPolicy.Decision d = sprint.decide(world, pathPosition, sprintRequested);
            if (d.skipTo() >= 0) {
                pathPosition = d.skipTo();
                onChangeInPathPosition();
                onTick0();
            }
            if (d.jumpUp()) {
                harness.forceKey(Input.JUMP, true);
            }
            if (d.jumpDown()) {
                harness.forceKey(Input.JUMP, false);
            }
            if (d.steer() != null) {
                // Sprint down without slowing: clear keys, force look at the target and forward
                harness.clearAllKeys();
                Vec3 eye = player.getEyePosition();
                harness.applyRotation(new MovementState.MovementTarget(
                        AimGeometry.yawTo(eye, d.steer()),
                        AimGeometry.pitchTo(eye, d.steer()), false));
                harness.forceKey(Input.MOVE_FORWARD, true);
            }
            sprintNextTick = d.sprint();
            if (!sprintNextTick) {
                player.setSprinting(false); // releasing keys does not stop sprinting by itself
            }
            ticksOnCurrent++;
            // Active digging counts as real progress (a hard block taking dozens of ticks is normal work)
            if (harness.isDigging()) {
                ticksSinceProgress = 0;
            } else {
                ticksSinceProgress++;
            }
            if (ticksOnCurrent > timedOutAt(currentMovementOriginalCostEstimate,
                    NavSettings.get().movementTimeoutTicks)) {
                // A stuck movement must be logged with type, endpoints, surrounding blocks and position in
                // one line. Stuck movements are the most common pathing failure, so this is INFO rather
                // than debug: release builds do not persist debug logs.
                Constants.LOG.info(
                        "[mc_agent-path] movement stuck {} took {} ticks (estimate {}) no progress for {} ticks pos {} exact ({}) "
                                + "src block={} dest block={} above dest={} below dest={}",
                        describe(movement), ticksOnCurrent,
                        (int) (double) currentMovementOriginalCostEstimate, ticksSinceProgress,
                        playerFeet(player).toShortString(),
                        String.format("%.2f,%.2f,%.2f", player.getX(), player.getY(), player.getZ()),
                        blockName(movement.getSrc()), blockName(movement.getDest()),
                        blockName(movement.getDest().above()), blockName(movement.getDest().below()));
                cancel(describe(movement) + " stuck: took " + ticksOnCurrent
                        + " ticks, far over the estimate of " + (int) (double) currentMovementOriginalCostEstimate);
                return true;
            }
        }
        return canCancel;
    }

    // ==================== Relocation (pure logic, testable) ====================

    /** Backward scan: first movement in [0, pathPosition) whose valid positions contain feet; -1 if none. */
    static int findBackwardMatch(List<Movement> movements, int pathPosition, BlockPos feet) {
        for (int i = 0; i < pathPosition && i < movements.size(); i++) {
            if (movements.get(i).getValidPositions().contains(feet)) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Forward scan: first movement in [pathPosition+3, movements.size()) whose valid positions contain
     * feet; -1 if none. Deliberately skips +1 (that movement reports SUCCESS itself) and +2.
     */
    static int findForwardSkip(List<Movement> movements, int pathPosition, BlockPos feet) {
        for (int i = pathPosition + 3; i < movements.size(); i++) {
            if (movements.get(i).getValidPositions().contains(feet)) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Early snap check (pure logic): no snap while airborne and not in liquid; no snap while strictly
     * sinking (vertical velocity < -0.1, possibly falling through water); if feet is exactly in the
     * position sequence, return that index, otherwise -1.
     */
    static int snipsnapIndex(List<BlockPos> positions, BlockPos feet,
                             boolean onGround, boolean feetInLiquid, double deltaY) {
        if (!onGround && !feetInLiquid) {
            return -1;
        }
        if (deltaY < -0.1) {
            return -1;
        }
        return positions.indexOf(feet);
    }

    // ==================== Cost verification / timeout (pure logic, testable) ====================

    /**
     * Looks ahead {@code lookahead} movements starting one past the current step and returns the index
     * of the first with cost {@code >= COST_INF}; -1 if all are feasible. The window excludes the current
     * step and the last path position (which has no movement).
     */
    static int firstFutureImpossible(List<Movement> movements, int pathPosition,
                                      int lookahead, CalculationContext context) {
        for (int i = 1; i < lookahead && pathPosition + i < movements.size(); i++) {
            Movement future = movements.get(pathPosition + i);
            if (future.calculateCost(context, new MutableMoveResult()) >= COST_INF) {
                return pathPosition + i;
            }
        }
        return -1;
    }

    /**
     * Whether the cost increase exceeds the tolerance (only for estimated movements; the caller checks
     * calculatedWhileLoaded).
     */
    static boolean costIncreaseExceedsTolerance(double originalEstimate, double currentCost,
                                                double maxCostIncrease) {
        return currentCost - originalEstimate > maxCostIncrease;
    }

    /** Per-movement timeout threshold: estimated ticks plus grace. */
    static double timedOutAt(double originalCostEstimate, int movementTimeoutTicks) {
        return originalCostEstimate + movementTimeoutTicks;
    }

    // ==================== Off-path ====================

    /** Minimum distance from the player to the center of any valid position on the whole path. */
    private double closestPathPosDist() {
        return closestPathPosDist(path.movements(), player.getX(), player.getY(), player.getZ());
    }

    /**
     * Pure logic: minimum distance from the given player coordinates to the center of any valid position
     * on the path.
     */
    static double closestPathPosDist(List<Movement> movements, double px, double py, double pz) {
        double best = -1;
        for (Movement movement : movements) {
            for (BlockPos pos : movement.getValidPositions()) {
                double dist = distanceToCenter(pos, px, py, pz);
                if (dist < best || best == -1) {
                    best = dist;
                }
            }
        }
        return best;
    }

    /**
     * Whether the Bot may be off the path. During a fall it is normal to be far from both source and
     * destination, so when the current movement is a fall the horizontal distance to the fall
     * destination is used instead.
     */
    private boolean possiblyOffPath(double distanceFromPath, double leniency) {
        return possiblyOffPath(path, pathPosition, distanceFromPath, leniency,
                player.getX(), player.getZ(), pos -> entityFlatDistanceToCenter(pos));
    }

    /**
     * Pure logic: from the path, current index, the player's minimum distance to the path and the
     * tolerance, decides whether the Bot may be off the path. When the current movement is a fall, uses
     * the horizontal distance to the fall destination (index + 1). flatDist gives the horizontal
     * distance from the player to a position's center (used for the fall destination).
     */
    static boolean possiblyOffPath(NavPath path, int pathPosition, double distanceFromPath,
                                    double leniency, double px, double pz,
                                    java.util.function.Function<BlockPos, Double> flatDist) {
        if (distanceFromPath <= leniency) {
            return false;
        }
        if (path.movements().get(pathPosition) instanceof MovementFall) {
            BlockPos fallDest = path.positions().get(pathPosition + 1);
            return flatDist.apply(fallDest) >= leniency;
        }
        return true;
    }

    /** Pure logic: 3D distance from player coordinates to a position's center. */
    static double distanceToCenter(BlockPos pos, double px, double py, double pz) {
        double dx = pos.getX() + 0.5 - px;
        double dy = pos.getY() + 0.5 - py;
        double dz = pos.getZ() + 0.5 - pz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private double entityFlatDistanceToCenter(BlockPos pos) {
        return flatDistanceToCenter(pos, player.getX(), player.getZ());
    }

    /** Pure logic: horizontal distance from player coordinates to a position's center. */
    static double flatDistanceToCenter(BlockPos pos, double px, double pz) {
        double dx = pos.getX() + 0.5 - px;
        double dz = pos.getZ() + 0.5 - pz;
        return Math.sqrt(dx * dx + dz * dz);
    }

    // ==================== Turn-back pause / early snap ====================

    /**
     * If the in-flight search's best partial path (at least 3 positions, excluding the first) contains
     * the feet position, the new path will pass here and there is no need to keep walking. Applies only
     * when on the ground, the body space is clear, and the current movement is safe to cancel.
     */
    private boolean shouldPause(ExecutionWorldView world) {
        Optional<NavPath> currentBest = inProgressBestPath.get();
        if (currentBest.isEmpty()) {
            return false;
        }
        if (!player.onGround()) {
            return false;
        }
        BlockPos feet = playerFeet(player);
        var level = world;
        if (!MovementHelper.canWalkOn(level, feet.below())) {
            return false; // standing position is questionable (possibly mid-parkour); do not stop
        }
        if (!MovementHelper.canWalkThrough(level, feet)
                || !MovementHelper.canWalkThrough(level, feet.above())) {
            return false; // body is buried; do not stop
        }
        if (!path.movements().get(pathPosition).safeToCancel()) {
            return false;
        }
        List<BlockPos> positions = currentBest.get().positions();
        if (positions.size() < 3) {
            return false; // too short to be confident the new path will go this way
        }
        return positions.subList(1, positions.size()).contains(feet);
    }

    /** Wherever execution currently is, snaps to the path position the Bot is standing on, if any. */
    public boolean snipsnapifpossible() {
        BlockPos feet = playerFeet(player);
        boolean feetInLiquid = !player.level().getFluidState(feet).isEmpty();
        int index = snipsnapIndex(path.positions(), feet,
                player.onGround(), feetInLiquid, player.getDeltaMovement().y);
        if (index == -1) {
            return false;
        }
        pathPosition = index;
        harness.clearAllKeys();
        return true;
    }

    // ==================== Stocking / state transitions ====================

    /**
     * Execution-time stocking on entering a new movement: movements that place blocks move throwaway
     * blocks from the main inventory into the hotbar (planning counts the whole inventory); falls higher
     * than the safe height onto a landing without water stock a water bucket.
     */
    private void prepareSupplies(Movement movement, ExecutionWorldView world) {
        if (movement.getToPlace() != null) {
            harness.ensureThrowawayInHotbar();
        }
        if (movement instanceof MovementFall
                && movement.getSrc().getY() - movement.getDest().getY() > NavSettings.get().maxFallHeightNoWater
                && !MovementHelper.isWater(world.getBlockState(movement.getDest()))) {
            harness.ensureWaterBucketInHotbar();
        }
    }

    private void onChangeInPathPosition() {
        harness.clearAllKeys();
        ticksOnCurrent = 0;
        ticksSinceProgress = 0;
    }

    /** Short block name (for diagnostic logs). */
    private String blockName(BlockPos pos) {
        return player.level().getBlockState(pos).getBlock()
                .builtInRegistryHolder().key().location().getPath();
    }

    /** Human-readable movement description (for failure causes): type plus source and destination. */
    private static String describe(Movement movement) {
        return movement.getClass().getSimpleName()
                + " " + movement.getSrc().toShortString()
                + " -> " + movement.getDest().toShortString();
    }

    /** Cancels: records the cause, clears keys, stops digging, moves the index past the end, marks failed. */
    private void cancel(String cause) {
        failureCause = cause;
        harness.clearAllKeys();
        harness.stopBreaking();
        pathPosition = path.length() + 3;
        failed = true;
    }

    // ==================== Splicing / history trimming ====================

    /**
     * Splices the next segment into the current path, keeping execution state. When splicing is not
     * possible or there is no next segment, trims the start if the executed history is too long.
     */
    public PathExecutor trySplice(PathExecutor next) {
        if (next == null) {
            return cutIfTooLong();
        }
        return SplicedPath.trySplice(path, next.path, false).map(spliced -> {
            if (!spliced.getDest().equals(next.getPath().getDest())) {
                throw new IllegalStateException(
                        "Spliced end " + spliced.getDest() + " vs next segment end " + next.getPath().getDest() + ": mismatch");
            }
            PathExecutor ret = newWithSamePlumbing(spliced);
            ret.pathPosition = pathPosition;
            ret.currentMovementOriginalCostEstimate = currentMovementOriginalCostEstimate;
            ret.costEstimateIndex = costEstimateIndex;
            ret.ticksOnCurrent = ticksOnCurrent;
            ret.ticksSinceProgress = ticksSinceProgress;
            return ret;
        }).orElseGet(this::cutIfTooLong);
    }

    private PathExecutor cutIfTooLong() {
        if (pathPosition > NavSettings.get().maxPathHistoryLength) {
            int cutoffAmt = NavSettings.get().pathHistoryCutoffAmount;
            CutoffPath newPath = new CutoffPath(path, cutoffAmt, path.length() - 1);
            if (!newPath.getDest().equals(path.getDest())) {
                throw new IllegalStateException("End changed after trimming history: " + newPath.getDest() + " != " + path.getDest());
            }
            Constants.LOG.debug("Executed history too long, trimming path from {} to {}", path.length(), newPath.length());
            PathExecutor ret = newWithSamePlumbing(newPath);
            ret.pathPosition = pathPosition - cutoffAmt;
            ret.currentMovementOriginalCostEstimate = currentMovementOriginalCostEstimate;
            if (costEstimateIndex != null) {
                ret.costEstimateIndex = costEstimateIndex - cutoffAmt;
            }
            ret.ticksOnCurrent = ticksOnCurrent;
            ret.ticksSinceProgress = ticksSinceProgress;
            return ret;
        }
        return this;
    }

    private PathExecutor newWithSamePlumbing(NavPath newPath) {
        return new PathExecutor(newPath, player, harness, contextSupplier, inProgressBestPath, loadedTest);
    }

    // ==================== Read-only accessors ====================

    public int getPosition() {
        return pathPosition;
    }

    public NavPath getPath() {
        return path;
    }

    public Goal getGoal() {
        return path.getGoal();
    }

    public boolean failed() {
        return failed;
    }

    /** Human-readable failure cause; null if not failed. */
    public String failureCause() {
        return failureCause;
    }

    /** Structured physical failure report that caused the failure; null if none. */
    public dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority.Failure movementFailure() {
        return movementFailure;
    }

    /** Mutation target at the time of failure; null if none. */
    public net.minecraft.core.BlockPos failedPlaceTarget() {
        return failedPlaceTarget;
    }

    public boolean finished() {
        return pathPosition >= path.length();
    }

    /**
     * Where execution is stuck (for diagnostics): step index / path length, movement type, endpoints and
     * ticks without progress.
     */
    public String progressSummary() {
        if (pathPosition >= path.movements().size()) {
            return pathPosition + "/" + path.length() + " finished";
        }
        Movement m = path.movements().get(pathPosition);
        var view = WorldKnowledgeContextProvider.executionView(player);
        StringBuilder toBreak = new StringBuilder();
        for (BlockPos p : m.toBreakAll()) {
            if (MovementHelper.canWalkThrough(view, p)) continue;
            toBreak.append(p.toShortString()).append('=')
                    .append(view.getBlockState(p).getBlock().builtInRegistryHolder()
                            .key().location().getPath()).append(' ');
        }
        return pathPosition + "/" + path.length() + " " + m.getClass().getSimpleName()
                + " " + m.getSrc().toShortString() + "->" + m.getDest().toShortString()
                + " no progress for " + ticksSinceProgress + " ticks pos " + playerFeet(player).toShortString()
                + " src block=" + blockName(m.getSrc()) + " below src=" + blockName(m.getSrc().below())
                + " dest block=" + blockName(m.getDest())
                + " to break[" + toBreak.toString().trim() + "]";
    }

    /** Ticks since the last real progress (movement completed, relocation, active digging). */
    public int ticksSinceProgress() {
        return ticksSinceProgress;
    }

    /** The executor's sprint decision for this tick (the owner applies it to the entity). */
    public boolean isSprinting() {
        return sprintNextTick;
    }

    /** All blocks the remaining path will break (read-only). */
    public Set<BlockPos> toBreak() {
        return Collections.unmodifiableSet(toBreak);
    }

    /** All positions where the remaining path will place blocks (read-only). */
    public Set<BlockPos> toPlace() {
        return Collections.unmodifiableSet(toPlace);
    }

    /** All blocks the remaining path will walk into (read-only). */
    public Set<BlockPos> toWalkInto() {
        return Collections.unmodifiableSet(toWalkInto);
    }
}
