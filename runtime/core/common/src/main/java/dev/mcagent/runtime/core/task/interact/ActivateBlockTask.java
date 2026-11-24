package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.task.base.GoToThenDoTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** One-dispatch, evidence-bound activation with verified Menu or BlockState outcome. */
public final class ActivateBlockTask extends GoToThenDoTask<ActivateBlockTaskRecord> {
    private BlockEvidenceCell boundEvidence;
    private PhysicalVerificationAuthority.Operation operation;
    private String failureType;
    private String outcome;
    private String resultingBlockState;

    public ActivateBlockTask(BotPlayer player, ActivateBlockTaskRecord record) {
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
        boundEvidence = RuntimeBotManager.knowledge(player.getServer())
                .blocks().cell(dimension, r.position);
        if (boundEvidence.state() != BlockEvidenceCell.State.KNOWN_BLOCK) {
            failureType = "target_not_known_block";
            return new Precondition.Failure(
                    "activate_block requires an exact KNOWN_BLOCK target", FailureType.UNKNOWN);
        }
        return null;
    }

    @Override
    protected PlayerNav buildNav() {
        return null;
    }

    @Override
    protected net.minecraft.core.BlockPos gotoFirstTarget() {
        return r.position;
    }

    @Override
    protected boolean reached() {
        var action = new PhysicalVerificationAuthority.Activate(
                new PhysicalVerificationAuthority.BoundBlock(r.position, boundEvidence));
        var probe = PhysicalVerificationAuthority.probe(player, action);
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
                    new PhysicalVerificationAuthority.Activate(
                            new PhysicalVerificationAuthority.BoundBlock(
                                    r.position, boundEvidence)));
        }
        return switch (operation.tick()) {
            case PhysicalVerificationAuthority.Running ignored -> TaskState.RUNNING;
            case PhysicalVerificationAuthority.Failed failed -> failed(
                    failed.failure().message(), failed.failure().code().wireValue());
            case PhysicalVerificationAuthority.Succeeded succeeded -> {
                var activation = (PhysicalVerificationAuthority.ActivationOutcome)
                        succeeded.outcome();
                outcome = activation.outcome();
                resultingBlockState = activation.blockState();
                yield TaskState.SUCCESS;
            }
        };
    }

    @Override
    public void stop(BotPlayer bot, StopReason why) {
        super.stop(bot, why);
        if (operation != null) operation.cancel();
    }

    private TaskState failed(String message, String type) {
        failureType = type;
        fail(message, FailureType.UNKNOWN);
        return TaskState.FAILED;
    }

    @Override
    protected void cleanup() {
        try {
            if (operation != null) operation.cancel();
        } finally {
            super.cleanup();
        }
    }

    @Override
    protected Map<String, Object> resultData() {
        Map<String, Object> data = new HashMap<>();
        data.put("position", Map.of("x", r.position.getX(), "y", r.position.getY(), "z", r.position.getZ()));
        if (outcome != null) data.put("outcome", outcome);
        if (resultingBlockState != null) data.put("block_state", resultingBlockState);
        if (failureType != null) data.put("failure_type", failureType);
        return data;
    }

    @Override
    protected String successMessage() {
        return "verified block activation";
    }

    @Override
    protected String cancelledMessage() {
        return "activate_block interrupted";
    }
}
