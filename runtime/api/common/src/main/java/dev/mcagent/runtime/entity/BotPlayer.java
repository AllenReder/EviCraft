package dev.mcagent.runtime.entity;

import com.mojang.authlib.GameProfile;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;

import java.util.UUID;

/**
 * The bot body: a server-side fake {@link ServerPlayer}, so the bot is a first-class player —
 * native interaction/combat code paths (universal mod compatibility), its own
 * player inventory, and normal server-side player physics.
 *
 * <h2>World Run identity</h2>
 * Created by {@link BotFactory} with one random UUID per World Run,
 * carried in the {@link GameProfile}. The body is ownerless and process-local.
 */
public final class BotPlayer extends ServerPlayer {

    /** Latched once we've handled this body's death, so the post-death routine runs exactly once. */
    private boolean deathHandled;

    private ItemUseCompletionObserver itemUseCompletionObserver;

    /** Observes the existing native finish call; it does not dispatch or complete item use. */
    public interface ItemUseCompletionObserver {
        void beforeFinish(ItemStack usedStack);
        void afterFinish(ItemStack resultStack);
    }

    /** The active consumption task owns this observer until its cleanup runs. */
    public Runnable observeItemUseCompletion(ItemUseCompletionObserver observer) {
        itemUseCompletionObserver = observer;
        return () -> {
            if (itemUseCompletionObserver == observer) itemUseCompletionObserver = null;
        };
    }

    /** The camera renders from this body's eye, so the body itself is never sent to the camera client. */
    @Override
    public boolean broadcastToPlayer(ServerPlayer viewer) {
        return !dev.mcagent.runtime.camera.RuntimeCamera.isCamera(viewer) && super.broadcastToPlayer(viewer);
    }

    @Override
    protected void completeUsingItem() {
        ItemUseCompletionObserver observer = itemUseCompletionObserver;
        if (observer == null) {
            super.completeUsingItem();
            return;
        }
        InteractionHand hand = getUsedItemHand();
        observer.beforeFinish(getUseItem().copy());
        Throwable failure = null;
        try {
            super.completeUsingItem();
        } catch (RuntimeException | Error exception) {
            failure = exception;
            throw exception;
        } finally {
            try {
                observer.afterFinish(getItemInHand(hand).copy());
            } catch (RuntimeException | Error observationFailure) {
                if (failure == null) throw observationFailure;
                failure.addSuppressed(observationFailure);
            }
        }
    }

    public BotPlayer(MinecraftServer server, ServerLevel level, GameProfile profile,
                        ClientInformation clientInformation) {
        super(server, level, profile, clientInformation);
    }

    /**
     * Enables every skin layer (hat, jacket, both sleeves, both trouser legs) and the cape. A fake player
     * has no client-reported model customisation; without this byte the client renders only the base skin
     * layer. The byte is synced entity data and is not saved in the .dat file, so it must be set again each
     * time the body enters the world (through the {@code protected} DATA_PLAYER_MODE_CUSTOMISATION, visible
     * in the subclass).
     */
    public void showAllSkinLayers() {
        getEntityData().set(DATA_PLAYER_MODE_CUSTOMISATION, (byte) 0x7f);
    }

    /** True if {@code item} sits anywhere in the inventory (hotbar/main/offhand all count). */
    public boolean ensureInInventory(Item item) {
        var inv = getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (inv.getItem(i).is(item)) return true;
        }
        return false;
    }

    /**
     * Hold the item in inventory slot {@code slot} in the main hand the way a real player
     * does — a hotbar slot is simply SELECTED (number-key); a main-inventory slot is SWAPPED
     * into the currently selected hotbar slot (item-conserving). This is the only correct way
     * to "switch to hand": calling {@code setItemInHand(MAIN_HAND, stack)} overwrites the held
     * item (losing it) and aliases ONE {@link net.minecraft.world.item.ItemStack} across two
     * slots, which corrupts the inventory once the stack is consumed. No-op for {@code slot < 0}.
     */
    public void holdInHand(int slot) {
        if (slot < 0) {
            return;
        }
        var inv = getInventory();
        if (net.minecraft.world.entity.player.Inventory.isHotbarSlot(slot)) {
            inv.selected = slot;
            return;
        }
        int selected = inv.selected;
        net.minecraft.world.item.ItemStack held = inv.getItem(selected);
        inv.setItem(selected, inv.getItem(slot));
        inv.setItem(slot, held);
    }

    // ---- server tick (restore the movement pass a fake connection skips) ----

    /**
     * Drive the body's own movement physics. A real {@link ServerPlayer} runs
     * {@code travel} (against {@code zza}/{@code xxa}), food, air and pose inside
     * {@link #doTick()}, which the network layer invokes via
     * {@code connection.tick()}. A fake player's connection is a no-op, so
     * {@code doTick()} never fires and the body would only ever turn (a direct
     * {@code setYRot} write) without walking. The entity system already calls
     * {@code super.tick()} (menus / container / position sync), so we add the
     * missing {@code doTick()} movement pass here in our own {@code tick()}
     * override. After movement, every SectionPos change is handed immediately
     * to vanilla player tracking so its logical view and loading center follow
     * the headless Runtime Bot without a polling interval.
     */
    @Override
    public net.minecraft.world.entity.Entity changeDimension(
            net.minecraft.world.level.portal.DimensionTransition transition) {
        var arrived = super.changeDimension(transition);
        // There is no remote client to acknowledge the completed dimension transition.
        // Leaving this flag set makes ServerPlayer immune to every DamageSource.
        if (arrived != null) hasChangedDimension();
        return arrived;
    }

    @Override
    public void tick() {
        // A fake player isn't auto-removed on death (no client to send a respawn packet), so it would
        // sit at 0 HP forever. Detect death once, terminate the active task, hand off to vanilla
        // respawn policy, and skip the normal movement/AI tick for this corpse.
        if (!deathHandled && (getHealth() <= 0.0f || isDeadOrDying())) {
            deathHandled = true;
            dev.mcagent.runtime.benchmark.WorldEventCounters.recordActorDeath(getServer());
            dev.mcagent.runtime.bot.RuntimeBotManager.onDeath(this);
            return;
        }
        try {
            super.tick();
        } catch (RuntimeException ex) {
            reportTickFailure(ex);
        }
        // Fall settlement is the <b>only</b> client-authoritative player physics: the check in
        // {@code Entity.move} is gated by {@code isLocalInstanceAuthoritative()}
        // (Player.isClientAuthoritative() is always true, so it evaluates to false on the server), and the
        // real settlement is
        // {@code doCheckFallDamage} when a move packet arrives. A fake player's connection is empty and that
        // packet never comes, so the Bot would take no fall damage and {@code fallDistance} would stay 0.
        // As with the doTick() pass above, this restores the step the network layer skips, exactly as vanilla.
        net.minecraft.world.phys.Vec3 before = position();
        try {
            this.doTick();
        } catch (RuntimeException ex) {
            reportTickFailure(ex);
        }
        dev.mcagent.runtime.bot.RuntimeBotTracking.sync(this);
        // The displacement covers only the section above. Summons, respawns and dimension changes happen
        // outside the tick, so the next {@code before} already reads the new position and the displacement
        // is zero; no teleport exemption is needed.
        net.minecraft.world.phys.Vec3 moved = position().subtract(before);
        doCheckFallDamage(moved.x, moved.y, moved.z, onGround());
    }

    /** Log once per body: at twenty ticks a second, a recurring failure would flood the log. */
    private boolean tickFailureLogged;

    /**
     * This tick threw: swallow the exception and log it once.
     *
     * <h2>Why it must not propagate</h2>
     * An exception that reaches the {@code ServerLevel} entity tick loop is wrapped by vanilla in a
     * {@code ReportedException} that tears down the whole server main loop; the watchdog then declares a
     * crash after sixty seconds and stops the server, disconnecting every player.
     *
     * <h2>The usual thrower is other code</h2>
     * The Bot sits in the player list as a player, and other mods handling its lifecycle events do not
     * expect a player without a real connection. These cases cannot all be fixed here (closing one cause
     * leaves the next mod to trip on something else), so the tick must simply not take the server down.
     *
     * <p>The costs are lopsided: swallowing loses this one tick; propagating loses the whole server.
     */
    private void reportTickFailure(RuntimeException ex) {
        if (tickFailureLogged) {
            return;
        }
        tickFailureLogged = true;
        dev.mcagent.runtime.Constants.LOG.error(
                "[mc_agent] Bot {} tick threw an exception; skipping this tick (logged only once)",
                getUUID(), ex);
    }

}
