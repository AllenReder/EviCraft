package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.PlayerInv;
import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import net.minecraft.world.item.DoubleHighBlockItem;
import net.minecraft.world.level.block.DoorBlock;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** One exact placement whose complete physical lifecycle belongs to PVA. */
public final class PlaceBlockTask extends AbstractBotTask<PlaceBlockTaskRecord> {
    private BlockEvidenceCell targetEvidence;
    private PhysicalVerificationAuthority.Operation operation;
    private String failureType;
    /** Details of the occupying/occluding blocker (self/other/unknown), so callers can tell them apart. */
    private String occludingDetail;
    private String placedBlockState;
    private Integer consumedCount;
    private List<PhysicalVerificationAuthority.PlacedBlock> placedBlocks;

    public PlaceBlockTask(BotPlayer player, PlaceBlockTaskRecord record) {
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
        var knowledge = PlacementContextResolver.observePlacementBlocks(player, r.position);
        targetEvidence = knowledge.block(r.position);
        var refusal = PlacementContextResolver.refuseTarget(knowledge, r.position);
        if (refusal == null) return null;
        failureType = refusal.failureType();
        return failure(refusal.message());
    }

    private Precondition.Failure itemTypePrecondition() {
        if (r.blockItem == null) {
            failureType = "item_not_block";
            return failure("requested item is not a BlockItem");
        }
        if (r.blockItem instanceof DoubleHighBlockItem && !(r.blockItem.getBlock() instanceof DoorBlock)) {
            failureType = "multi_cell_item";
            return failure("only bed and door multi-cell placements are supported");
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
    protected TaskState onTick() {
        if (operation == null) {
            if (targetEvidence.state() == BlockEvidenceCell.State.UNKNOWN) {
                return failed("the target is not known yet; approach and observe it before placing",
                        "target_unknown");
            }
            operation = PhysicalVerificationAuthority.begin(player,
                    new PhysicalVerificationAuthority.Place(
                            new PhysicalVerificationAuthority.BoundBlock(
                                    r.position, targetEvidence), r.blockItem, r.item));
        }
        return switch (operation.tick()) {
            case PhysicalVerificationAuthority.Running ignored -> {
                captureVerifiedPlacement();
                yield TaskState.RUNNING;
            }
            case PhysicalVerificationAuthority.Failed failed -> {
                occludingDetail = failed.failure().occludingDetail();
                yield failed(failed.failure().message(), failed.failure().code().wireValue());
            }
            case PhysicalVerificationAuthority.Succeeded succeeded -> {
                var placement = (PhysicalVerificationAuthority.PlacementOutcome)
                        succeeded.outcome();
                placedBlockState = placement.blockState();
                consumedCount = placement.consumedCount();
                placedBlocks = placement.placedBlocks();
                yield TaskState.SUCCESS;
            }
        };
    }

    private TaskState failed(String message, String type) {
        captureVerifiedPlacement();
        failureType = type;
        fail(message, FailureType.UNKNOWN);
        return TaskState.FAILED;
    }

    private void captureVerifiedPlacement() {
        if (operation != null && operation.verifiedOutcome() instanceof PhysicalVerificationAuthority.PlacementOutcome placement) {
            placedBlockState = placement.blockState();
            consumedCount = placement.consumedCount();
            placedBlocks = placement.placedBlocks();
        }
    }

    @Override
    public void stop(BotPlayer bot, StopReason why) {
        try { super.stop(bot, why); }
        finally { if (operation != null) operation.cancel(); }
    }

    @Override
    protected void cleanup() {
        try { if (operation != null) operation.cancel(); }
        finally { super.cleanup(); }
    }

    @Override
    protected Map<String, Object> resultData() {
        Map<String, Object> data = new HashMap<>();
        data.put("item_id", r.itemId);
        data.put("position", Map.of("x", r.position.getX(), "y", r.position.getY(),
                "z", r.position.getZ()));
        if (failureType != null) data.put("failure_type", failureType);
        if ("target_occupied".equals(failureType) && targetEvidence != null
                && targetEvidence.blockState() != null) {
            data.put("target_block_state", targetEvidence.blockState());
        }
        if (occludingDetail != null) data.put("occluding_detail", occludingDetail);
        if (placedBlockState != null) data.put("block_state", placedBlockState);
        if (consumedCount != null) data.put("consumed_count", consumedCount);
        if (placedBlocks != null) data.put("placed_blocks", placedBlocks.stream().map(placed -> Map.of(
                "position", Map.of("x", placed.position().getX(), "y", placed.position().getY(), "z", placed.position().getZ()),
                "block_state", placed.blockState())).toList());
        return data;
    }

    @Override protected String successMessage() { return "verified exact block placement"; }
    @Override protected String cancelledMessage() { return "place_block interrupted"; }
}
