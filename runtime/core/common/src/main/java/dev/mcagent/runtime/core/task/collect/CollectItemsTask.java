package dev.mcagent.runtime.core.task.collect;

import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.pathing.calc.NavGoal;
import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Evidence-bound item collection. Candidate discovery is a store-only selection from Entity
 * Tracks; glob selections may re-select newly remembered drops around the body when every bound
 * target is settled. Navigation follows only their VISIBLE or frozen KNOWN positions; live Minecraft
 * entities are resolved only for a currently VISIBLE, already-bound UUID to verify pickup.
 */
public final class CollectItemsTask
        extends AbstractBotTask<CollectItemsTaskRecord> {

    private enum Phase { SELECT, APPROACH, WAIT_RETRY }

    private enum SkipReason { LOST, UNREACHABLE }

    private static final double WALK_SPEED = 1.0;
    private static final double PICKUP_REACH_SQR = 1.5;
    private static final int PICKUP_GRACE_TICKS = 20;
    private static final int RETRY_WAIT_TICKS = 10;
    private static final int MAX_NAVIGATOR_REBUILDS = 4;
    /** Bound drops may drift (water, slopes, knockback) a little past the selection radius. */
    private static final double BOUND_DRIFT_MARGIN = 4.0;
    /** Glob re-selections from World Knowledge once the bound targets are settled. */
    private static final int MAX_RESELECTIONS = 2;
    private static final CanonicalIdentifierGlob ITEM_ENTITY =
            CanonicalIdentifierGlob.compile("minecraft:item");

    private final Map<UUID, BoundTarget> targets = new LinkedHashMap<>();
    private final Set<UUID> remaining = new LinkedHashSet<>();
    private final Map<UUID, Integer> pickupCounts = new HashMap<>();
    private boolean exactUuidMode;
    private Vec3 origin;
    private Phase phase = Phase.SELECT;
    private BoundTarget target;
    private int arrivalTicks;
    private int retryWaitTicks;
    private int navigatorRebuilds;
    private int selectedSlot = -1;
    private int reselections;

    public CollectItemsTask(BotPlayer player, CollectItemsTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(this::bindEvidenceTargets);
    }

    private Precondition.Failure bindEvidenceTargets() {
        origin = player.position();
        String dimension = dimension();
        exactUuidMode = !r.exactUuids.isEmpty();
        if (!r.exactUuids.isEmpty()) {
            for (UUID uuid : r.exactUuids) {
                EntityTrack track = evidence(uuid);
                Precondition.Failure failure = bind(track, uuid, dimension);
                if (failure != null) {
                    if (failure.type() == FailureType.TARGET_LOST) {
                        r.recordLostSkip();
                    } else {
                        r.recordUnreachableSkip();
                    }
                }
            }
            if (targets.isEmpty()) {
                return new Precondition.Failure(
                        "no exact dropped-item UUID remained an admissible collection target",
                        r.unreachableEntities() > 0 ? FailureType.NO_PATH : FailureType.TARGET_LOST);
            }
        } else {
            dev.mcagent.runtime.knowledge.EntityKnowledgeSelection.selectTargets(
                            allEvidence(), dimension, ITEM_ENTITY, r.itemMatcher,
                            origin, (double) r.radius).stream()
                    .forEach(track -> targets.put(track.uuid(), BoundTarget.from(track)));
            if (targets.isEmpty()) {
                return new Precondition.Failure(
                        "unknown/not-known: no remembered dropped-item Track full-matches '"
                                + r.selector + "' within radius " + r.radius,
                        FailureType.MINED_OUT);
            }
        }
        remaining.addAll(targets.keySet());
        for (BoundTarget bound : targets.values()) {
            var pickup = RuntimeBotManager.attributablePickup(player.getServer(), bound.uuid);
            pickupCounts.put(bound.uuid, pickup == null ? 0 : pickup.count());
        }
        return null;
    }

    private Precondition.Failure bind(EntityTrack track, UUID uuid, String dimension) {
        if (track == null) {
            return new Precondition.Failure(
                    "dropped-item Entity Track " + uuid + " is unknown or expired",
                    FailureType.TARGET_LOST);
        }
        if (!dimension.equals(track.dimension())
                || !"minecraft:item".equals(track.entityId()) || track.itemId() == null
                || !withinRadius(track)) {
            return new Precondition.Failure(
                    "dropped-item Entity Track " + uuid
                            + " is unknown, expired, not an item, in another dimension, or outside radius "
                            + r.radius,
                    FailureType.NO_PATH);
        }
        targets.put(uuid, BoundTarget.from(track));
        return null;
    }

    private boolean withinRadius(EntityTrack track) {
        return origin.distanceToSqr(track.position()) <= (double) r.radius * r.radius;
    }

    private boolean withinBoundRadius(EntityTrack track) {
        double limit = r.radius + BOUND_DRIFT_MARGIN;
        return origin.distanceToSqr(track.position()) <= limit * limit;
    }

    /**
     * Glob mode only: once every bound target is settled, bind matching drops that World
     * Knowledge now remembers within the original radius (drops scattered by the previous
     * pickups, or first seen on the way). The radius stays anchored at the starting feet, and
     * selection reads only Entity Tracks, exactly like the first binding.
     */
    private boolean reselect() {
        if (exactUuidMode || reselections >= MAX_RESELECTIONS) return false;
        reselections++;
        List<EntityTrack> fresh = dev.mcagent.runtime.knowledge.EntityKnowledgeSelection
                .selectTargets(allEvidence(), dimension(), ITEM_ENTITY, r.itemMatcher,
                        origin, (double) r.radius).stream()
                .filter(track -> !targets.containsKey(track.uuid())).toList();
        for (EntityTrack track : fresh) {
            targets.put(track.uuid(), BoundTarget.from(track));
            remaining.add(track.uuid());
            var pickup = RuntimeBotManager.attributablePickup(player.getServer(), track.uuid());
            pickupCounts.put(track.uuid(), pickup == null ? 0 : pickup.count());
        }
        return !fresh.isEmpty();
    }

    @Override
    protected void onStart() {
        selectedSlot = player.getInventory().selected;
        phase = Phase.SELECT;
        retryWaitTicks = 0;
        navigatorRebuilds = 0;
    }

    @Override
    protected TaskState onTick() {
        if (player.isDeadOrDying()) return TaskState.CANCELLED;
        TaskState reconciliation = reconcileDisappearedTargets();
        if (reconciliation != null) return reconciliation;
        return switch (phase) {
            case SELECT -> selectNext();
            case APPROACH -> approachTarget();
            case WAIT_RETRY -> waitForRetry();
        };
    }

    /** Read only new native transfers for this action's fixed target UUIDs. */
    private TaskState reconcileDisappearedTargets() {
        reconcilePickups();
        if (target != null && !remaining.contains(target.uuid)) {
            stopNav();
            target = null;
            phase = Phase.SELECT;
        }
        return remaining.isEmpty() && !reselect()
                ? finishAfterTargets("no evidence-bound dropped-item target could be collected")
                : null;
    }

    private void reconcilePickups() {
        for (UUID uuid : List.copyOf(remaining)) {
            var pickup = RuntimeBotManager.attributablePickup(player.getServer(), uuid);
            if (pickup == null) continue;
            int previous = pickupCounts.get(uuid);
            if (pickup.count() <= previous) continue;
            r.recordPickup(pickup.count() - previous, pickup.complete());
            pickupCounts.put(uuid, pickup.count());
            if (pickup.complete()) remaining.remove(uuid);
        }
    }

    private TaskState selectNext() {
        if (remaining.isEmpty() && !reselect()) {
            return finishAfterTargets("no evidence-bound dropped-item target could be collected");
        }
        List<BoundTarget> candidates = new ArrayList<>();
        Iterator<UUID> iterator = remaining.iterator();
        while (iterator.hasNext()) {
            UUID uuid = iterator.next();
            BoundTarget bound = targets.get(uuid);
            EntityTrack track = evidenceTrack(bound);
            if (track == null) {
                iterator.remove();
                recordSkip(SkipReason.LOST);
                continue;
            }
            if (!validTrack(bound, track)) {
                iterator.remove();
                recordSkip(exactUuidMode ? SkipReason.UNREACHABLE : SkipReason.LOST);
                continue;
            }
            candidates.add(bound.withPosition(track.position()));
        }
        if (candidates.isEmpty()) {
            return reselect() ? TaskState.RUNNING
                    : finishAfterTargets("no evidence-bound dropped-item target could be collected");
        }
        target = candidates.stream()
                .min(Comparator.comparingDouble(candidate ->
                        player.distanceToSqr(candidate.position)))
                .orElseThrow();
        arrivalTicks = 0;
        navigatorRebuilds = 0;
        createNavigator();
        phase = Phase.APPROACH;
        return TaskState.RUNNING;
    }

    private TaskState approachTarget() {
        EntityTrack track = evidenceTrack(target);
        if (track == null) {
            return skipTarget(target, SkipReason.LOST);
        }
        SkipReason gone = goneReason(target, track);
        if (gone != null) {
            return skipTarget(target, gone);
        }

        return switch (nav.tick()) {
            case RUNNING -> TaskState.RUNNING;
            case FAILED -> navigationFailed();
            case ARRIVED -> {
                closePickupGap(track);
                arrivalTicks++;
                if (arrivalTicks >= PICKUP_GRACE_TICKS) {
                    yield skipAccordingToEvidence(target);
                }
                yield TaskState.RUNNING;
            }
        };
    }

    private TaskState navigationFailed() {
        BoundTarget failed = target;
        stopNav();
        EntityTrack track = evidenceTrack(failed);
        if (track == null) {
            return skipTarget(failed, SkipReason.LOST);
        }
        SkipReason gone = retryBlocker(failed, track);
        if (gone != null) {
            return skipTarget(failed, gone);
        }
        if (track.position().distanceToSqr(failed.position) > 0.01) {
            navigatorRebuilds = 0;
        }
        if (navigatorRebuilds >= MAX_NAVIGATOR_REBUILDS) {
            return skipTarget(failed, SkipReason.UNREACHABLE);
        }
        navigatorRebuilds++;
        retryWaitTicks = RETRY_WAIT_TICKS;
        phase = Phase.WAIT_RETRY;
        return TaskState.RUNNING;
    }

    private TaskState waitForRetry() {
        EntityTrack track = evidenceTrack(target);
        if (track == null) {
            return skipTarget(target, SkipReason.LOST);
        }
        SkipReason gone = retryBlocker(target, track);
        if (gone != null) {
            return skipTarget(target, gone);
        }
        if (retryWaitTicks > 0) {
            retryWaitTicks--;
            return TaskState.RUNNING;
        }
        target = target.withPosition(track.position());
        arrivalTicks = 0;
        createNavigator();
        phase = Phase.APPROACH;
        return TaskState.RUNNING;
    }

    /**
     * Why a still-tracked target can no longer be collected, or null while it can: its Track no
     * longer qualifies, or a visible Track has no live item. A glob target that went away is
     * lost; an exact UUID the caller named is reported unreachable.
     */
    private SkipReason goneReason(BoundTarget bound, EntityTrack track) {
        SkipReason gone = exactUuidMode ? SkipReason.UNREACHABLE : SkipReason.LOST;
        if (!validTrack(bound, track)) return gone;
        if (track.state() == EntityTrack.State.VISIBLE && visibleItem(bound, track) == null) {
            return gone;
        }
        return null;
    }

    /**
     * Whether a target whose approach failed may be retried: never once it is gone, and an exact
     * UUID only while the item itself is in sight. Otherwise the rebuild budget decides.
     */
    private SkipReason retryBlocker(BoundTarget bound, EntityTrack track) {
        SkipReason gone = goneReason(bound, track);
        if (gone != null) return gone;
        return exactUuidMode && track.state() != EntityTrack.State.VISIBLE
                ? SkipReason.UNREACHABLE : null;
    }

    private void createNavigator() {
        nav = PlayerNav.toGoal(player, this::evidenceGoal, WALK_SPEED,
                this::pickupReady);
    }

    private TaskState skipAccordingToEvidence(BoundTarget skipped) {
        // Arrived but the pickup never landed: the item is still remembered, so it is unreachable
        // from here (above, inside a block, behind glass), not lost.
        return evidenceTrack(skipped) == null
                ? skipTarget(skipped, SkipReason.LOST)
                : skipTarget(skipped, SkipReason.UNREACHABLE);
    }

    private TaskState skipTarget(BoundTarget skipped, SkipReason reason) {
        if (remaining.remove(skipped.uuid)) recordSkip(reason);
        stopNav();
        target = null;
        arrivalTicks = 0;
        retryWaitTicks = 0;
        navigatorRebuilds = 0;
        phase = Phase.SELECT;
        return remaining.isEmpty()
                ? finishAfterTargets("no evidence-bound dropped-item target could be collected")
                : TaskState.RUNNING;
    }

    private TaskState finishAfterTargets(String failureReason) {
        if (r.collectedItems() > 0) return TaskState.SUCCESS;
        FailureType failure = r.unreachableEntities() > 0
                ? FailureType.NO_PATH : FailureType.TARGET_LOST;
        fail(failureReason, failure);
        return TaskState.FAILED;
    }

    private void closePickupGap(EntityTrack track) {
        // Deviation from ordinary navigation: an exact item pickup must
        // cross the final collision gap after path arrival without widening evidence authority.
        InputDriver.halt(player);
        Vec3 position = track.position();
        double dx = position.x - player.getX();
        double dz = position.z - player.getZ();
        if (dx * dx + dz * dz > 0.04) {
            InputDriver.stepToward(player, position, false);
        }
    }

    private NavGoal evidenceGoal() {
        EntityTrack track = currentTrack(target);
        // ADR 0022 keeps the target exact so arrival cannot stop beside, rather than on, the drop.
        return track == null ? null
                : NavGoal.nearGround(BlockPos.containing(track.position()), 0.0);
    }

    private boolean pickupReady() {
        if (target == null) return true;
        EntityTrack track = currentTrack(target);
        if (track == null) return true;
        if (track.state() == EntityTrack.State.KNOWN) {
            return player.onGround()
                    && player.distanceToSqr(track.position()) <= PICKUP_REACH_SQR;
        }
        ItemEntity item = visibleItem(target, track);
        return item != null && player.onGround()
                && player.distanceToSqr(item.position()) <= PICKUP_REACH_SQR;
    }

    private EntityTrack currentTrack(BoundTarget bound) {
        EntityTrack track = evidenceTrack(bound);
        return track != null && validTrack(bound, track) ? track : null;
    }

    private EntityTrack evidenceTrack(BoundTarget bound) {
        return bound == null ? null : evidence(bound.uuid);
    }

    private EntityTrack evidence(UUID uuid) {
        return RuntimeBotManager.knowledge(player.getServer()).entity(uuid).orElse(null);
    }

    private List<EntityTrack> allEvidence() {
        return RuntimeBotManager.knowledge(player.getServer()).entities();
    }

    private boolean validTrack(BoundTarget bound, EntityTrack track) {
        return bound != null && track != null
                && dimension().equals(track.dimension())
                && "minecraft:item".equals(track.entityId())
                && bound.itemId.equals(track.itemId())
                && withinBoundRadius(track);
    }

    private void recordSkip(SkipReason reason) {
        if (reason == SkipReason.LOST) {
            r.recordLostSkip();
        } else {
            r.recordUnreachableSkip();
        }
    }

    private ItemEntity visibleItem(BoundTarget bound, EntityTrack track) {
        if (track.state() != EntityTrack.State.VISIBLE) return null;
        Entity entity = ((ServerLevel) player.level()).getEntity(track.uuid());
        if (!(entity instanceof ItemEntity item) || item.isRemoved()
                || !item.getUUID().equals(track.uuid())) {
            return null;
        }
        String itemId = BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString();
        return bound.itemId.equals(itemId) ? item : null;
    }

    private String dimension() {
        return player.level().dimension().location().toString();
    }

    @Override
    protected void cleanup() {
        reconcilePickups();
        super.cleanup();
        if (selectedSlot >= 0) {
            player.getInventory().selected = selectedSlot;
        }
    }

    @Override
    protected Map<String, Object> resultData() {
        Map<String, Object> data = new HashMap<>();
        data.put("collected_entities", r.collectedEntities());
        data.put("collected_items", r.collectedItems());
        data.put("skipped_entities", r.skippedEntities());
        data.put("radius", r.radius);
        data.put("selection", r.selectorField);
        if (lastFailure() == FailureType.TARGET_LOST) {
            data.put("failure_type", "target_lost");
        } else if (lastFailure() == FailureType.NO_PATH) {
            data.put("failure_type", "unreachable");
        } else if (lastFailure() == FailureType.MINED_OUT) {
            data.put("failure_type", "unknown_not_known");
        }
        return data;
    }

    @Override
    protected String successMessage() {
        return "collected " + r.collectedItems() + " item(s) from "
                + r.collectedEntities() + " evidence-bound UUID(s); skipped "
                + r.skippedEntities() + " target(s)";
    }

    @Override
    protected String timeoutMessage() {
        return "timed out after collecting " + r.collectedItems() + " item(s) and skipping "
                + r.skippedEntities() + " target(s)";
    }

    @Override
    protected String cancelledMessage() {
        return "interrupted after collecting " + r.collectedItems() + " item(s) and skipping "
                + r.skippedEntities() + " target(s)";
    }

    private record BoundTarget(
            UUID uuid, String itemId, Vec3 position) {
        private static BoundTarget from(EntityTrack track) {
            return new BoundTarget(track.uuid(), track.itemId(), track.position());
        }

        private BoundTarget withPosition(Vec3 position) {
            return new BoundTarget(uuid, itemId, position);
        }
    }
}
