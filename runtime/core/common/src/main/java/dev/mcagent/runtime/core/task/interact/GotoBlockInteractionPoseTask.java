package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.pathing.cache.EmbodiedNavView;
import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;
import dev.mcagent.runtime.core.pathing.util.BlockHelper;
import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSnapshot;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;
import net.minecraft.world.phys.BlockHitResult;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Navigates among frozen standable Feet Cells until the exact target hit resolves. */
public final class GotoBlockInteractionPoseTask
        extends AbstractBotTask<GotoBlockInteractionPoseTaskRecord> {

    private static final int EVIDENCE_RADIUS = 8;
    private static final double WALK_SPEED = 1.0;
    /** Extra deadline granted once when the search falls back to digging out an adjacent pose. */
    private static final long EXCAVATION_EXTRA_TICKS = 30L * 20L;

    private BlockEvidenceCell boundEvidence;
    private final List<BlockPos> candidates = new ArrayList<>();
    private final Set<BlockPos> protectedCells = new LinkedHashSet<>();
    private String failureType;
    private boolean verified;
    /** Ticks spent waiting for the body to settle on a resolved hit. */
    private int settleTicks;
    /** Standable poses are exhausted; the remaining candidates are dug-out adjacent poses. */
    private boolean excavating;
    /** A bucket targets a fluid or air cell, which has no outline of its own. */
    private boolean fluidTarget;

    public GotoBlockInteractionPoseTask(
            BotPlayer player, GotoBlockInteractionPoseTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(this::evidencePrecondition, this::itemPresentPrecondition);
    }

    private Precondition.Failure itemPresentPrecondition() {
        if (r.item == null || dev.mcagent.runtime.core.PlayerInv.findSlot(player.getInventory(), r.item) >= 0) {
            return null;
        }
        failureType = "item_not_found";
        return new Precondition.Failure("requested item is not carried", FailureType.UNKNOWN);
    }

    private Precondition.Failure evidencePrecondition() {
        String dimension = dimension();
        boundEvidence = RuntimeBotManager.knowledge(player.getServer())
                .blocks().cell(dimension, r.position);
        if (boundEvidence.state() != BlockEvidenceCell.State.KNOWN_BLOCK) {
            failureType = "target_not_known_block";
            return new Precondition.Failure(
                    "goto_block_interaction_pose requires an exact KNOWN_BLOCK target",
                    FailureType.UNKNOWN);
        }
        return null;
    }

    @Override
    protected void onStart() {
        protectedCells.add(r.position);
        BlockEvidenceSnapshot snapshot = RuntimeBotManager.knowledge(player.getServer())
                .blocks().snapshot(dimension(), r.position, EVIDENCE_RADIUS);
        EmbodiedNavView view = new EmbodiedNavView(
                snapshot, player.level().getMinBuildHeight(), player.level().getHeight());
        BlockState targetState = snapshot.knownState(r.position);
        if (targetState == null) return;
        fluidTarget = bucket() && (targetState.liquid() || targetState.isAir());
        // A bucket reaches a fluid or air cell through its surface or a neighbouring face, so
        // the whole cell bounds the reach search; the final probe decides which pose works.
        VoxelShape outline = fluidTarget ? Shapes.block()
                : targetState.getShape(view, r.position, CollisionContext.of(player));
        BlockPos originFeet = feet();
        List<BlockPos> frozen = InteractionPoseCandidates.freeze(
                r.position,
                originFeet,
                player.blockInteractionRange(),
                player.getEyeHeight(),
                outline,
                candidate -> standable(view, candidate)
                        && !candidate.equals(r.position) && !candidate.above().equals(r.position));
        List<BlockPos> clearOfLava = frozen.stream()
                .filter(candidate -> !besideHazard(view, candidate)).toList();
        candidates.addAll(fluidTarget && !clearOfLava.isEmpty() ? clearOfLava : frozen);
    }

    private boolean bucket() {
        return r.item == Items.BUCKET || r.item == Items.WATER_BUCKET || r.item == Items.LAVA_BUCKET;
    }

    /** Feet or head cell touches lava or another hazard, or the floor is one. */
    private static boolean besideHazard(EmbodiedNavView view, BlockPos feet) {
        if (BlockHelper.isHazard(view, feet.below())) return true;
        for (BlockPos cell : List.of(feet, feet.above())) {
            for (Direction side : Direction.Plane.HORIZONTAL) {
                if (BlockHelper.isHazard(view, cell.relative(side))) return true;
            }
        }
        return false;
    }

    @Override
    protected TaskState onTick() {
        PhysicalVerificationAuthority.Probe current = probe();
        if (current instanceof PhysicalVerificationAuthority.Ready) {
            if (VerifiedBlockInteraction.bodySettled(player)) {
                verified = true;
                return TaskState.SUCCESS;
            }
            // A hit that resolves mid-stride can drift out of view as momentum carries the
            // body on, so stop here and trust the probe only once the body is at rest.
            stopNav();
            if (++settleTicks <= VerifiedBlockInteraction.SETTLE_TICKS) return TaskState.RUNNING;
            return failed("the body did not come to rest where the hit resolved",
                    "no_interaction_pose");
        }
        settleTicks = 0;
        PhysicalVerificationAuthority.Failure currentFailure =
                ((PhysicalVerificationAuthority.Unavailable) current).failure();
        switch (currentFailure.code()) {
            case TARGET_CHANGED, ITEM_NOT_FOUND, NOT_FLUID_SOURCE, NO_SUPPORT -> {
                // No pose can fix these; moving would only waste the deadline.
                return failed(currentFailure.message(), currentFailure.code().wireValue());
            }
            default -> { }
        }
        if (candidates.isEmpty() && !beginExcavation()) {
            return failed("no verified interaction-reachable pose remains",
                    "no_interaction_pose");
        }
        if (nav == null) {
            nav = PlayerNav.to(player,
                    () -> GoalCompiler.interactionPoses(candidates, protectedCells),
                    WALK_SPEED, this::hasResolvedTargetHit);
        }

        return switch (nav.tick()) {
            case RUNNING -> TaskState.RUNNING;
            case ARRIVED -> {
                PhysicalVerificationAuthority.Probe resolution = probe();
                if (resolution instanceof PhysicalVerificationAuthority.Ready) {
                    // The next tick confirms the hit once the body has settled.
                    stopNav();
                    yield TaskState.RUNNING;
                }
                BlockPos blocker = ((PhysicalVerificationAuthority.Unavailable) resolution)
                        .failure().occludingBlock();
                if (blocker != null) {
                    protectedCells.add(blocker);
                }
                BlockPos arrived = feet();
                candidates.remove(arrived);
                candidates.remove(dev.mcagent.runtime.core.pathing.moves.Movement.pathStart(player));
                stopNav();
                if (candidates.isEmpty() && !beginExcavation()) {
                    yield failed("no verified interaction-reachable pose remains",
                            "no_interaction_pose");
                }
                yield TaskState.RUNNING;
            }
            case FAILED -> {
                stopNav();
                yield beginExcavation() ? TaskState.RUNNING
                        : failed("no verified interaction-reachable pose remains",
                                "no_interaction_pose");
            }
        };
    }

    /**
     * Once, after the standable poses fail: switch to the face-adjacent poses a player would
     * dig out to reach a buried target (mineflayer's dig-to-reach). Only the target stays
     * protected so the route may break through the earlier raycast blockers; floors must be
     * known blocks, and unknown or breakable feet and head cells are left to route BREAK.
     */
    private boolean beginExcavation() {
        // Digging beside a fluid cell would open it onto the route.
        if (excavating || fluidTarget) return false;
        excavating = true;
        BlockEvidenceSnapshot snapshot = RuntimeBotManager.knowledge(player.getServer())
                .blocks().snapshot(dimension(), r.position, EVIDENCE_RADIUS);
        EmbodiedNavView view = new EmbodiedNavView(
                snapshot, player.level().getMinBuildHeight(), player.level().getHeight());
        List<BlockPos> dig = InteractionPoseCandidates.excavation(
                r.position,
                feet(),
                floor -> view.isKnownBlock(floor) && BlockHelper.canWalkOn(view, floor),
                cell -> BlockHelper.canWalkThrough(view, cell)
                        || (view.isKnownBlock(cell) && BlockHelper.isBreakable(view, cell)
                        && !BlockHelper.isHazard(view, cell)));
        if (dig.isEmpty()) return false;
        candidates.clear();
        candidates.addAll(dig);
        protectedCells.clear();
        protectedCells.add(r.position);
        r.extendDeadlineTo(player.level().getGameTime() + EXCAVATION_EXTRA_TICKS);
        return true;
    }

    private boolean hasResolvedTargetHit() {
        return probe() instanceof PhysicalVerificationAuthority.Ready;
    }

    private PhysicalVerificationAuthority.Probe probe() {
        var bound = new PhysicalVerificationAuthority.BoundBlock(r.position, boundEvidence);
        return PhysicalVerificationAuthority.probe(player, r.item == null
                ? new PhysicalVerificationAuthority.Activate(bound)
                : new PhysicalVerificationAuthority.UseItemOn(bound, r.item));
    }

    private static boolean standable(EmbodiedNavView view, BlockPos feet) {
        return BlockHelper.canWalkThrough(view, feet)
                && BlockHelper.canWalkThrough(view, feet.above())
                && BlockHelper.canWalkOn(view, feet.below());
    }

    private BlockPos feet() {
        return BlockHelper.playerFeet(
                player.level(), player.getX(), player.getY(), player.getZ());
    }

    private TaskState failed(String message, String type) {
        failureType = type;
        fail(message, FailureType.NO_PATH);
        return TaskState.FAILED;
    }

    private String dimension() {
        return player.level().dimension().location().toString();
    }

    @Override
    protected Map<String, Object> resultData() {
        Map<String, Object> data = new HashMap<>();
        data.put("position", positionData(r.position));
        if (failureType != null) data.put("failure_type", failureType);
        if (verified) data.put("feet", positionData(feet()));
        return data;
    }

    private static Map<String, Object> positionData(BlockPos position) {
        return Map.of("x", position.getX(), "y", position.getY(), "z", position.getZ());
    }

    @Override
    protected String successMessage() {
        return "verified exact target hit from interaction-reachable pose";
    }

    @Override
    protected String cancelledMessage() {
        return "goto_block_interaction_pose interrupted";
    }
}
