package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.act.Interaction;
import dev.mcagent.runtime.core.pathing.cache.EmbodiedNavView;
import dev.mcagent.runtime.core.pathing.cache.ExecutionWorldView;
import dev.mcagent.runtime.core.pathing.util.BlockHelper;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSnapshot;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.BedItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * Resolves one exact native placement, including the foot/head or lower/upper footprint.
 *
 * <p>This is deliberately the whole seam: callers hand it an already-held requested stack and
 * receive either one native-ready support hit or the reason that no such hit exists. It owns the
 * support evidence walk, vanilla placement prediction, collision, native reach/ray checks, and
 * deterministic candidate choice; it never dispatches a placement.
 */
final class PlacementContextResolver {
    private PlacementContextResolver() {}

    sealed interface Resolution permits Ready, Unavailable {}

    /** A context that can be handed directly to one exact-hand native placement dispatch. */
    record Ready(BlockHitResult hit, List<PlacedCell> cells)
            implements Resolution {}

    record PlacedCell(BlockPos position, BlockState state) {}

    record Unavailable(Reason reason, String detail, List<Blocker> blockers) implements Resolution {
        Unavailable {
            blockers = List.copyOf(blockers);
        }

        String message() {
            return reason.message(detail);
        }
    }

    /** Stable internal classifications, each mapped to one Tool-facing failure type. */
    enum Reason {
        SECOND_CELL_NOT_FREE("the bed head or door upper cell must be known air or a known replaceable block"),
        TARGET_CHANGED("a bound placement cell changed before dispatch"),
        UNSUPPORTED_SHAPE("no support has a resolvable block outline"),
        NO_SUPPORT("no evidence-backed neighboring support accepts this BlockItem"),
        BODY_IN_TARGET("the bot's own body occupies the target placement volume; stand outside that cell"),
        ENTITY_BLOCKED("an entity blocks the target placement volume"),
        OUT_OF_REACH("all viable support hit points are outside native reach"),
        OCCLUDED("all viable support hit points are occluded"),
        NO_VIABLE_SUPPORT("no viable placement support remained");

        private final String defaultMessage;

        Reason(String defaultMessage) {
            this.defaultMessage = defaultMessage;
        }

        private String message(String detail) {
            return this == UNSUPPORTED_SHAPE && detail != null
                    ? "the support outline cannot be resolved safely: " + detail
                    : defaultMessage;
        }
    }

    /** One eligible evidence-backed support face. */
    record Support(BlockPos position, Direction face, BlockEvidenceCell evidence) {
        Support {
            position = position.immutable();
            Objects.requireNonNull(face, "face");
            Objects.requireNonNull(evidence, "evidence");
        }
    }

    /** A target-volume collision or native-ray first hit encountered during resolution. */
    record Blocker(String kind, BlockPos position, Vec3 location) {
        Blocker {
            if (position != null) position = position.immutable();
        }
    }

    /**
     * A known block that vanilla placement replaces in place: water, lava, short grass, fern,
     * vines, snow layers, fire. Air is handled separately as the ordinary placement target.
     */
    static boolean replaceable(BlockState state) {
        return !state.isAir() && state.canBeReplaced();
    }

    /** Why an exact placement target was refused before any physical work. */
    record TargetRefusal(String failureType, String message) {}

    /** UNKNOWN may be approached; only actual knowledge can refuse the target. */
    static TargetRefusal refuseTarget(BlockEvidenceSnapshot knowledge, BlockPos target) {
        BlockState state = knowledge.knownState(target);
        return state == null || state.isAir() || replaceable(state) ? null
                : new TargetRefusal("target_occupied", "the exact target is known to hold "
                        + knowledge.block(target).blockState()
                        + ", which a placement cannot replace; break it first or choose another cell");
    }

    /** Publish permitted body contact before capturing the placement's knowledge. */
    static BlockEvidenceSnapshot observePlacementBlocks(BotPlayer player, BlockPos target) {
        String dimension = player.level().dimension().location().toString();
        var blocks = RuntimeBotManager.knowledge(player.getServer()).blocks();
        BlockEvidenceSnapshot snapshot = blocks.snapshot(dimension, target, 8);
        List<PhysicalVerificationAuthority.BlockOutcome> contact = new ArrayList<>();
        List<BlockPos> cells = new ArrayList<>();
        cells.add(target);
        for (Direction direction : Direction.values()) cells.add(target.relative(direction));
        for (BlockPos position : cells) {
            if (!ExecutionWorldView.bodyAdjacent(player.blockPosition(), position)) continue;
            BlockState live = player.level().getBlockState(position);
            if (!snapshot.block(position).matches(live)) {
                contact.add(new PhysicalVerificationAuthority.BlockOutcome(
                        position, live, BlockEvidenceSource.MISMATCH));
            }
        }
        if (!contact.isEmpty()) {
            PhysicalVerificationAuthority.publishBlockOutcomes(player.getServer(), dimension,
                    player.getServer().getTickCount(), contact);
            snapshot = blocks.snapshot(dimension, target, 8);
        }
        return snapshot;
    }

    /**
     * A replaceable target is its own click target in vanilla (the placement context replaces
     * the clicked cell). The face is resolved at dispatch from the target's visible outline.
     */
    private static Support selfSupport(BlockPos target, BlockEvidenceCell evidence) {
        return new Support(target, Direction.UP, evidence);
    }

    private static boolean isSelfSupport(Support support, BlockPos target) {
        return support.position().equals(target);
    }

    static List<Support> knownSupports(
            BlockEvidenceSnapshot knowledge, BlockGetter view, BlockPos target) {
        List<Support> supports = new ArrayList<>();
        for (Direction face : VerifiedBlockInteraction.orderedFaces()) {
            BlockPos supportPosition = target.relative(face.getOpposite());
            BlockEvidenceCell support = knowledge.block(supportPosition);
            if (support.state() != BlockEvidenceCell.State.KNOWN_BLOCK) continue;
            if (!BlockHelper.canPlaceAgainst(view, supportPosition, face)) continue;
            supports.add(new Support(supportPosition, face, support));
        }
        BlockEvidenceCell targetCell = knowledge.block(target);
        if (targetCell.state() == BlockEvidenceCell.State.KNOWN_BLOCK
                && replaceable(view.getBlockState(target))) {
            supports.add(selfSupport(target, targetCell));
        }
        return List.copyOf(supports);
    }

    static Resolution resolve(BotPlayer player, PhysicalVerificationAuthority.BoundBlock target, BlockItem blockItem,
                              ItemStack heldStack) {
        ViewState view = ViewState.capture(player);
        try {
            BlockEvidenceSnapshot snapshot = observePlacementBlocks(player, target.position());
            EmbodiedNavView blocks = new EmbodiedNavView(snapshot,
                    player.level().getMinBuildHeight(), player.level().getHeight());
            List<Support> supports = knownSupports(snapshot, blocks, target.position());
            return resolveAtCurrentPose(player, target, blockItem, heldStack, supports, blocks);
        } finally {
            // Resolution probes must not leave a failed or ready probe aiming somewhere else.
            view.restore(player);
        }
    }

    private static Resolution resolveAtCurrentPose(BotPlayer player, PhysicalVerificationAuthority.BoundBlock bound,
                                                   BlockItem blockItem, ItemStack heldStack,
                                                   List<Support> knownSupports, BlockGetter blocks) {
        BlockPos target = bound.position();
        Vec3 eye = player.getEyePosition();
        double reachSquared = Math.pow(player.blockInteractionRange(), 2);
        List<Candidate> candidates = new ArrayList<>();
        List<Support> supports = new ArrayList<>();
        List<Blocker> blockers = new ArrayList<>();
        boolean supportSeen = false;
        boolean entityBlocked = false;
        boolean reachable = false;
        boolean visible = false;
        boolean unsupportedShape = false;
        boolean resolvableSupport = false;
        Reason footprintFailure = null;
        Support selfSupport = null;

        for (Support support : knownSupports) {
            if (isSelfSupport(support, target)) {
                selfSupport = support;
                continue;
            }
            BlockPos supportPosition = support.position();
            Direction face = support.face();
            supportSeen = true;
            supports.add(support);
            Vec3 hitPoint = VerifiedBlockInteraction.faceCenter(supportPosition, face);
            if (eye.distanceToSqr(hitPoint) > reachSquared) continue;
            reachable = true;
            Vec3 clipEnd = hitPoint.add(
                    face.getStepX() * -1.0E-4,
                    face.getStepY() * -1.0E-4,
                    face.getStepZ() * -1.0E-4);
            InputDriver.lookAt(player, clipEnd);
            HitResult nativeHit = Interaction.nativeRaytrace(player, player.blockInteractionRange());
            if (targetChangedAtHit(player, bound, nativeHit)) {
                return new Unavailable(Reason.TARGET_CHANGED, null, blockers);
            }
            if (!(nativeHit instanceof BlockHitResult clipped)
                    || !clipped.getBlockPos().equals(supportPosition)
                    || clipped.getDirection() != face) {
                addRayBlocker(blockers, nativeHit);
                continue;
            }
            visible = true;
            // State such as a door hinge depends on the native hit coordinate, including which
            // side of a cell's midpoint it lands on. Predict from the exact hit we will dispatch.
            HitEvaluation nativeEvaluation = evaluateHit(player, bound, blockItem, heldStack,
                    clipped, hitPoint, support, blockers);
            entityBlocked |= nativeEvaluation.entityBlocked();
            if (nativeEvaluation.failure() != null) footprintFailure = nativeEvaluation.failure();
            if (nativeEvaluation.candidate() != null) candidates.add(nativeEvaluation.candidate());
        }

        if (selfSupport != null) {
            supportSeen = true;
            supports.add(selfSupport);
            BlockHitResolver.Resolution resolved = BlockHitResolver.resolveSupportHit(
                    player, blocks, target, null, new BlockHitResolver.Budget());
            if (resolved.hit() != null) {
                reachable = true;
                visible = true;
                resolvableSupport = true;
                HitEvaluation evaluation = evaluateHit(player, bound, blockItem, heldStack,
                        resolved.hit(), resolved.hit().getLocation(), selfSupport, blockers);
                entityBlocked |= evaluation.entityBlocked();
                if (evaluation.failure() != null) footprintFailure = evaluation.failure();
                if (evaluation.candidate() != null) candidates.add(evaluation.candidate());
            } else if (resolved.failure() == BlockHitResolver.Failure.OCCLUDED) {
                reachable = true;
                resolvableSupport = true;
                addRayBlocker(blockers, resolved.blocker());
            }
            // Fluids have no outline to click; their neighboring supports own the placement.
        }

        if (candidates.isEmpty() && supportSeen && !entityBlocked) {
            BlockHitResolver.Budget budget = new BlockHitResolver.Budget();
            for (Support support : supports) {
                if (isSelfSupport(support, target)) continue;
                BlockHitResolver.Resolution resolved = BlockHitResolver.resolveSupportHit(
                        player, blocks, support.position(), support.face(), budget);
                if (targetChangedAtHit(player, bound, resolved.blocker())) {
                    return new Unavailable(Reason.TARGET_CHANGED, null, blockers);
                }
                if (resolved.failure() == BlockHitResolver.Failure.UNSUPPORTED_SHAPE) {
                    if ("candidate_budget_exhausted".equals(resolved.detail())) {
                        return new Unavailable(Reason.UNSUPPORTED_SHAPE, resolved.detail(), blockers);
                    }
                    unsupportedShape = true;
                    continue;
                }
                resolvableSupport = true;
                if (resolved.hit() == null) {
                    if (resolved.failure() == BlockHitResolver.Failure.OCCLUDED) {
                        reachable = true;
                        addRayBlocker(blockers, resolved.blocker());
                    }
                    continue;
                }
                reachable = true;
                visible = true;
                HitEvaluation evaluation = evaluateHit(player, bound, blockItem, heldStack,
                        resolved.hit(), resolved.hit().getLocation(), support, blockers);
                entityBlocked |= evaluation.entityBlocked();
                if (evaluation.failure() != null) footprintFailure = evaluation.failure();
                if (evaluation.candidate() != null) candidates.add(evaluation.candidate());
            }
        }

        if (candidates.isEmpty()) {
            Reason reason;
            if (footprintFailure != null) {
                reason = footprintFailure;
            } else if (unsupportedShape && !resolvableSupport) {
                reason = Reason.UNSUPPORTED_SHAPE;
            } else if (!supportSeen) {
                reason = Reason.NO_SUPPORT;
            } else if (entityBlocked) {
                reason = onlyBodyBlocks(blockers) ? Reason.BODY_IN_TARGET : Reason.ENTITY_BLOCKED;
            } else if (!reachable) {
                reason = Reason.OUT_OF_REACH;
            } else if (!visible) {
                reason = Reason.OCCLUDED;
            } else {
                reason = Reason.NO_VIABLE_SUPPORT;
            }
            return new Unavailable(reason, null, blockers);
        }

        Candidate selected = candidates.stream().min(Comparator
                        .comparingDouble((Candidate value) -> eye.distanceToSqr(value.selectionPoint()))
                        .thenComparingInt(value -> VerifiedBlockInteraction.faceRank(
                                value.hit().getDirection())))
                .orElseThrow();
        return new Ready(selected.hit(), selected.cells());
    }

    private static boolean onlyBodyBlocks(List<Blocker> blockers) {
        List<Blocker> volume = blockers.stream()
                .filter(blocker -> blocker.kind().startsWith("target_volume_")).toList();
        return !volume.isEmpty() && volume.stream()
                .allMatch(blocker -> SELF_VOLUME.equals(blocker.kind()));
    }

    private static final String SELF_VOLUME = "target_volume_self";

    private static boolean collisionBlocks(BotPlayer player, BlockPos target,
                                           BlockState candidate, List<Blocker> blockers) {
        if (candidate == null || player.level().isUnobstructed(
                candidate, target, CollisionContext.of(player))) {
            return false;
        }
        blockers.add(new Blocker(volumeCollisionKind(player, target, candidate),
                target, Vec3.atCenterOf(target)));
        return true;
    }

    /**
     * Name the occupant of a blocked target volume: the bot's own body, another entity (with its
     * type), or an indeterminate obstruction. The bot's own bounding box is compared directly
     * against the predicted collision shape, so standing in the cell is never reported as an
     * unknown occupant.
     */
    private static String volumeCollisionKind(BotPlayer player, BlockPos target,
                                              BlockState candidate) {
        var shape = candidate.getCollisionShape(player.level(), target, CollisionContext.of(player))
                .move(target.getX(), target.getY(), target.getZ());
        if (shape.isEmpty()) return "target_volume_unknown";
        var body = player.getBoundingBox();
        for (var box : shape.toAabbs()) {
            if (box.intersects(body)) return SELF_VOLUME;
        }
        var entities = player.level().getEntities(player, shape.bounds(),
                e -> !e.isSpectator() && !e.isRemoved() && e.blocksBuilding);
        if (!entities.isEmpty()) {
            var type = net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE
                    .getKey(entities.get(0).getType());
            return "target_volume_other:" + type;
        }
        return "target_volume_unknown";
    }

    private static void addRayBlocker(List<Blocker> blockers, HitResult hit) {
        if (hit == null || hit.getType() == HitResult.Type.MISS) return;
        BlockPos position = hit instanceof BlockHitResult block ? block.getBlockPos() : null;
        // Entity hits carry the entity type: "native_ray_entity" alone cannot tell a dropped item from a mob
        // or anything else, and that decides the recovery strategy (wait for it to leave vs. go around).
        String kind = "native_ray_" + hit.getType().name().toLowerCase();
        if (hit instanceof net.minecraft.world.phys.EntityHitResult entityHit) {
            kind += ":" + net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE
                    .getKey(entityHit.getEntity().getType());
        }
        blockers.add(new Blocker(kind, position, hit.getLocation()));
    }

    private static boolean targetChangedAtHit(BotPlayer player,
            PhysicalVerificationAuthority.BoundBlock target, HitResult hit) {
        if (!(hit instanceof BlockHitResult block) || hit.getType() != HitResult.Type.BLOCK
                || !block.getBlockPos().equals(target.position())) return false;
        BlockState actual = player.level().getBlockState(target.position());
        if (target.evidence().matches(actual)) return false;
        record(player, target.position(), actual, BlockEvidenceSource.MISMATCH);
        return true;
    }

    /** Evaluate prediction and target-volume collision after a native support hit. */
    private static HitEvaluation evaluateHit(BotPlayer player, PhysicalVerificationAuthority.BoundBlock bound,
                                             BlockItem blockItem, ItemStack heldStack,
                                             BlockHitResult hit, Vec3 selectionPoint,
                                             Support support, List<Blocker> blockers) {
        BlockPos target = bound.position();
        BlockState actual = player.level().getBlockState(target);
        if (!bound.evidence().matches(actual)) {
            record(player, target, actual, BlockEvidenceSource.MISMATCH);
            return new HitEvaluation(null, false, Reason.TARGET_CHANGED);
        }
        BlockState supportState = player.level().getBlockState(support.position());
        if (!support.evidence().matches(supportState)) {
            record(player, support.position(), supportState, BlockEvidenceSource.MISMATCH);
            return new HitEvaluation(null, false, Reason.NO_SUPPORT);
        }
        PlacementPrediction prediction = predictedState(player, target, blockItem, heldStack, hit);
        if (prediction == null) return new HitEvaluation(null, false, null);
        if (prediction.failure() != null) {
            return new HitEvaluation(null, false, prediction.failure());
        }
        BlockState predicted = prediction.vanillaState();
        if (predicted == null) {
            return new HitEvaluation(null,
                    collisionBlocks(player, target, prediction.baseState(), blockers), null);
        }
        List<PlacedCell> cells = placementCells(target, predicted);
        for (PlacedCell cell : cells) {
            if (collisionBlocks(player, cell.position(), cell.state(), blockers)) {
                return new HitEvaluation(null, true, null);
            }
        }
        return new HitEvaluation(new Candidate(hit, selectionPoint, cells), false, null);
    }

    private static PlacementPrediction predictedState(BotPlayer player, BlockPos target,
                                                      BlockItem blockItem, ItemStack heldStack,
                                                      BlockHitResult hit) {
        ViewState view = ViewState.capture(player);
        try {
            InputDriver.lookAt(player, hit.getLocation());
            BlockPlaceContext initial = new BlockPlaceContext(new UseOnContext(
                    player.level(), player, InteractionHand.MAIN_HAND, heldStack, hit) {});
            if (!initial.canPlace()) return null;
            BlockPlaceContext context = blockItem.updatePlacementContext(initial);
            if (context == null || !context.getClickedPos().equals(target)) return null;
            BlockPos secondary = blockItem instanceof BedItem
                    ? target.relative(context.getHorizontalDirection())
                    : blockItem.getBlock() instanceof DoorBlock ? target.above() : null;
            if (secondary != null) {
                BlockEvidenceCell known = evidence(player, secondary);
                if (known.state() != BlockEvidenceCell.State.KNOWN_AIR
                        && known.state() != BlockEvidenceCell.State.KNOWN_BLOCK) {
                    return new PlacementPrediction(null, null, Reason.SECOND_CELL_NOT_FREE);
                }
                BlockState actual = player.level().getBlockState(secondary);
                if (!known.matches(actual)) {
                    record(player, secondary, actual, BlockEvidenceSource.MISMATCH);
                    return new PlacementPrediction(null, null, Reason.TARGET_CHANGED);
                }
                if (known.state() == BlockEvidenceCell.State.KNOWN_BLOCK && !replaceable(actual)) {
                    return new PlacementPrediction(null, null, Reason.SECOND_CELL_NOT_FREE);
                }
            }
            if (blockItem.getBlock() instanceof DoorBlock) {
                // Door survival relies on the floor even when the clicked support is a side wall.
                BlockPos floor = target.below();
                BlockEvidenceCell known = evidence(player, floor);
                if (known.state() != BlockEvidenceCell.State.KNOWN_BLOCK) {
                    return new PlacementPrediction(null, null, Reason.NO_SUPPORT);
                }
                BlockState actual = player.level().getBlockState(floor);
                if (!known.matches(actual)) {
                    record(player, floor, actual, BlockEvidenceSource.MISMATCH);
                    return new PlacementPrediction(null, null, Reason.NO_SUPPORT);
                }
            }
            BlockState baseState = blockItem.getBlock().getStateForPlacement(context);
            if (baseState != null && !baseState.canSurvive(player.level(), target)) {
                baseState = null;
            }
            return new PlacementPrediction(blockItem.getPlacementState(context), baseState, null);
        } catch (RuntimeException ignored) {
            return null;
        } finally {
            view.restore(player);
        }
    }

    private static List<PlacedCell> placementCells(BlockPos target, BlockState state) {
        PlacedCell anchor = new PlacedCell(target, state);
        if (state.getBlock() instanceof BedBlock) {
            return List.of(anchor, new PlacedCell(target.relative(state.getValue(BedBlock.FACING)),
                    state.setValue(BedBlock.PART, BedPart.HEAD)));
        }
        if (state.getBlock() instanceof DoorBlock) {
            return List.of(anchor, new PlacedCell(target.above(),
                    state.setValue(DoorBlock.HALF, DoubleBlockHalf.UPPER)));
        }
        return List.of(anchor);
    }

    private static BlockEvidenceCell evidence(BotPlayer player, BlockPos position) {
        String dimension = player.level().dimension().location().toString();
        return RuntimeBotManager.knowledge(player.getServer())
                .blocks().cell(dimension, position);
    }

    private static void record(BotPlayer player, BlockPos position, BlockState state,
                               BlockEvidenceSource source) {
        PhysicalVerificationAuthority.publishBlockOutcome(player.getServer(),
                player.level().dimension().location().toString(), player.level().getGameTime(),
                position, state, source);
    }

    private record Candidate(BlockHitResult hit, Vec3 selectionPoint, List<PlacedCell> cells) {}

    private record HitEvaluation(Candidate candidate, boolean entityBlocked, Reason failure) {}

    private record PlacementPrediction(BlockState vanillaState, BlockState baseState, Reason failure) {}

    private record ViewState(float yaw, float pitch, float headYaw) {
        private static ViewState capture(BotPlayer player) {
            return new ViewState(player.getYRot(), player.getXRot(), player.getYHeadRot());
        }

        private void restore(BotPlayer player) {
            player.setYRot(yaw);
            player.setXRot(pitch);
            player.setYHeadRot(headYaw);
        }
    }
}
