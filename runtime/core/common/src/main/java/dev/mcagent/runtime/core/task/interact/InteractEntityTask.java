package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.PlayerInv;
import dev.mcagent.runtime.core.act.Interaction;
import dev.mcagent.runtime.core.pathing.calc.NavGoal;
import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.task.base.GoToThenDoTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.EntityTrack;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Evidence-bound native right-click on one exact Entity Track UUID. Navigation consumes only
 * the Track position: VISIBLE observations may advance it, while KNOWN observations remain at
 * their frozen last-known position. Minecraft live state is resolved only after the same UUID
 * is VISIBLE, and then only to verify native reach, line of sight, and the exact first hit.
 */
public final class InteractEntityTask
        extends GoToThenDoTask<InteractEntityTaskRecord> {

    private static final double REACH = 3.0;
    private static final double REACH_SQR = REACH * REACH;
    private static final double STANCE_RADIUS = 2.5;
    private static final double WALK_SPEED = 1.0;

    private String boundEntityTypeId;
    private PhysicalVerificationAuthority.Operation interaction;

    public InteractEntityTask(
            BotPlayer player, InteractEntityTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(this::evidencePrecondition,
                () -> r.item == null || PlayerInv.count(player.getInventory(), r.item) > 0
                        ? null : new Precondition.Failure(
                        "don't have " + BuiltInRegistries.ITEM.getKey(r.item).getPath()
                                + " to use on it",
                        FailureType.NO_MATERIAL));
    }

    private Precondition.Failure evidencePrecondition() {
        EntityTrack track = evidence();
        if (track == null) {
            return new Precondition.Failure(
                    "Entity Track " + r.entityUuid + " is unknown or expired",
                    FailureType.TARGET_LOST);
        }
        if (!track.dimension().equals(dimension())) {
            return new Precondition.Failure(
                    "Entity Track " + r.entityUuid + " is in another dimension",
                    FailureType.TARGET_LOST);
        }
        boundEntityTypeId = track.entityId();
        return null;
    }

    @Override
    protected PlayerNav buildNav() {
        return PlayerNav.toGoal(
                player, this::evidenceTarget, WALK_SPEED, this::readyToAct);
    }

    private NavGoal evidenceTarget() {
        EntityTrack current = evidence();
        return !sameIdentity(current)
                ? null : NavGoal.near(
                        net.minecraft.core.BlockPos.containing(current.position()),
                        STANCE_RADIUS);
    }

    @Override
    protected boolean reached() {
        return readyToAct();
    }

    private boolean readyToAct() {
        EntityTrack current = evidence();
        if (!sameIdentity(current)) return true;
        if (current.state() == EntityTrack.State.KNOWN) {
            // KNOWN evidence is sufficient only to approach the frozen last-known
            // position. Entering act() here would immediately and incorrectly
            // report target_lost before the same UUID has become VISIBLE again.
            return false;
        }
        return player.onGround() && PhysicalVerificationAuthority.verifyEntity(
                player, new PhysicalVerificationAuthority.BoundEntity(r.entityUuid, current), REACH) != null;
    }

    @Override
    protected TaskState act() {
        EntityTrack current = evidence();
        if (!sameIdentity(current)) {
            return targetLost(
                    "Entity Track is unknown, expired, changed identity, or left this dimension");
        }
        if (current.state() != EntityTrack.State.VISIBLE) {
            return targetLost("target was not reacquired at its frozen last-known position");
        }
        PhysicalVerificationAuthority.EntityCheck check = PhysicalVerificationAuthority.verifyEntity(
                player, new PhysicalVerificationAuthority.BoundEntity(r.entityUuid, current), REACH);
        if (check == null) {
            return targetLost("the visible UUID no longer resolves to the same live entity");
        }
        Entity entity = check.entity();
        if (!player.onGround()) {
            return TaskState.RUNNING;
        }

        if (interaction == null) {
            if (r.item != null) {
                player.holdInHand(PlayerInv.findSlot(player.getInventory(), r.item));
            }
            interaction = PhysicalVerificationAuthority.interactEntity(player,
                    new PhysicalVerificationAuthority.BoundEntity(r.entityUuid, current), r.holdTicks);
        }
        return switch (interaction.tick()) {
            case PhysicalVerificationAuthority.Running ignored -> TaskState.RUNNING;
            case PhysicalVerificationAuthority.Succeeded ignored -> TaskState.SUCCESS;
            case PhysicalVerificationAuthority.Failed failed -> {
                fail(failed.failure().message(), FailureType.UNKNOWN);
                yield TaskState.FAILED;
            }
        };
    }

    @Override
    protected TaskState handleNavFailure(FailureType type, String reason) {
        return targetLost("could not reacquire the UUID from embodied evidence: " + reason);
    }

    private EntityTrack evidence() {
        return RuntimeBotManager.knowledge(player.getServer()).entity(r.entityUuid).orElse(null);
    }

    private Entity visibleEntity(EntityTrack current) {
        if (current.state() != EntityTrack.State.VISIBLE) return null;
        Entity entity = ((ServerLevel) player.level()).getEntity(r.entityUuid);
        return entity != null && entity.isAlive() && entity.getUUID().equals(r.entityUuid)
                && BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString()
                .equals(boundEntityTypeId)
                ? entity : null;
    }

    private boolean sameIdentity(EntityTrack current) {
        return current != null && current.dimension().equals(dimension())
                && current.entityId().equals(boundEntityTypeId);
    }

    private String dimension() {
        return player.level().dimension().location().toString();
    }

    private TaskState targetLost(String reason) {
        fail(reason, FailureType.TARGET_LOST);
        return TaskState.FAILED;
    }

    @Override
    protected void cleanup() {
        if (interaction != null) interaction.cancel();
        super.cleanup();
    }

    @Override
    protected Map<String, Object> resultData() {
        Map<String, Object> data = new HashMap<>();
        data.put("uuid", r.entityUuid.toString());
        if (lastFailure() == FailureType.TARGET_LOST) {
            data.put("failure_type", "target_lost");
        }
        return data;
    }

    @Override
    protected String successMessage() {
        return "interacted with " + r.entityUuid;
    }

    @Override
    protected String timeoutMessage() {
        return "timed out before interacting with " + r.entityUuid;
    }

    @Override
    protected String cancelledMessage() {
        return "interact_entity interrupted";
    }
}
