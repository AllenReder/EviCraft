package dev.mcagent.runtime.core.pathing.execute;
import dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials;
import dev.mcagent.runtime.core.pathing.moves.AimGeometry;

import java.util.EnumMap;
import java.util.function.Supplier;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.act.BlockDigger;
import dev.mcagent.runtime.core.pathing.moves.Input;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MovementState;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;

import net.minecraft.core.BlockPos;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Input/view application layer: applies each tick's movement-primitive output (desired view + key
 * table) to the server-side player entity.
 *
 * <p>Intents are recorded each tick; commit first submits the bound physical action, then advances
 * the view and movement input. Break/open/place are verified against the exact target by the PVA;
 * ordinary right clicks (buckets and the like) use the actual current view. Tool selection and
 * candidate aim points during preparation read execution knowledge and do not use the final physical
 * verification to scan terrain ahead of time.
 *
 * <p>The SPRINT key is deliberately not applied: the executor makes the overall sprint decision and
 * calls setSprinting directly. The key table persists across ticks and is cleared and reset by the
 * movement primitive every tick, so executor-forced keys survive until the next primitive update.
 */
public final class ExecHarness implements Movement.ExecutionDelegate {

    /** Hands tried for a right click, main hand first. */
    private static final InteractionHand[] HANDS = {InteractionHand.MAIN_HAND, InteractionHand.OFF_HAND};

    private final BotPlayer player;
    private final AimProcessor aim;
    private final BlockDigger digger;
    private final Supplier<CalculationContext> mutationContext;

    /** Key table for this tick (persists across ticks; the movement primitive resets it each tick). */
    private final EnumMap<Input, Boolean> keys = new EnumMap<>(Input.class);

    /** Desired view for this tick; invalid after commit. */
    private MovementState.MovementTarget target;

    /** Typed route mutation for this tick; invalid after commit. */
    private RouteMutation routeMutation;
    private RouteMutation activePhysicalMutation;
    private PhysicalVerificationAuthority.Operation physicalOperation;
    /** Movement that owns the current mutation (sole receiver of failure reports); set by PathExecutor. */
    private Movement currentFailureDelegate;
    /** Failure-report sink (tests may replace it to observe callbacks; production uses the movement). */
    private FailureSink failureSink = (movement, mutation, failure) ->
            movement.onRouteMutationFailed(mutation, failure);

    /** Failure-report sink, bypassed by cancellation paths; hooked only into commit's Failed branch. */
    @FunctionalInterface
    public interface FailureSink {
        void onFailure(Movement movement, RouteMutation mutation,
                PhysicalVerificationAuthority.Failure failure);
    }

    /** Ticks until the next right click is allowed. */
    private int rightClickCooldown;

    /** Whether anything recorded this tick is waiting to be applied. */
    private boolean dirty;

    public ExecHarness(BotPlayer player) {
        this(player, null);
    }

    public ExecHarness(BotPlayer player, Supplier<CalculationContext> mutationContext) {
        this.player = player;
        this.aim = new AimProcessor();
        this.digger = new BlockDigger(player);
        this.mutationContext = mutationContext;
    }

    // ==================== ExecutionDelegate hooks ====================

    /**
     * Starts breaking a block: find a visible aim point on it (shape center plus the six face centers,
     * each tested by ray) and set the view target there; the physical commit still breaks only this one
     * typed BREAK target. When the block is not visible at all, aim at its center and wait for a later
     * exact ray hit.
     */
    @Override
    public void applyRouteMutation(RouteMutation mutation) {
        dirty = true;
        if (!mutationAllowed(mutation)) {
            return;
        }
        routeMutation = mutation;
    }

    @Override
    public void prepareRouteMutation(MovementState state, RouteMutation mutation, BlockGetter world) {
        if (!mutationAllowed(mutation) || !(mutation instanceof RouteMutation.Break breaking)) {
            return;
        }
        BlockPos pos = breaking.target();
        // Pick the best tool for the typed BREAK target every tick.
        dev.mcagent.runtime.core.act.ToolSelect.holdBestTool(
                player, world.getBlockState(pos));
        Vec3 eye = player.getEyePosition();
        Vec3 aimPoint = AimGeometry.reachableAimPoint(player, world, pos);
        if (aimPoint != null) {
            MovementState.MovementTarget breakTarget = new MovementState.MovementTarget(
                    AimGeometry.yawTo(eye, aimPoint),
                    AimGeometry.pitchTo(eye, aimPoint), true);
            state.setTarget(breakTarget);
        } else {
            // Not visible at all: aim at the block center first; the commit side still requires an exact hit
            // on this target.
            Vec3 center = AimGeometry.blockCenter(pos);
            state.setTarget(new MovementState.MovementTarget(
                    AimGeometry.yawTo(eye, center),
                    AimGeometry.pitchTo(eye, center), true));
        }
    }

    @Override
    public void applyRotation(MovementState.MovementTarget target) {
        this.target = target;
        dirty = true;
    }

    @Override
    public void clearInputs() {
        keys.clear();
        routeMutation = null;
        dirty = true;
    }

    @Override
    public void applyInput(Input input, boolean held) {
        keys.put(input, held);
        dirty = true;
    }

    // ==================== Executor override surface ====================

    /** Whether a key is currently requested as held. */
    public boolean isKeyRequested(Input input) {
        return keys.getOrDefault(input, false);
    }

    /** Forces a key (executor sprint takeover, forced step-jump press, etc.). */
    public void forceKey(Input input, boolean held) {
        keys.put(input, held);
        dirty = true;
    }

    /**
     * Clears all keys and stops the body immediately (zero input fields, release sprint and sneak).
     * Used when a path is cancelled or paused; also cancels the active physical action.
     */
    public void clearAllKeys() {
        keys.clear();
        target = null;
        routeMutation = null;
        cancelPhysicalMutation();
        currentFailureDelegate = null;
        InputDriver.halt(player);
        player.setShiftKeyDown(false);
    }

    /**
     * Sets the movement that owns the current mutation; failure reports go only to it. Cleared on
     * cancel/advance.
     */
    public void setFailureDelegate(Movement movement) {
        currentFailureDelegate = movement;
    }

    /** Replaces the failure-report sink for tests; production never calls this (default: the movement). */
    public void setFailureSinkForTest(FailureSink sink) {
        failureSink = sink;
    }

    /** Test helper: restores the default failure-report sink (the movement). */
    public void resetFailureSink() {
        failureSink = (movement, mutation, failure) ->
                movement.onRouteMutationFailed(mutation, failure);
    }

    /** Aborts any in-progress digging (server-side ABORT plus clearing the crack overlay). */
    public void stopBreaking() {
        if (activePhysicalMutation instanceof RouteMutation.Break) cancelPhysicalMutation();
        digger.cancel();
    }

    /** Whether digging is in progress (liveness accounting: digging a hard block is real progress). */
    public boolean isDigging() {
        return digger.current() != null;
    }

    /** View-step quantizer (the executor reuses the same math for placement prediction). */
    public AimProcessor aimProcessor() {
        return aim;
    }

    // ==================== Commit ====================

    /** Commits once if anything is pending; otherwise only decrements cooldowns (they run on game ticks). */
    public void commitIfDirty() {
        if (dirty) {
            commit();
        } else {
            if (rightClickCooldown > 0) {
                rightClickCooldown--;
            }
            digger.tickCooldown();
        }
    }

    /**
     * Applies this tick's records to the entity. Order: left/right clicks (ray cast from the view applied
     * last tick; the click phase precedes this tick's turn) → view step (overrides the digger's
     * temporary look; the stepper owns the view) → movement input fields.
     */
    public void commit() {
        dirty = false;
        MovementState.MovementTarget t = target;
        target = null;
        RouteMutation mutation = routeMutation;
        routeMutation = null;
        // Sample the step origin before the click phase: the digger temporarily snaps the view to the
        // hit point, and the step must still start from the view applied last tick
        float startYaw = player.getYRot();
        float startPitch = player.getXRot();

        // Breaking wins: if left click is pressed this tick, right click is dropped
        if (mutation instanceof RouteMutation.Break) {
            keys.put(Input.CLICK_RIGHT, false);
        }
        // During cooldown only count down, never attempt. After it reaches zero, only a real click
        // attempt (crosshair on a block) restarts the cooldown: idle ticks with the crosshair not yet on
        // target do not consume it, and the first tick that hits clicks immediately
        if (rightClickCooldown > 0) {
            rightClickCooldown--;
        } else if (mutation instanceof RouteMutation.Open
                || mutation instanceof RouteMutation.Place) {
            tickPhysicalMutation(mutation);
        } else if (isKeyRequested(Input.CLICK_RIGHT)) {
            rightClickTick();
        }

        boolean digTicked = false;
        if (mutation instanceof RouteMutation.Break) {
            tickPhysicalMutation(mutation);
            digTicked = true;
        } else {
            if (activePhysicalMutation instanceof RouteMutation.Break) cancelPhysicalMutation();
            if (digger.current() != null) {
                digger.cancel();
            }
        }
        if (!digTicked) {
            // Post-break cooldown runs on game ticks; not frozen by misses or released keys
            digger.tickCooldown();
        }

        if (mutation == null && physicalOperation != null) cancelPhysicalMutation();

        if (t != null && t.hasRotation()) {
            AimProcessor.Rotation stepped = aim.step(startYaw, startPitch, t.getYaw(), t.getPitch());
            applyLook(stepped);
        }

        float forward = (isKeyRequested(Input.MOVE_FORWARD) ? 1.0f : 0.0f)
                + (isKeyRequested(Input.MOVE_BACK) ? -1.0f : 0.0f);
        float strafe = (isKeyRequested(Input.MOVE_LEFT) ? 1.0f : 0.0f)
                + (isKeyRequested(Input.MOVE_RIGHT) ? -1.0f : 0.0f);
        boolean sneak = isKeyRequested(Input.SNEAK);
        if (sneak) {
            // Sneak impulse multiplier comes from the attribute (base 0.3, raised by Swift Sneak)
            float sneakSpeed = (float) player.getAttributeValue(
                    net.minecraft.world.entity.ai.attributes.Attributes.SNEAKING_SPEED);
            forward *= sneakSpeed;
            strafe *= sneakSpeed;
        }
        // Keys are expressed <b>relative to the path direction</b> ("forward" = forward along this
        // segment), while vanilla travel projects zza/xxa onto player.yaw. When the two differ the input
        // must be remapped; that is why remapInput takes two yaws: body faces A, walks toward B.
        //
        // Passing the same yaw twice (identity) would assume body facing == path direction. That
        // usually holds because the view steps toward the path every tick, but breaks whenever something
        // <b>continuously</b> turns the face away: drawing a bow re-aims at the target every tick, so
        // "forward" would become "forward toward the target" and the Bot would walk into the mob.
        //
        // Segments with no rotation request (pure straight movement) remain the identity.
        float bodyYaw = player.getYRot();
        float pathYaw = t != null && t.hasRotation() ? t.getYaw() : bodyYaw;
        float[] impulse = AimProcessor.remapInput(strafe, forward, pathYaw, bodyYaw);
        player.xxa = impulse[0];
        player.zza = impulse[1];
        player.setShiftKeyDown(sneak);
        if (isKeyRequested(Input.JUMP)) {
            InputDriver.jump(player);
        }
    }

    private void applyLook(AimProcessor.Rotation rotation) {
        player.setYRot(rotation.yaw());
        player.setYHeadRot(rotation.yaw());
        player.setXRot(rotation.pitch());
    }

    // ==================== Right click ====================

    private void tickPhysicalMutation(RouteMutation mutation) {
        if (!mutationAllowed(mutation)) {
            cancelPhysicalMutation();
            return;
        }
        if (!mutation.equals(activePhysicalMutation)) {
            cancelPhysicalMutation();
            PhysicalVerificationAuthority.ExactBlockAction action = physicalAction(mutation);
            if (action == null) return;
            activePhysicalMutation = mutation;
            physicalOperation = PhysicalVerificationAuthority.begin(player, action);
        }
        PhysicalVerificationAuthority.Step step = physicalOperation.tick();
        if (step instanceof PhysicalVerificationAuthority.Failed failed) {
            // Failures must always be delivered: log them and hand the report to the movement that owns
            // the mutation for a bounded decision. Cancellation paths
            // (cancelPhysicalMutation/stopBreaking/clearAllKeys) bypass this branch, so spurious Failed
            // results caused by cancellation never reach that decision.
            Constants.LOG.info("[mc_agent-exec] mutation failed {} code={} msg={} blocker={}",
                    mutation, failed.failure().code(), failed.failure().message(),
                    failed.failure().occludingDetail());
            if (currentFailureDelegate != null) {
                failureSink.onFailure(currentFailureDelegate, mutation, failed.failure());
            }
            physicalOperation = null;
            activePhysicalMutation = null;
            return;
        }
        if (mutation instanceof RouteMutation.Open || mutation instanceof RouteMutation.Place) {
            rightClickCooldown = NavSettings.get().rightClickSpeed - 1;
        }
    }

    private PhysicalVerificationAuthority.ExactBlockAction physicalAction(RouteMutation mutation) {
        String dimension = player.level().dimension().location().toString();
        var evidence = dev.mcagent.runtime.bot.RuntimeBotManager.knowledge(player.getServer())
                .blocks().cell(dimension, mutation.target());
        if (evidence.state() == dev.mcagent.runtime.evidence.BlockEvidenceCell.State.UNKNOWN) {
            return null;
        }
        var target = new PhysicalVerificationAuthority.BoundBlock(mutation.target(), evidence);
        if (mutation instanceof RouteMutation.Open) {
            return new PhysicalVerificationAuthority.Activate(target);
        }
        if (mutation instanceof RouteMutation.Break) {
            return new PhysicalVerificationAuthority.Break(target, -1);
        }
        for (InteractionHand hand : HANDS) {
            ItemStack stack = player.getItemInHand(hand);
            if (stack.getItem() instanceof BlockItem blockItem) {
                return new PhysicalVerificationAuthority.Place(target, blockItem, stack.getItem());
            }
        }
        return null;
    }

    private void cancelPhysicalMutation() {
        if (physicalOperation != null) physicalOperation.cancel();
        physicalOperation = null;
        activePhysicalMutation = null;
    }

    /**
     * One right-click attempt: native raycast along the actual view. If no block is hit (or the Bot is
     * rowing), this tick does not count as an attempt (no cooldown). On a hit, start the cooldown and try
     * each hand, main hand first: useItemOn first (place/open/interact against the block); if not
     * consumed, fall back to useItem (non-block use; items that only override use(), such as emptying or
     * filling a water bucket, need this path). Stop at the first consumed action (swing only when
     * useItemOn consumed it).
     */
    private void rightClickTick() {
        if (player.getControlledVehicle() instanceof net.minecraft.world.entity.vehicle.Boat
                && (isKeyRequested(Input.MOVE_FORWARD) || isKeyRequested(Input.MOVE_BACK)
                        || isKeyRequested(Input.MOVE_LEFT) || isKeyRequested(Input.MOVE_RIGHT))) {
            return; // driving a boat with movement input this tick (hands on the oars): no right click;
                    // passengers or an idle driver may click
        }
        Level level = player.level();
        BlockHitResult hit = pickAlongView();
        if (hit == null) {
            return; // no block hit or blocked by an entity: no click into the air, no cooldown
        }
        if (!interactionTargetKnown(hit.getBlockPos())) {
            return;
        }
        rightClickCooldown = NavSettings.get().rightClickSpeed - 1;
        for (InteractionHand hand : HANDS) {
            ItemStack stack = player.getItemInHand(hand);
            if (player.gameMode.useItemOn(player, level, stack, hand, hit).consumesAction()) {
                player.swing(hand);
                return;
            }
            if (!stack.isEmpty()
                    && player.gameMode.useItem(player, level, stack, hand).consumesAction()) {
                return;
            }
        }
    }

    // ==================== Line of sight ====================

    /** Whether a ray along the actual view hits this block (entity occlusion counts as a miss). */
    public boolean isLookingAt(BlockPos pos) {
        BlockHitResult hit = pickAlongView();
        return hit != null && hit.getBlockPos().equals(pos);
    }

    /**
     * View pick: returns the hit when the block ray hits and no pickable entity lies between the eye and
     * the hit point; otherwise null (clicks are not applied on ticks when an entity blocks the view).
     */
    private BlockHitResult pickAlongView() {
        BlockHitResult hit = clipAlongView();
        if (hit.getType() != HitResult.Type.BLOCK) {
            return null;
        }
        Vec3 eye = player.getEyePosition();
        Vec3 end = hit.getLocation();
        var entityHit = net.minecraft.world.entity.projectile.ProjectileUtil.getEntityHitResult(
                player, eye, end, new net.minecraft.world.phys.AABB(eye, end).inflate(1.0),
                e -> !e.isSpectator() && e.isPickable(), end.distanceToSqr(eye));
        return entityHit == null ? hit : null;
    }

    private boolean mutationAllowed(RouteMutation mutation) {
        if (mutationContext == null) return true;
        CalculationContext context = mutationContext.get();
        if (!context.routeMutations.permits(mutation)) {
            return false;
        }
        if (!(context.view instanceof
                dev.mcagent.runtime.core.pathing.cache.SpeculativeWorldView evidence)) {
            return true;
        }
        return mutation instanceof RouteMutation.Place
                ? evidence.isKnown(mutation.target())
                : evidence.isKnownBlock(mutation.target());
    }

    private boolean interactionTargetKnown(BlockPos position) {
        if (mutationContext == null) return true;
        return interactionTargetKnown(mutationContext.get(), position);
    }

    private static boolean interactionTargetKnown(
            CalculationContext context, BlockPos position) {
        return !(context.view instanceof
                dev.mcagent.runtime.core.pathing.cache.SpeculativeWorldView evidence)
                || evidence.isKnownBlock(position);
    }

    /**
     * Whether the actual view matches the target angles (tolerance 0.01°; rarely true under quantization
     * residuals, so the ray test is the primary criterion).
     */
    public boolean isFacingTarget(MovementState.MovementTarget target) {
        if (!target.hasRotation()) {
            return false;
        }
        return Math.abs(AimProcessor.normalizeDelta(player.getYRot() - target.getYaw())) < 0.01
                && Math.abs(player.getXRot() - target.getPitch()) < 0.01;
    }

    /** Block currently under the crosshair; null on a miss or entity occlusion. */
    public BlockPos crosshairBlock() {
        BlockHitResult hit = pickAlongView();
        return hit != null ? hit.getBlockPos() : null;
    }

    /**
     * Outline ray along the entity's current view (fluids ignored); reach is 5.0 in creative, per
     * settings in survival.
     */
    private BlockHitResult clipAlongView() {
        Vec3 eye = player.getEyePosition();
        Vec3 end = eye.add(player.getViewVector(1.0f)
                .scale(AimGeometry.blockReachDistance(player)));
        return player.level().clip(new ClipContext(
                eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
    }

    // ==================== Hand swap / stocking ====================

    /**
     * Ensures a throwaway scaffold block is in the hotbar: no change if the hotbar already has one;
     * otherwise swap one from the main inventory into the selected slot, only if {@code allowInventory}
     * is enabled.
     */
    public boolean ensureThrowawayInHotbar() {
        var acceptable = ScaffoldMaterials.of(player);
        return ensureInHotbar(stack -> !stack.isEmpty() && acceptable.contains(stack.getItem()));
    }

    /**
     * Ensures a water bucket is in the hotbar (stocked before a water-bucket fall; the main inventory is
     * used only with allowInventory).
     */
    public boolean ensureWaterBucketInHotbar() {
        return ensureInHotbar(stack -> stack.is(Items.WATER_BUCKET));
    }

    private boolean ensureInHotbar(java.util.function.Predicate<ItemStack> what) {
        Inventory inv = player.getInventory();
        for (int i = 0; i < 9; i++) {
            if (what.test(inv.getItem(i))) {
                return true;
            }
        }
        if (!NavSettings.get().allowInventory) {
            return false;
        }
        for (int i = 9; i < inv.items.size(); i++) {
            if (what.test(inv.getItem(i))) {
                player.holdInHand(i);
                return true;
            }
        }
        return false;
    }
}
