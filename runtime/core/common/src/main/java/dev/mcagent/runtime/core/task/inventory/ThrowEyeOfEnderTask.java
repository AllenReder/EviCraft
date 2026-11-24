package dev.mcagent.runtime.core.task.inventory;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.PlayerInv;
import dev.mcagent.runtime.core.act.Interaction;
import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Uses one Eye through the vanilla held-item path, then reports only evidence a body can obtain
 * from that exact flight: its five-tick direction and dropped/shattered terminal. The native
 * Eye's internal target is deliberately never read.
 */
public final class ThrowEyeOfEnderTask
        extends AbstractBotTask<ThrowEyeOfEnderTaskRecord> {

    private static final int INVENTORY_SLOT_COUNT = 36;
    private static final long DIRECTION_AFTER_TICKS = 5;
    private static final long TERMINAL_WAIT_TICKS = 100;

    private Interaction use;
    private EyeOfEnder eye;
    private Vec3 launchPosition;
    private Vec3 direction;
    private long launchTick;
    private int eyeSlot = -1;
    private int previousSelected = -1;
    private int beforeCount;
    private boolean slotRestored;
    /** Null means the exact Eye has no terminal yet; otherwise the explicit terminal fact. */
    private RuntimeBotManager.EnderEyeTerminal terminal;

    public ThrowEyeOfEnderTask(
            BotPlayer player, ThrowEyeOfEnderTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(
                () -> player.level() instanceof ServerLevel ? null
                        : new Precondition.Failure(
                                "Ender Eye throwing requires a server world", FailureType.UNKNOWN),
                () -> player.containerMenu == player.inventoryMenu ? null
                        : new Precondition.Failure(
                                "close the open menu before throwing an Ender Eye",
                                FailureType.UNKNOWN),
                () -> firstEyeSlot(player.getInventory()) >= 0 ? null
                        : new Precondition.Failure(
                                "no Ender Eye in inventory to throw", FailureType.NO_MATERIAL));
    }

    @Override
    protected void onStart() {
        Inventory inventory = player.getInventory();
        eyeSlot = firstEyeSlot(inventory);
        previousSelected = inventory.selected;
        beforeCount = PlayerInv.count(inventory, Items.ENDER_EYE);
        player.holdInHand(eyeSlot);
        use = Interaction.useInAir(
                player, InteractionHand.MAIN_HAND, Interaction.Timing.once());
    }

    @Override
    protected TaskState onTick() {
        if (eye == null) {
            Interaction.Status status = use.tick();
            if (status == Interaction.Status.FAILED) {
                restoreSelectedSlot();
                fail("couldn't throw Ender Eye: " + use.failReason(), FailureType.UNKNOWN);
                return TaskState.FAILED;
            }
            if (status == Interaction.Status.RUNNING) return TaskState.RUNNING;

            restoreSelectedSlot();
            int afterCount = PlayerInv.count(player.getInventory(), Items.ENDER_EYE);
            eye = RuntimeBotManager.consumeAttributableEnderEyeLaunch(
                    player.getServer(), player.getUUID()).orElse(null);
            if (afterCount != beforeCount - 1 || eye == null) {
                fail("Ender Eye was not launched by the native use", FailureType.UNKNOWN);
                return TaskState.FAILED;
            }
            launchPosition = eye.position();
            launchTick = ((ServerLevel) player.level()).getGameTime();
        }

        long elapsed = ((ServerLevel) player.level()).getGameTime() - launchTick;
        if (direction == null && elapsed >= DIRECTION_AFTER_TICKS) {
            Vec3 displacement = eye.position().subtract(launchPosition);
            if (displacement.lengthSqr() == 0.0) {
                fail("Ender Eye produced no observable flight direction", FailureType.UNKNOWN);
                return TaskState.FAILED;
            }
            direction = displacement.normalize();
        }

        terminal = RuntimeBotManager.consumeAttributableEnderEyeTerminal(
                player.getServer(), eye.getUUID()).orElse(null);
        if (terminal != null) {
            if (direction == null) {
                fail("Ender Eye ended before a direction could be observed", FailureType.UNKNOWN);
                return TaskState.FAILED;
            }
            return TaskState.SUCCESS;
        }
        if (elapsed >= TERMINAL_WAIT_TICKS) {
            fail("Ender Eye did not reach a dropped or shattered terminal within 100 ticks",
                    FailureType.UNKNOWN);
            return TaskState.FAILED;
        }
        return TaskState.RUNNING;
    }

    private static int firstEyeSlot(Inventory inventory) {
        int limit = Math.min(INVENTORY_SLOT_COUNT, inventory.items.size());
        for (int slot = 0; slot < limit; slot++) {
            if (inventory.getItem(slot).is(Items.ENDER_EYE)) return slot;
        }
        return -1;
    }

    private void restoreSelectedSlot() {
        if (slotRestored || previousSelected < 0) return;
        Inventory inventory = player.getInventory();
        if (eyeSlot >= Inventory.getSelectionSize()) {
            var held = inventory.getItem(inventory.selected);
            inventory.setItem(inventory.selected, inventory.getItem(eyeSlot));
            inventory.setItem(eyeSlot, held);
        }
        inventory.selected = previousSelected;
        inventory.setChanged();
        slotRestored = true;
    }

    @Override
    protected void cleanup() {
        if (use != null) use.stop();
        restoreSelectedSlot();
    }

    @Override
    protected Map<String, Object> resultData() {
        if (terminal == null || direction == null) return Map.of();
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("consumed", 1);
        data.put("direction", Map.of(
                "x", direction.x, "y", direction.y, "z", direction.z));
        data.put("terminal", terminal.terminal());
        if (terminal.itemEntityUuid() != null) {
            data.put("item_entity_uuid", terminal.itemEntityUuid().toString());
        }
        return data;
    }

    @Override
    protected String successMessage() {
        return "Ender Eye " + terminal.terminal();
    }

    @Override
    protected String timeoutMessage() {
        return "Ender Eye throw timed out";
    }

    @Override
    protected String cancelledMessage() {
        return "Ender Eye throw canceled";
    }
}
