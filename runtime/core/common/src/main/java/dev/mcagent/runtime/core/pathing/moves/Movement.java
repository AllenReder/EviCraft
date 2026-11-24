package dev.mcagent.runtime.core.pathing.moves;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;

import dev.mcagent.runtime.core.pathing.bridge.WorldKnowledgeContextProvider;
import dev.mcagent.runtime.core.pathing.cache.ExecutionWorldView;
import dev.mcagent.runtime.core.pathing.execute.RouteMutation;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;

/**
 * Abstract base of movement primitives: a minimal executable action "from src to dest", with its own
 * cost calculation (planning time) and per-tick state machine (execution time).
 *
 * <p>The common execution framework is in {@link #update()}: the subclass advances its state machine,
 * then forced jumping to surface in water and stuck-in-wall recovery are layered on, and finally this
 * tick's key map is handed to the execution-layer hooks. Preparation ({@link #prepared}): wait for
 * falling block entities to settle, and hand each still-blocking toBreak cell to the
 * {@link #beginBreaking} hook to mine.
 */
public abstract class Movement {

    protected final ServerPlayer player;
    protected ExecutionWorldView world;

    public void setExecutionWorld(ExecutionWorldView world) {
        this.world = world;
    }

    protected final BlockPos src;
    protected final BlockPos dest;

    /** Cells that must be mined through before this movement starts. */
    protected final BlockPos[] positionsToBreak;

    /** Cell that needs a block placed before this movement starts (null if none). */
    protected final BlockPos positionToPlace;

    private MovementState currentState = new MovementState().setStatus(MovementStatus.PREPPING);

    /** Mutation dispatched to the execution layer this tick (lets failure reports be attributed after
     * {@code dispatchTo} clears the state); reset by {@link #update()} before dispatch. */
    private RouteMutation dispatchedMutation;

    /** Most recent physical execution failure (delivered by the execution layer through
     * {@link #onRouteMutationFailed}); null if none. */
    private PhysicalVerificationAuthority.Failure lastExecutionFailure;

    /** Mutation target cell of the most recent failure; null if none. */
    private BlockPos lastFailedMutationTarget;

    /** Consecutive transient failures of the same mutation; reaching
     * {@link #MAX_TRANSIENT_FAILURE_TICKS} escalates to UNREACHABLE. */
    private int transientFailureTicks;

    /** Consecutive transient failures of one mutation before giving up. Leaves a window for transient
     * recovery (an entity moving away, aim stepping into place) without allowing unbounded retries. */
    private static final int MAX_TRANSIENT_FAILURE_TICKS = 20;

    /** Cached cost; {@code override} lets callers pin a stricter estimate. */
    private Double cost;

    private Set<BlockPos> validPositionsCached;

    /** Cells still to mine (lazy cache, recomputed from the current world after {@link #resetBlockCache()}). */
    protected List<BlockPos> toBreakCached;
    /** Cells still needing a placed block (lazy cache). */
    protected List<BlockPos> toPlaceCached;
    /** Cells the body squeezes into (lazy cache; non-empty only for diagonal movements). */
    protected List<BlockPos> toWalkIntoCached;

    /** Whether the cost was computed with dest's chunk loaded (used to exempt execution-time cost increases). */
    private Boolean calculatedWhileLoaded;

    protected Movement(ServerPlayer player, BlockPos src, BlockPos dest,
                       BlockPos[] toBreak, BlockPos toPlace) {
        this.player = player;
        this.src = src;
        this.dest = dest;
        this.positionsToBreak = toBreak;
        this.positionToPlace = toPlace;
    }

    protected Movement(ServerPlayer player, BlockPos src, BlockPos dest, BlockPos[] toBreak) {
        this(player, src, dest, toBreak, null);
    }

    // ==================== Cost ====================

    /** The computed cost; throws if not yet computed (callers must call getCost(context) first). */
    public double getCost() {
        return cost;
    }

    public double getCost(CalculationContext context) {
        if (cost == null) {
            MutableMoveResult result = new MutableMoveResult();
            cost = calculateCost(context, result);
        }
        return cost;
    }

    /** Recompute the cost (discards the cache and any override). */
    public double recalculateCost(CalculationContext context) {
        cost = null;
        return getCost(context);
    }

    /** Pin the cost externally (used to take the stricter of the computed cost and the node delta). */
    public void override(double cost) {
        this.cost = cost;
    }

    /**
     * Compute this movement's cost; movements with a dynamic destination write the actual destination
     * into result. Returns {@link ActionCosts#COST_INF} if infeasible.
     */
    public abstract double calculateCost(CalculationContext context, MutableMoveResult result);

    // ==================== Valid positions ====================

    /** Cells the body may occupy during execution (relocation anchors). */
    protected abstract Set<BlockPos> calculateValidPositions();

    public Set<BlockPos> getValidPositions() {
        if (validPositionsCached == null) {
            validPositionsCached = calculateValidPositions();
            Objects.requireNonNull(validPositionsCached);
        }
        return validPositionsCached;
    }

    /**
     * Feet position convention: entity y plus 0.1251 (soul sand/farmland tops are slightly lower but still
     * count as the cell above), raised one more cell when inside a slab or stair cell. Executor relocation,
     * validPositions and this class's arrival/failure checks <b>all</b> use this one yardstick, so a slab or
     * soul sand top being off by one cell cannot cause a loop between SUCCESS advancing and fallback.
     */
    public static BlockPos feet(ServerPlayer player) {
        BlockPos f = BlockPos.containing(
                player.position().x, player.position().y + 0.1251, player.position().z);
        BlockState at = player.level().getBlockState(f);
        // Stairs behave like slabs: standing on the low half, entity y is only half a block above the cell
        // bottom, so even with the offset it falls in that cell, while the pathing model places the player
        // in the cell <b>above</b>. With two inconsistent yardsticks the executor would decide the player
        // is not on a valid position of this movement, relocation would fail in both directions, and the
        // movement would hang until timeout.
        if (at.getBlock() instanceof SlabBlock || at.getBlock() instanceof StairBlock) {
            return f.above();
        }
        return f;
    }

    /**
     * Whether the current body position is in this movement's set of valid positions. If the feet are
     * not in the set, also compute a fake start with {@link #pathStart(ServerPlayer)} (when the feet cell
     * is not standable, a support point among the 3x3 neighbors or one cell below). After a recompute or
     * fallback the overall path start need not belong to this movement's own {src,dest} set; the fake
     * start covers that case.
     */
    protected boolean playerInValidPosition() {
        BlockPos feet = feet(player);
        if (getValidPositions().contains(feet)) {
            return true;
        }
        BlockPos fakeStart = pathStart(player, world);
        return getValidPositions().contains(fakeStart);
    }

    /**
     * Fake start when the feet cell is not standable. On the ground: of the four 3x3 neighbors closest by
     * horizontal distance, the first whose cell below is standable and whose own and upper cells are
     * passable. In the air: the cell below the feet if the cell under that is standable. Otherwise the feet
     * position. Same semantics as PathingCore.pathStart; a static base-class helper so Movement
     * subclasses (for example Downward's UNREACHABLE check) can reuse it.
     */
    public static BlockPos pathStart(ServerPlayer player) {
        return pathStart(player, WorldKnowledgeContextProvider.executionView(player));
    }

    public static BlockPos pathStart(ServerPlayer player, BlockGetter level) {
        BlockPos feet = feet(player);
        if (MovementHelper.canWalkOn(level, feet.below())) {
            return feet;
        }
        if (player.onGround()) {
            double playerX = player.position().x;
            double playerZ = player.position().z;
            java.util.List<BlockPos> closest = new java.util.ArrayList<>();
            for (int dx = -1; dx <= 1; dx++) {
                for (int dz = -1; dz <= 1; dz++) {
                    closest.add(new BlockPos(feet.getX() + dx, feet.getY(), feet.getZ() + dz));
                }
            }
            closest.sort(java.util.Comparator.comparingDouble(pos ->
                    ((pos.getX() + 0.5) - playerX) * ((pos.getX() + 0.5) - playerX)
                    + ((pos.getZ() + 0.5) - playerZ) * ((pos.getZ() + 0.5) - playerZ)));
            for (int i = 0; i < 4; i++) {
                BlockPos possibleSupport = closest.get(i);
                double xDist = Math.abs((possibleSupport.getX() + 0.5) - playerX);
                double zDist = Math.abs((possibleSupport.getZ() + 0.5) - playerZ);
                if (xDist > 0.8 && zDist > 0.8) {
                    continue;
                }
                if (MovementHelper.canWalkOn(level, possibleSupport.below())
                        && MovementHelper.canWalkThrough(level, possibleSupport)
                        && MovementHelper.canWalkThrough(level, possibleSupport.above())) {
                    return possibleSupport;
                }
            }
        } else {
            if (MovementHelper.canWalkOn(level, feet.below().below())) {
                return feet.below();
            }
        }
        return feet;
    }

    // ==================== Execution state machine ====================

    /**
     * Advance one tick. Common framework: force flying off (ground physics) -> subclass state machine ->
     * hold jump in water below the target height (surface) -> when stuck in a wall, switch to the best tool
     * for that block and mine it -> rotation and keys go to the execution-layer hooks; keys are cleared
     * before being set, and cleared on a terminal state.
     */
    public MovementStatus update() {
        // Force flying off: path execution uses ground physics (jumping/falling) and must not be disturbed
        // by a flying flag set elsewhere
        player.getAbilities().flying = false;
        currentState = updateState(currentState);
        BlockPos feet = feet(player);
        if (MovementHelper.isLiquid(player.level().getBlockState(feet))
                && player.getY() < dest.getY() + 0.6) {
            currentState.setInput(Input.JUMP, true);
        }
        if (player.isInWall()) {
            // Stuck-in-wall recovery: switch to the best tool for the block under the crosshair before
            // mining, so breaking out is not slowed down
            BlockPos hit = crosshairBlock();
            BlockState hitState = hit == null ? null : world.getBlockState(hit);
            if (hitState != null && player instanceof dev.mcagent.runtime.entity.BotPlayer np) {
                dev.mcagent.runtime.core.act.ToolSelect.holdBestTool(np, hitState);
            }
            if (hit != null) {
                currentState.setRouteMutation(new RouteMutation.Break(hit));
            }
        }

        dispatchedMutation = currentState.getRouteMutation();
        currentState.dispatchTo(executionDelegate);

        if (currentState.getStatus().isComplete()) {
            clearInputs();
        }
        return currentState.getStatus();
    }

    /** First hit of the current rotation in the execution knowledge view; the actual commit is still verified by the PVA. */
    protected BlockPos crosshairBlock() {
        double reach = NavSettings.get().blockReachDistance;
        var eye = player.getEyePosition();
        HitResult hit = world.clip(new ClipContext(eye,
                eye.add(player.getViewVector(1.0f).scale(reach)),
                ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
        if (hit.getType() == HitResult.Type.BLOCK) {
            return ((BlockHitResult) hit).getBlockPos();
        }
        return null;
    }

    /**
     * Preparation: if any toBreak cell has a falling block entity (and the wait switch is on), wait without
     * mining or moving; if any cell is still impassable, hand it to {@link #beginBreaking} and report not
     * ready. Ready once all are clear (the check is skipped while WAITING).
     */
    protected boolean prepared(MovementState state) {
        if (state.getStatus() == MovementStatus.WAITING) {
            return true;
        }
        for (BlockPos pos : positionsToBreak) {
            if (NavSettings.get().pauseMiningForFallingBlocks
                    && world.hasFallingBlock(new AABB(0, 0, 0, 1, 1.1, 1).move(pos))) {
                return false;
            }
            if (!MovementHelper.canWalkThrough(world, pos)) {
                beginBreaking(state, pos);
                return false;
            }
        }
        return true;
    }

    /**
     * Advance the state machine; subclasses override and call this first. Not ready: PREPPING; once ready,
     * PREPPING -> WAITING -> RUNNING.
     */
    public MovementState updateState(MovementState state) {
        if (!prepared(state)) {
            return state.setStatus(MovementStatus.PREPPING);
        } else if (state.getStatus() == MovementStatus.PREPPING) {
            state.setStatus(MovementStatus.WAITING);
        }
        if (state.getStatus() == MovementStatus.WAITING) {
            state.setStatus(MovementStatus.RUNNING);
        }
        return state;
    }

    /** Whether the movement can be interrupted safely now (always by default; overridden while placing mid-air). */
    public boolean safeToCancel() {
        return safeToCancel(currentState);
    }

    protected boolean safeToCancel(MovementState state) {
        return true;
    }

    /** Reset the state machine (used when the path falls back and re-executes). */
    public void reset() {
        currentState = new MovementState().setStatus(MovementStatus.PREPPING);
    }

    // ==================== Execution-layer hooks (applied through the injected delegate) ====================

    /**
     * Execution delegate: movement primitives only describe where to look, which keys to press and which
     * cell to mine; the delegate applies them to the entity (rotation stepping, input fields, progressive
     * mining).
     */
    public interface ExecutionDelegate {

        /** Apply one Route Mutation with its kind and target. */
        void applyRouteMutation(RouteMutation mutation);

        /** Prepare aim/tool state before the movement finishes its tick decision. */
        default void prepareRouteMutation(MovementState state, RouteMutation mutation, BlockGetter world) {}

        /** Apply the desired rotation (approached in quantized mouse steps, never snapped instantly). */
        void applyRotation(MovementState.MovementTarget target);

        /** Clear all keys. */
        void clearInputs();

        /** Apply a single key. */
        void applyInput(Input input, boolean held);
    }

    private ExecutionDelegate executionDelegate;

    /** Inject the execution delegate; without one, the hooks are no-ops (planning-only use). */
    public void setExecutionDelegate(ExecutionDelegate delegate) {
        this.executionDelegate = delegate;
    }

    // ==================== Physical failure reports ====================

    /** Most recent physical execution failure; null if none. */
    public PhysicalVerificationAuthority.Failure lastExecutionFailure() {
        return lastExecutionFailure;
    }

    /** Mutation target cell of the most recent failure; null if none. */
    public BlockPos lastFailedMutationTarget() {
        return lastFailedMutationTarget;
    }

    /**
     * Entry point for execution-layer failure reports. Only reports for the mutation this movement
     * dispatched this tick are accepted ({@code dispatchTo} has already cleared the state, so attribution
     * relies on {@link #dispatchedMutation}). Then classify by code: persistent codes go to UNREACHABLE
     * immediately; transient codes get a recovery window, and the same mutation failing consecutively up
     * to the limit also escalates. The harness is stateless: it reports a failure and forgets it.
     */
    public final void onRouteMutationFailed(RouteMutation mutation,
            PhysicalVerificationAuthority.Failure failure) {
        if (!mutation.equals(dispatchedMutation)) {
            return;
        }
        lastExecutionFailure = failure;
        lastFailedMutationTarget = mutation.target();
        if (!isTransientFailure(failure)) {
            currentState.setStatus(MovementStatus.UNREACHABLE);
            return;
        }
        if (++transientFailureTicks >= MAX_TRANSIENT_FAILURE_TICKS) {
            currentState.setStatus(MovementStatus.UNREACHABLE);
        }
    }

    /**
     * Whether the failure is treated as transient (retry after an entity moves away or the aim settles).
     * Base class: entity blocking, occlusion, target change, a right-click with no effect and failed
     * verification are recoverable. Subclasses may only widen this, never narrow it (for example jump
     * placement's NO_SUPPORT depends on aim stepping within the jump window).
     */
    protected boolean isTransientFailure(PhysicalVerificationAuthority.Failure failure) {
        return switch (failure.code()) {
            case ENTITY_BLOCKED, BODY_IN_TARGET, OCCLUDED, TARGET_CHANGED, NO_EFFECT,
                    VERIFICATION_FAILED -> true;
            default -> false;
        };
    }

    /** Start mining a cell, recorded as a BREAK request with a target. */
    protected void beginBreaking(MovementState state, BlockPos pos) {
        BlockPos crosshair = crosshairBlock();
        if (crosshair != null) {
            for (BlockPos planned : positionsToBreak) {
                if (planned.equals(crosshair)
                        && !MovementHelper.canWalkThrough(world, crosshair)) {
                    pos = crosshair;
                    break;
                }
            }
        }
        RouteMutation.Break breaking = new RouteMutation.Break(pos);
        state.setRouteMutation(breaking);
        if (executionDelegate != null) {
            executionDelegate.prepareRouteMutation(state, breaking, world);
        }
    }

    /** Clear all keys, forwarded to the execution delegate. */
    protected void clearInputs() {
        if (executionDelegate != null) {
            executionDelegate.clearInputs();
        }
    }

    // ==================== Metadata ====================

    public BlockPos getSrc() {
        return src;
    }

    public BlockPos getDest() {
        return dest;
    }

    public BlockPos getDirection() {
        return dest.subtract(src);
    }

    public BlockPos[] toBreakAll() {
        return positionsToBreak;
    }

    /** Drop the three cell-set caches; the next query recomputes them from the current world. */
    public void resetBlockCache() {
        toBreakCached = null;
        toPlaceCached = null;
        toWalkIntoCached = null;
    }

    /** Cells that are still impassable and must be mined (cached until {@link #resetBlockCache()}). */
    public List<BlockPos> toBreak(net.minecraft.world.level.BlockGetter level) {
        if (toBreakCached != null) {
            return toBreakCached;
        }
        List<BlockPos> result = new ArrayList<>();
        for (BlockPos pos : positionsToBreak) {
            if (!MovementHelper.canWalkThrough(level, pos)) {
                result.add(pos);
            }
        }
        toBreakCached = result;
        return result;
    }

    /** Cells that are still not standable and need a placed block (cached until {@link #resetBlockCache()}). */
    public List<BlockPos> toPlace(net.minecraft.world.level.BlockGetter level) {
        if (toPlaceCached != null) {
            return toPlaceCached;
        }
        List<BlockPos> result = new ArrayList<>();
        if (positionToPlace != null && !MovementHelper.canWalkOn(level, positionToPlace)) {
            result.add(positionToPlace);
        }
        toPlaceCached = result;
        return result;
    }

    /** Cells the body squeezes into (always empty in the base class; diagonal movements return the corner columns). */
    public List<BlockPos> toWalkInto(net.minecraft.world.level.BlockGetter level) {
        if (toWalkIntoCached == null) {
            toWalkIntoCached = new ArrayList<>();
        }
        return toWalkIntoCached;
    }

    public BlockPos getToPlace() {
        return positionToPlace;
    }

    /** Record whether dest's chunk was loaded when the cost was computed. */
    public void checkLoadedChunk(CalculationContext context) {
        calculatedWhileLoaded = context.isLoaded(dest.getX(), dest.getZ());
    }

    public boolean calculatedWhileLoaded() {
        return calculatedWhileLoaded;
    }
}
