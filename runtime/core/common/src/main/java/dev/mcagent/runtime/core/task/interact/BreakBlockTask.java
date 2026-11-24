package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.task.base.GoToThenDoTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Breaks one exact {@code KNOWN_BLOCK} without travelling. Physical Verification Authority owns the
 * live identity check, reach, native raycast, the held break and the outcome: the task ends when that
 * block is gone, and a different first hit fails without touching it.
 */
public final class BreakBlockTask extends GoToThenDoTask<BreakBlockTaskRecord> {
    private BlockEvidenceCell boundEvidence;
    private String failureType;
    // The native first-hit block at this Pose; reported only with an occluded failure.
    private Map<String, Object> occludingBlock;
    private List<Map<String, Object>> observedDropEntities = List.of();
    private boolean breakSucceeded;
    private PhysicalVerificationAuthority.Operation physicalOperation;

    public BreakBlockTask(BotPlayer player, BreakBlockTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(this::menuPrecondition, this::evidencePrecondition);
    }

    private Precondition.Failure menuPrecondition() {
        if (player.containerMenu == player.inventoryMenu) return null;
        failureType = "menu_open";
        return new Precondition.Failure("a block Menu is already open", FailureType.UNKNOWN);
    }

    private Precondition.Failure evidencePrecondition() {
        String dimension = player.level().dimension().location().toString();
        BlockEvidenceCell cell = RuntimeBotManager.knowledge(player.getServer())
                .blocks().cell(dimension, r.position);
        if (cell.state() != BlockEvidenceCell.State.KNOWN_BLOCK) {
            failureType = "target_not_known_block";
            return new Precondition.Failure(
                    "break_block requires an exact KNOWN_BLOCK position", FailureType.UNKNOWN);
        }
        boundEvidence = cell;
        return null;
    }

    @Override
    protected dev.mcagent.runtime.core.pathing.execute.PlayerNav buildNav() { return null; }

    @Override
    protected boolean reached() { return true; }

    @Override
    protected TaskState act() {
        if (physicalOperation == null) {
            physicalOperation = PhysicalVerificationAuthority.begin(player,
                    new PhysicalVerificationAuthority.Break(
                            new PhysicalVerificationAuthority.BoundBlock(
                                    r.position, boundEvidence), -1));
        }
        return switch (physicalOperation.tick()) {
            case PhysicalVerificationAuthority.Running ignored -> TaskState.RUNNING;
            case PhysicalVerificationAuthority.Failed failed -> {
                failureType = failed.failure().code().wireValue();
                if (failed.failure().occludingBlock() != null) {
                    net.minecraft.core.BlockPos blocker = failed.failure().occludingBlock();
                    occludingBlock = Map.of(
                            "position", Map.of("x", blocker.getX(), "y", blocker.getY(),
                                    "z", blocker.getZ()),
                            "block_state", PhysicalVerificationAuthority.liveBlockState(
                                    player, blocker));
                }
                fail(failed.failure().message(),
                        failed.failure().code()
                                == PhysicalVerificationAuthority.FailureCode.OUT_OF_REACH
                                ? FailureType.OUT_OF_REACH
                                : failed.failure().code()
                                == PhysicalVerificationAuthority.FailureCode.OCCLUDED
                                ? FailureType.OCCLUDED : FailureType.UNKNOWN);
                yield TaskState.FAILED;
            }
            case PhysicalVerificationAuthority.Succeeded succeeded -> {
                var broken = (PhysicalVerificationAuthority.BreakOutcome) succeeded.outcome();
                observedDropEntities = broken.drops().stream().map(item ->
                        Map.<String, Object>of(
                                "uuid", item.uuid().toString(),
                                "item_id", item.itemId(),
                                "count", item.itemCount())).toList();
                breakSucceeded = true;
                yield TaskState.SUCCESS;
            }
        };
    }

    @Override
    protected void cleanup() {
        if (physicalOperation != null) physicalOperation.cancel();
        super.cleanup();
    }

    @Override
    protected Map<String, Object> resultData() {
        Map<String, Object> data = new HashMap<>();
        data.put("position", Map.of(
                "x", r.position.getX(), "y", r.position.getY(), "z", r.position.getZ()));
        if (breakSucceeded) data.put("observed_drop_entities", observedDropEntities);
        if (failureType != null) data.put("failure_type", failureType);
        if ("occluded".equals(failureType) && occludingBlock != null) {
            data.put("occluding_block", occludingBlock);
        }
        return data;
    }

    @Override
    protected String successMessage() {
        return "verified exact target disappearance";
    }

    @Override
    protected String timeoutMessage() {
        return "timed out before breaking " + r.position.toShortString();
    }

    @Override
    protected String cancelledMessage() {
        return "break_block interrupted";
    }
}
