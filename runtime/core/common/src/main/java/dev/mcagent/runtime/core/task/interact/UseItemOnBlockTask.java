package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.PlayerInv;
import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.task.base.GoToThenDoTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Items;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** One evidence-bound item use whose physical lifecycle belongs to PVA. */
public final class UseItemOnBlockTask
        extends GoToThenDoTask<UseItemOnBlockTaskRecord> {
    private BlockEvidenceCell boundEvidence;
    private PhysicalVerificationAuthority.Operation operation;
    private Direction face;
    private String failureType;
    private String outcome;
    private String resultingBlockState;
    private BlockPos effectPosition;
    private String resultingItemId;
    private int consumedCount;
    private int durabilityUsed;
    private boolean dispatched;

    public UseItemOnBlockTask(BotPlayer player, UseItemOnBlockTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(this::menuPrecondition, this::evidencePrecondition,
                this::supportedItemPrecondition, this::itemPresentPrecondition);
    }

    private Precondition.Failure menuPrecondition() {
        if (player.containerMenu == player.inventoryMenu) return null;
        failureType = "menu_open";
        return failure("a block Menu is already open");
    }

    private Precondition.Failure evidencePrecondition() {
        String dimension = player.level().dimension().location().toString();
        boundEvidence = RuntimeBotManager.knowledge(player.getServer())
                .blocks().cell(dimension, r.position);
        if (boundEvidence.state() == BlockEvidenceCell.State.KNOWN_BLOCK) return null;
        failureType = "target_not_known_block";
        return failure("use_item_on_block requires an exact KNOWN_BLOCK target");
    }

    private Precondition.Failure supportedItemPrecondition() {
        if (r.item instanceof BlockItem) {
            failureType = "item_not_supported";
            return failure("BlockItems belong to place_block, not use_item_on_block");
        }
        String bodyBound = UseItemTaskRecord.unsupportedReason(r.item);
        if (bodyBound != null && r.item != Items.ENDER_EYE) {
            failureType = "item_not_supported";
            return failure(bodyBound);
        }
        return null;
    }

    private Precondition.Failure itemPresentPrecondition() {
        if (PlayerInv.findSlot(player.getInventory(), r.item) >= 0) return null;
        failureType = "item_not_found";
        return failure("requested item is not carried");
    }

    private static Precondition.Failure failure(String message) {
        return new Precondition.Failure(message, FailureType.UNKNOWN);
    }

    @Override protected PlayerNav buildNav() { return null; }
    @Override protected BlockPos gotoFirstTarget() { return r.position; }

    @Override
    protected boolean reached() {
        var probe = PhysicalVerificationAuthority.probe(player,
                new PhysicalVerificationAuthority.UseItemOn(
                        new PhysicalVerificationAuthority.BoundBlock(
                                r.position, boundEvidence), r.item));
        if (probe instanceof PhysicalVerificationAuthority.Unavailable unavailable
                && unavailable.failure().code()
                == PhysicalVerificationAuthority.FailureCode.OUT_OF_REACH) {
            failureType = "out_of_reach";
            return false;
        }
        return true;
    }

    @Override
    protected TaskState act() {
        if (operation == null) {
            operation = PhysicalVerificationAuthority.begin(player,
                    new PhysicalVerificationAuthority.UseItemOn(
                            new PhysicalVerificationAuthority.BoundBlock(
                                    r.position, boundEvidence), r.item));
        }
        return switch (operation.tick()) {
            case PhysicalVerificationAuthority.Running ignored -> {
                dispatched = true;
                yield TaskState.RUNNING;
            }
            case PhysicalVerificationAuthority.Failed failed -> failed(
                    failed.failure().message(), failed.failure().code().wireValue());
            case PhysicalVerificationAuthority.Succeeded succeeded -> {
                dispatched = true;
                var itemUse = (PhysicalVerificationAuthority.ItemUseOutcome)
                        succeeded.outcome();
                face = itemUse.face();
                outcome = itemUse.outcome();
                effectPosition = itemUse.effectPosition();
                resultingBlockState = itemUse.blockState();
                resultingItemId = itemUse.resultingItemId();
                consumedCount = itemUse.consumedCount();
                durabilityUsed = itemUse.durabilityUsed();
                yield TaskState.SUCCESS;
            }
        };
    }

    private TaskState failed(String message, String type) {
        failureType = type;
        fail(message, FailureType.UNKNOWN);
        return TaskState.FAILED;
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
        data.put("position", positionData(r.position));
        if (failureType != null) data.put("failure_type", failureType);
        if (face != null) data.put("face", face.getName());
        if (outcome != null || dispatched) {
            if (outcome != null) data.put("outcome", outcome);
            data.put("consumed_count", consumedCount);
            data.put("durability_used", durabilityUsed);
        }
        if (resultingItemId != null) data.put("resulting_item_id", resultingItemId);
        if (resultingBlockState != null && effectPosition != null) {
            data.put("effect_position", positionData(effectPosition));
            data.put("block_state", resultingBlockState);
        }
        return data;
    }

    private static Map<String, Object> positionData(BlockPos position) {
        return Map.of("x", position.getX(), "y", position.getY(), "z", position.getZ());
    }

    @Override protected String successMessage() { return "verified item use on block"; }
    @Override protected String cancelledMessage() { return "use_item_on_block interrupted"; }
}
