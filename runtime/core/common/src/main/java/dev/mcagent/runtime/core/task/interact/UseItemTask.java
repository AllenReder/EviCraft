package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.PlayerInv;
import dev.mcagent.runtime.core.task.base.GoToThenDoTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Uses a carried item toward one {@code KNOWN_AIR} aim without travelling: the right mouse button
 * pressed in open air. Physical Verification Authority faces the aim, requires the native ray to
 * hit nothing within reach, and reports whether the use was consumed.
 */
public final class UseItemTask extends GoToThenDoTask<UseItemTaskRecord> {
    private BlockPos boundAim;
    private BlockEvidenceCell boundEvidence;
    private String failureType;
    private PhysicalVerificationAuthority.Operation physicalOperation;

    public UseItemTask(BotPlayer player, UseItemTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(this::itemPrecondition, this::evidencePrecondition);
    }

    private Precondition.Failure itemPrecondition() {
        if (r.item != null && PlayerInv.count(player.getInventory(), r.item) == 0) {
            failureType = "item_not_found";
            return new Precondition.Failure(
                    BuiltInRegistries.ITEM.getKey(r.item) + " is not carried", FailureType.NO_MATERIAL);
        }
        String unsupported = UseItemTaskRecord.unsupportedReason(
                r.item != null ? r.item : player.getMainHandItem().getItem());
        if (unsupported == null && r.item == null) {
            unsupported = UseItemTaskRecord.unsupportedReason(player.getOffhandItem().getItem());
        }
        if (unsupported == null) return null;
        failureType = "item_not_supported";
        return new Precondition.Failure(unsupported, FailureType.UNKNOWN);
    }

    private Precondition.Failure evidencePrecondition() {
        boundAim = r.aim != null ? r.aim : BlockPos.containing(player.getEyePosition()
                .add(player.getViewVector(1.0F).scale(player.blockInteractionRange())));
        String dimension = player.level().dimension().location().toString();
        BlockEvidenceCell cell = RuntimeBotManager.knowledge(player.getServer())
                .blocks().cell(dimension, boundAim);
        if (cell.state() != BlockEvidenceCell.State.KNOWN_AIR) {
            failureType = "aim_not_known_air";
            return new Precondition.Failure(
                    "use_item requires KNOWN_AIR at the aim " + boundAim.toShortString(),
                    FailureType.UNKNOWN);
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
                    new PhysicalVerificationAuthority.UseAtAir(
                            new PhysicalVerificationAuthority.BoundBlock(boundAim, boundEvidence),
                            r.item, r.holdTicks));
        }
        return switch (physicalOperation.tick()) {
            case PhysicalVerificationAuthority.Running ignored -> TaskState.RUNNING;
            case PhysicalVerificationAuthority.Failed failed -> {
                failureType = failed.failure().code().wireValue();
                fail(failed.failure().message(), failed.failure().code()
                        == PhysicalVerificationAuthority.FailureCode.OCCLUDED
                        ? FailureType.OCCLUDED : FailureType.UNKNOWN);
                yield TaskState.FAILED;
            }
            case PhysicalVerificationAuthority.Succeeded ignored -> TaskState.SUCCESS;
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
        if (boundAim != null) {
            data.put("aim", Map.of("x", boundAim.getX(), "y", boundAim.getY(), "z", boundAim.getZ()));
        }
        if (failureType != null) data.put("failure_type", failureType);
        return data;
    }

    @Override
    protected String successMessage() {
        return "used the item toward " + boundAim.toShortString();
    }

    @Override
    protected String timeoutMessage() {
        return "timed out before the item use ended";
    }

    @Override
    protected String cancelledMessage() {
        return "use_item interrupted";
    }
}
