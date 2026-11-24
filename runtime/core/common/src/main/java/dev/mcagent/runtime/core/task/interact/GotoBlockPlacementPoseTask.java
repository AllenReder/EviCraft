package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.PlayerInv;
import dev.mcagent.runtime.core.pathing.cache.EmbodiedNavView;
import dev.mcagent.runtime.core.pathing.calc.NavGoal;
import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.util.BlockHelper;
import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.evidence.BlockEvidenceSnapshot;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.item.BedItem;
import net.minecraft.world.item.DoubleHighBlockItem;
import net.minecraft.world.phys.shapes.Shapes;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Bounded navigation over current placement knowledge. It verifies one native-ready pose but
 * deliberately never performs the placement dispatch owned by {@link PlaceBlockTask}.
 */
public final class GotoBlockPlacementPoseTask
        extends AbstractBotTask<GotoBlockPlacementPoseTaskRecord> {

    private static final double WALK_SPEED = 1.0;

    private enum Phase { OBSERVING, POSITIONING }

    private Phase phase = Phase.OBSERVING;
    private BlockEvidenceSnapshot knowledge;
    private final List<PlacementContextResolver.Support> supports = new ArrayList<>();
    private final List<BlockPos> candidates = new ArrayList<>();
    private final Set<BlockPos> protectedCells = new LinkedHashSet<>();
    private final Set<BlockPos> rejectedPoses = new LinkedHashSet<>();
    private String failureType;
    private boolean verified;
    /** Ticks spent waiting for the body to settle on a resolved context. */
    private int settleTicks;
    private BodyState initialBody;

    public GotoBlockPlacementPoseTask(
            BotPlayer player, GotoBlockPlacementPoseTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(this::menuPrecondition, this::targetPrecondition,
                this::itemTypePrecondition, this::itemPresentPrecondition);
    }

    private Precondition.Failure menuPrecondition() {
        if (player.containerMenu == player.inventoryMenu) return null;
        failureType = "menu_open";
        return failure("a block Menu is already open");
    }

    private Precondition.Failure targetPrecondition() {
        var snapshot = PlacementContextResolver.observePlacementBlocks(player, r.position);
        var refusal = PlacementContextResolver.refuseTarget(snapshot, r.position);
        if (refusal == null) return null;
        failureType = refusal.failureType();
        return failure(refusal.message());
    }

    private Precondition.Failure itemTypePrecondition() {
        if (r.blockItem == null) {
            failureType = "item_not_block";
            return failure("requested item is not a BlockItem");
        }
        if (r.blockItem instanceof BedItem || r.blockItem instanceof DoubleHighBlockItem) {
            failureType = "multi_cell_item";
            return failure("requested BlockItem owns more than one cell");
        }
        return null;
    }

    private Precondition.Failure itemPresentPrecondition() {
        if (PlayerInv.findSlot(player.getInventory(), r.item) >= 0) return null;
        failureType = "item_not_found";
        return failure("requested BlockItem is not carried");
    }

    private static Precondition.Failure failure(String message) {
        return new Precondition.Failure(message, FailureType.UNKNOWN);
    }

    @Override
    protected void onStart() {
        initialBody = BodyState.capture(player);
        refreshKnowledge();
    }

    private PlacementContextResolver.TargetRefusal refreshKnowledge() {
        BlockEvidenceSnapshot previous = knowledge;
        knowledge = PlacementContextResolver.observePlacementBlocks(player, r.position);
        var refusal = PlacementContextResolver.refuseTarget(knowledge, r.position);
        if (refusal != null || previous != null
                && previous.contentVersion() == knowledge.contentVersion()) return refusal;
        EmbodiedNavView view = new EmbodiedNavView(
                knowledge, player.level().getMinBuildHeight(), player.level().getHeight());
        supports.clear();
        supports.addAll(PlacementContextResolver.knownSupports(knowledge, view, r.position));
        protectedCells.addAll(placementNavigationProtection(
                r.position, supports.stream().map(PlacementContextResolver.Support::position)
                        .toList()));
        if (phase == Phase.OBSERVING) {
            boolean hadCandidates = !candidates.isEmpty();
            candidates.clear();
            candidates.addAll(InteractionPoseCandidates.freeze(
                    r.position, feet(), player.blockInteractionRange(), player.getEyeHeight(),
                    Shapes.block(), candidate -> standable(view, candidate)));
            candidates.removeAll(rejectedPoses);
            if (!hadCandidates && !candidates.isEmpty()) stopNav();
            if (knowledge.isKnown(r.position) && !supports.isEmpty() && !candidates.isEmpty()) {
                phase = Phase.POSITIONING;
            }
        }
        return null;
    }

    static Set<BlockPos> placementNavigationProtection(
            BlockPos target, Iterable<BlockPos> supportPositions) {
        Set<BlockPos> protectedPositions = new LinkedHashSet<>();
        protectedPositions.add(target);
        for (BlockPos supportPosition : supportPositions) {
            protectedPositions.add(supportPosition);
        }
        return protectedPositions;
    }

    @Override
    protected TaskState onTick() {
        if (PlayerInv.findSlot(player.getInventory(), r.item) < 0) {
            return failed("requested BlockItem is no longer carried", "item_not_found");
        }

        var refusal = refreshKnowledge();
        if (refusal != null) return failed(refusal.message(), refusal.failureType());
        if (supports.isEmpty() && Arrays.stream(Direction.values())
                .allMatch(direction -> knowledge.isKnown(r.position.relative(direction)))) {
            return failed("no known neighboring placement support remains", "no_support");
        }

        PhysicalVerificationAuthority.Probe resolution = probeKnownPlacement();
        if (resolution instanceof PhysicalVerificationAuthority.Ready) {
            if (VerifiedBlockInteraction.bodySettled(player)) {
                verified = true;
                return TaskState.SUCCESS;
            }
            // A context that resolves mid-stride can drift out of view as momentum carries
            // the body on, so stop here and trust the probe only once the body is at rest.
            stopNav();
            if (++settleTicks <= VerifiedBlockInteraction.SETTLE_TICKS) return TaskState.RUNNING;
            return failed("the body did not come to rest where the placement context resolved",
                    "no_placement_pose");
        }
        settleTicks = 0;
        protectBlockers(resolution);
        if (resolution instanceof PhysicalVerificationAuthority.Unavailable unavailable) {
            var code = unavailable.failure().code();
            if (code == PhysicalVerificationAuthority.FailureCode.NO_SUPPORT
                    || code == PhysicalVerificationAuthority.FailureCode.TARGET_CHANGED) {
                return failed(unavailable.failure().message(), code.wireValue());
            }
        }

        if (nav == null) {
            nav = PlayerNav.to(player, () -> {
                if (!candidates.isEmpty()) return GoalCompiler.interactionPoses(candidates, protectedCells);
                LongOpenHashSet sacred = new LongOpenHashSet();
                for (BlockPos position : protectedCells) sacred.add(position.asLong());
                return new GoalCompiler.Compiled(NavGoal.adjacent(r.position), sacred);
            },
                    WALK_SPEED, this::hasReadyPlacementContext);
        }

        return switch (nav.tick()) {
            case RUNNING -> TaskState.RUNNING;
            case ARRIVED -> {
                PhysicalVerificationAuthority.Probe arrived = probeKnownPlacement();
                if (arrived instanceof PhysicalVerificationAuthority.Ready) {
                    // The next tick confirms the context once the body has settled.
                    stopNav();
                    yield TaskState.RUNNING;
                }
                protectBlockers(arrived);
                if (candidates.isEmpty()) yield noPlacementPose();
                rejectedPoses.add(feet());
                rejectedPoses.add(Movement.pathStart(player));
                candidates.remove(feet());
                candidates.remove(Movement.pathStart(player));
                stopNav();
                yield candidates.isEmpty() ? noPlacementPose() : TaskState.RUNNING;
            }
            case FAILED -> noPlacementPose();
        };
    }

    private boolean hasReadyPlacementContext() {
        PhysicalVerificationAuthority.Probe resolution = probeKnownPlacement();
        protectBlockers(resolution);
        return resolution instanceof PhysicalVerificationAuthority.Ready;
    }

    private PhysicalVerificationAuthority.Probe probeKnownPlacement() {
        if (!knowledge.isKnown(r.position) || supports.isEmpty()
                || PlayerInv.findSlot(player.getInventory(), r.item) < 0) {
            return null;
        }
        return PhysicalVerificationAuthority.probe(player,
                new PhysicalVerificationAuthority.Place(
                        new PhysicalVerificationAuthority.BoundBlock(r.position, knowledge.block(r.position)),
                        r.blockItem, r.item));
    }

    private void protectBlockers(PhysicalVerificationAuthority.Probe probe) {
        if (probe instanceof PhysicalVerificationAuthority.Unavailable unavailable
                && unavailable.failure().occludingBlock() != null) {
            protectedCells.add(unavailable.failure().occludingBlock());
        }
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

    private TaskState noPlacementPose() {
        return failed("no verified placement-reachable pose remains", "no_placement_pose");
    }

    private TaskState failed(String message, String type) {
        failureType = type;
        fail(message, FailureType.NO_PATH);
        return TaskState.FAILED;
    }

    @Override
    protected void cleanup() {
        try {
            super.cleanup();
        } finally {
            if (initialBody != null) initialBody.restore(player);
        }
    }

    @Override
    protected Map<String, Object> resultData() {
        Map<String, Object> data = new HashMap<>();
        data.put("item_id", r.itemId);
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
        return "verified item-specific placement context from placement-reachable pose";
    }

    @Override
    protected String cancelledMessage() {
        return "goto_block_placement_pose interrupted";
    }

    private record BodyState(float yaw, float pitch, float headYaw, boolean sneaking) {
        private static BodyState capture(BotPlayer player) {
            return new BodyState(player.getYRot(), player.getXRot(), player.getYHeadRot(),
                    player.isShiftKeyDown());
        }

        private void restore(BotPlayer player) {
            player.setYRot(yaw);
            player.setXRot(pitch);
            player.setYHeadRot(headYaw);
            player.setShiftKeyDown(sneaking);
        }
    }
}
