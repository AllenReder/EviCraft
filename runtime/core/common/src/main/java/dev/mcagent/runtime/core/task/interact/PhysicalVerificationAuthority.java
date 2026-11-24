package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.act.Interaction;
import dev.mcagent.runtime.core.act.ToolSelect;
import dev.mcagent.runtime.core.combat.Swing;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockObservation;
import dev.mcagent.runtime.evidence.EntityObservation;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import dev.mcagent.runtime.knowledge.KnowledgeRevision;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.entity.EntityTypeTest;
import net.minecraft.world.level.block.AbstractCauldronBlock;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.EntityHitResult;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Deep Module seam for exact, World-Knowledge-bound block actions.
 *
 * <p>Tasks retain navigation, strategy, retry, timeout, and result wording. This Module owns the
 * live identity check, native reach/raycast/collision rules, native action lifecycle, attributable
 * outcome verification, and exactly-once publication for one physical result.
 */
public final class PhysicalVerificationAuthority {
    private PhysicalVerificationAuthority() {}

    public record BoundBlock(BlockPos position, BlockEvidenceCell evidence) {
        public BoundBlock {
            position = Objects.requireNonNull(position, "position").immutable();
            Objects.requireNonNull(evidence, "evidence");
            if (evidence.state() == BlockEvidenceCell.State.UNKNOWN) {
                throw new IllegalArgumentException("an exact physical action cannot bind UNKNOWN");
            }
        }
    }

    public sealed interface ExactBlockAction permits Activate, UseItemOn, UseAtAir,
            Place, Break, Sleep {
        BoundBlock target();
    }

    /**
     * Native activation of an exact block.  Tool-level activation requires a
     * verified effect; raw {@code interact_at} additionally reconciles an
     * exact native no-effect as MISMATCH before returning the same failure.
     */
    public record Activate(BoundBlock target, boolean rawInteraction) implements ExactBlockAction {
        public Activate(BoundBlock target) {
            this(target, false);
        }
    }

    public record UseItemOn(BoundBlock target, Item item) implements ExactBlockAction {
        public UseItemOn { Objects.requireNonNull(item, "item"); }
    }

    public record UseAtAir(BoundBlock target, Item item, int holdTicks)
            implements ExactBlockAction {
        public UseAtAir {
            if (holdTicks < -1) throw new IllegalArgumentException("holdTicks must be -1 or positive");
        }
    }

    public record Place(BoundBlock target, BlockItem blockItem, Item item)
            implements ExactBlockAction {
        public Place {
            Objects.requireNonNull(blockItem, "blockItem");
            Objects.requireNonNull(item, "item");
        }
    }

    public record Break(BoundBlock target, int holdTicks) implements ExactBlockAction {
        public Break {
            if (holdTicks < -1) throw new IllegalArgumentException("holdTicks must be -1 or positive");
        }
    }

    public record Sleep(BoundBlock target) implements ExactBlockAction {}

    public enum FailureCode {
        TARGET_CHANGED("target_changed"), SECOND_CELL_NOT_FREE("second_cell_not_free"),
        BODY_IN_TARGET("body_in_target"), OUT_OF_REACH("out_of_reach"),
        OCCLUDED("occluded"), UNSUPPORTED_SHAPE("unsupported_shape"),
        UNBREAKABLE("unbreakable"), NO_EFFECT("no_effect"),
        VERIFICATION_FAILED("verification_failed"), ITEM_NOT_FOUND("item_not_found"),
        NO_SUPPORT("no_support"), ENTITY_BLOCKED("entity_blocked"),
        BED_NOT_USABLE("bed_not_usable_in_dimension"),
        OCCUPIED("occupied"), NOT_SLEEP_TIME("not_sleep_time"),
        OBSTRUCTED("obstructed"), UNSAFE("unsafe_nearby_monster"),
        ACCEPTED_NOT_SLEEPING("accepted_but_not_sleeping"),
        NOT_FLUID_SOURCE("not_fluid_source");

        private final String wireValue;
        FailureCode(String wireValue) { this.wireValue = wireValue; }
        public String wireValue() { return wireValue; }
    }

    public record Failure(FailureCode code, String message, BlockPos occludingBlock,
                          String occludingDetail) {
        public Failure {
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(message, "message");
            if (occludingBlock != null) occludingBlock = occludingBlock.immutable();
        }

        /** Three-argument constructor without blocker details. */
        public Failure(FailureCode code, String message, BlockPos occludingBlock) {
            this(code, message, occludingBlock, null);
        }
    }

    public sealed interface Outcome permits ActivationOutcome, ItemUseOutcome,
            PlacementOutcome, BreakOutcome, SleepOutcome, EntityOutcome {}

    public record ActivationOutcome(String outcome, String blockState) implements Outcome {}

    public record ItemUseOutcome(
            String outcome, Direction face, BlockPos effectPosition, String blockState,
            String resultingItemId, int consumedCount, int durabilityUsed) implements Outcome {}

    public record PlacedBlock(BlockPos position, String blockState) {}

    public record PlacementOutcome(String blockState, int consumedCount, List<PlacedBlock> placedBlocks)
            implements Outcome {
        public PlacementOutcome { placedBlocks = List.copyOf(placedBlocks); }
    }

    public record BreakOutcome(List<EntityObservation> drops) implements Outcome {
        public BreakOutcome { drops = List.copyOf(drops); }
    }

    public record SleepOutcome(BlockPos bedHead) implements Outcome {}

    public record EntityOutcome(String outcome, java.util.UUID uuid, boolean removed)
            implements Outcome {}

    /** Exact entity identity bound from World Knowledge for one physical outcome. */
    public record BoundEntity(java.util.UUID uuid, EntityTrack evidence) {
        public BoundEntity {
            Objects.requireNonNull(uuid, "uuid");
            Objects.requireNonNull(evidence, "evidence");
            if (!uuid.equals(evidence.uuid())) throw new IllegalArgumentException(
                    "entity UUID must match the bound World Knowledge Track");
        }
    }

    public record EntityCheck(Entity entity, EntityHitResult hit) {}

    /** Verify exact UUID, live identity, native reach and first-hit LOS without discovering targets. */
    public static EntityCheck verifyEntity(BotPlayer player, BoundEntity bound, double reach) {
        Objects.requireNonNull(player, "player");
        Objects.requireNonNull(bound, "bound");
        if (!player.level().dimension().location().toString().equals(bound.evidence().dimension())) return null;
        Entity entity = player.level() instanceof net.minecraft.server.level.ServerLevel level
                ? level.getEntity(bound.uuid()) : null;
        if (entity == null || entity.isRemoved() || !entity.isAlive()
                || !entity.getUUID().equals(bound.uuid())
                || !BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString()
                        .equals(bound.evidence().entityId())) return null;
        double centerReach = Swing.reachTo(reach, entity.getBbWidth());
        if (player.distanceToSqr(entity.position()) > centerReach * centerReach
                || !player.hasLineOfSight(entity)) return null;
        InputDriver.lookAt(player, entity.getEyePosition());
        HitResult result = Interaction.nativeRaytrace(player, reach);
        return result instanceof EntityHitResult hit && hit.getEntity().getUUID().equals(bound.uuid())
                ? new EntityCheck(entity, hit) : null;
    }

    /** Publish one verified entity result as one atomic World Knowledge update. */
    public static KnowledgeRevision publishEntityOutcome(
            BotPlayer player, BoundEntity bound, Entity entity) {
        if (!RuntimeBotManager.isRuntimeBot(player)) return null;
        if (entity != null && (!entity.getUUID().equals(bound.uuid())
                || !BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString()
                        .equals(bound.evidence().entityId())
                || entity.level() != player.level())) {
            throw new IllegalArgumentException("live entity does not match bound exact identity");
        }
        String dimension = player.level().dimension().location().toString();
        long tick = player.getServer().getTickCount();
        boolean removed = entity == null || entity.isRemoved()
                || entity instanceof LivingEntity living && living.isDeadOrDying();
        EntityObservation observation = removed ? null : EntityObservation.attributable(
                entity.getUUID(), BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString(),
                entity instanceof ItemEntity item
                        ? BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString() : null,
                entity instanceof ItemEntity item ? item.getItem().getCount() : null,
                entity.position(), entity instanceof LivingEntity living ? living.getHealth() : null,
                entity instanceof LivingEntity living ? living.getMaxHealth() : null);
        AttributableWorldUpdate update = new AttributableWorldUpdate(List.of(),
                removed ? List.of() : List.of(new AttributableWorldUpdate.EntityFact(
                        dimension, tick, observation)), removed ? List.of(bound.uuid()) : List.of());
        return RuntimeBotManager.publishAttributable(player.getServer(), update);
    }

    /** Publish the actual transfer measured around the native Inventory.add call. */
    public static KnowledgeRevision publishEntityPickup(BotPlayer player, ItemEntity item, int count) {
        Objects.requireNonNull(player, "player");
        Objects.requireNonNull(item, "item");
        if (!RuntimeBotManager.isRuntimeBot(player) || item.level() != player.level()) return null;
        KnowledgeRevision revision = RuntimeBotManager.recordAttributablePickup(
                player.getServer(), item.getUUID(), count, item.getItem().isEmpty());
        return item.getItem().isEmpty() ? revision : publishItemDrop(player, item);
    }

    /** Publish one exact ItemEntity produced by a verified inventory drop. */
    public static KnowledgeRevision publishItemDrop(BotPlayer player, ItemEntity item) {
        Objects.requireNonNull(player, "player");
        Objects.requireNonNull(item, "item");
        if (!RuntimeBotManager.isRuntimeBot(player) || item.level() != player.level()
                || item.getItem().isEmpty()) return null;
        String dimension = player.level().dimension().location().toString();
        long tick = player.getServer().getTickCount();
        EntityObservation observation = EntityObservation.attributable(
                item.getUUID(), BuiltInRegistries.ENTITY_TYPE.getKey(item.getType()).toString(),
                BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString(),
                item.getItem().getCount(), item.position(), null, null);
        return RuntimeBotManager.publishAttributable(player.getServer(),
                new AttributableWorldUpdate(List.of(), List.of(
                        new AttributableWorldUpdate.EntityFact(
                                dimension, tick, observation)), List.of()));
    }

    /** One native attack after exact live verification; weapon/timing choice remains task-owned. */
    public static boolean attackEntity(BotPlayer player, BoundEntity bound, double reach) {
        EntityCheck checked = verifyEntity(player, bound, reach);
        if (checked == null) return false;
        player.setSprinting(false);
        player.attack(checked.entity());
        player.swing(InteractionHand.MAIN_HAND);
        if (!checked.entity().isRemoved()
                && (!(checked.entity() instanceof LivingEntity living) || !living.isDeadOrDying())) {
            publishEntityOutcome(player, bound, checked.entity());
        }
        return true;
    }

    /** One exact entity interaction operation; it owns raycast, native action and publication. */
    public static Operation interactEntity(BotPlayer player, BoundEntity bound, int holdTicks) {
        if (holdTicks < -1) throw new IllegalArgumentException(
                "holdTicks must be -1 or non-negative");
        return new EntityInteractionOperation(player, bound, holdTicks);
    }

    private static final class EntityInteractionOperation implements Operation {
        private final BotPlayer player;
        private final BoundEntity bound;
        private final int holdTicks;
        private Interaction interaction;
        private long holdUntil = -1L;
        private Step terminal;

        private EntityInteractionOperation(BotPlayer player, BoundEntity bound, int holdTicks) {
            this.player = player;
            this.bound = bound;
            this.holdTicks = holdTicks;
        }

        @Override public Step tick() {
            if (terminal != null) return terminal;
            EntityCheck checked = verifyEntity(player, bound, 3.0);
            if (checked == null) return terminal = new Failed(new Failure(
                    FailureCode.TARGET_CHANGED,
                    "the exact entity UUID no longer resolves within native reach and first-hit LOS",
                    null));
            if (interaction == null) {
                interaction = Interaction.forHit(player, checked.hit(), Interaction.Button.USE,
                        holdTicks);
                if (holdTicks > 0) holdUntil = player.level().getGameTime() + holdTicks;
            }
            if (holdUntil >= 0 && player.level().getGameTime() >= holdUntil) {
                interaction.stop();
                KnowledgeRevision revision = publishEntityOutcome(player, bound, checked.entity());
                return terminal = new Succeeded(new EntityOutcome("entity_interacted",
                        bound.uuid(), checked.entity().isRemoved()), revision);
            }
            return switch (interaction.tick()) {
                case RUNNING -> new Running();
                case FAILED -> terminal = new Failed(new Failure(
                        FailureCode.VERIFICATION_FAILED, interaction.failReason(), null));
                case DONE -> {
                    KnowledgeRevision revision = publishEntityOutcome(player, bound, checked.entity());
                    yield terminal = new Succeeded(new EntityOutcome("entity_interacted",
                            bound.uuid(), checked.entity().isRemoved()), revision);
                }
            };
        }

        @Override public void cancel() {
            if (interaction != null) interaction.stop();
            if (terminal == null) terminal = new Failed(new Failure(
                    FailureCode.VERIFICATION_FAILED, "physical action was interrupted", null));
        }
    }

    public sealed interface Step permits Running, Succeeded, Failed {}
    public record Running() implements Step {}
    public record Succeeded(Outcome outcome, KnowledgeRevision publication) implements Step {}
    public record Failed(Failure failure) implements Step {}

    public interface Operation extends AutoCloseable {
        Step tick();
        void cancel();
        /** Attributable facts already verified before a later cancellation or terminal result. */
        default Outcome verifiedOutcome() { return null; }
        @Override default void close() { cancel(); }
    }

    public sealed interface Probe permits Ready, Unavailable {}
    public record Ready(BlockPos hitPosition, Direction face) implements Probe {}
    public record Unavailable(Failure failure) implements Probe {}

    /** Side-effect-free physical feasibility probe; failed probes restore the caller's view. */
    public static Probe probe(BotPlayer player, ExactBlockAction action) {
        Objects.requireNonNull(player, "player");
        Objects.requireNonNull(action, "action");
        if (action instanceof Place place) {
            try (var lease = new VerifiedBlockInteraction.ExactMainHandLease(
                    player, place.item(), true)) {
                PlacementContextResolver.Resolution resolution = PlacementContextResolver.resolve(
                        player, place.target(), place.blockItem(), lease.current());
                if (resolution instanceof PlacementContextResolver.Ready ready) {
                    return new Ready(ready.hit().getBlockPos(), ready.hit().getDirection());
                }
                return new Unavailable(placementFailure(
                        (PlacementContextResolver.Unavailable) resolution));
            } catch (IllegalStateException missingItem) {
                return new Unavailable(new Failure(FailureCode.ITEM_NOT_FOUND,
                        "requested item is not carried", null));
            }
        }
        Failure mismatch = mismatch(player, action.target(), false);
        if (mismatch != null) return new Unavailable(mismatch);
        if (action instanceof UseItemOn use && fluidBucket(use.item())) {
            try (var lease = new VerifiedBlockInteraction.ExactMainHandLease(
                    player, use.item(), true)) {
                BlockPos target = use.target().position();
                if (VerifiedBlockInteraction.emptyBucketWithoutSource(player, target, use.item())) {
                    return new Unavailable(bucketFailure(player, target, use.item()));
                }
                BlockHitResult hit = VerifiedBlockInteraction.resolveBucketHit(player, target, use.item());
                return hit == null ? new Unavailable(bucketFailure(player, target, use.item()))
                        : new Ready(hit.getBlockPos(), hit.getDirection());
            } catch (IllegalStateException missingItem) {
                return new Unavailable(new Failure(FailureCode.ITEM_NOT_FOUND,
                        "requested item is not carried", null));
            }
        }
        BlockHitResolver.Resolution resolved = BlockHitResolver.resolveTargetHit(
                player, action.target().position());
        return resolved.hit() == null ? new Unavailable(hitFailure(resolved))
                : new Ready(resolved.hit().getBlockPos(), resolved.hit().getDirection());
    }

    /** Begin one exact physical result. The returned operation owns all native action state. */
    public static Operation begin(BotPlayer player, ExactBlockAction action) {
        Objects.requireNonNull(player, "player");
        Objects.requireNonNull(action, "action");
        if (action instanceof Activate activate) return new ActivateOperation(player, activate);
        if (action instanceof UseItemOn use) return new ItemUseOperation(player, use);
        if (action instanceof UseAtAir use) return new AirUseOperation(player, use);
        if (action instanceof Place place) return new PlacementOperation(player, place);
        if (action instanceof Break breaking) return new BreakOperation(player, breaking);
        return new SleepOperation(player, (Sleep) action);
    }

    public record BlockOutcome(BlockPos position, BlockState state, BlockEvidenceSource source) {
        public BlockOutcome {
            position = Objects.requireNonNull(position, "position").immutable();
            Objects.requireNonNull(state, "state");
            Objects.requireNonNull(source, "source");
        }
    }

    public static KnowledgeRevision publishBlockOutcomes(
            net.minecraft.server.MinecraftServer server, String dimension, long observedTick,
            List<BlockOutcome> outcomes) {
        return RuntimeBotManager.publishAttributable(Objects.requireNonNull(server, "server"),
                attributableUpdate(dimension, observedTick, outcomes));
    }

    static AttributableWorldUpdate attributableUpdate(
            String dimension, long observedTick, List<BlockOutcome> outcomes) {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(outcomes, "outcomes");
        return new AttributableWorldUpdate(outcomes.stream().map(outcome ->
                new AttributableWorldUpdate.BlockFact(dimension, observedTick,
                                BlockObservation.of(outcome.position(), outcome.state(),
                                outcome.source()))).toList(), List.of(), List.of());
    }

    static AttributableWorldUpdate attributableEntityUpdate(
            String dimension, long observedTick, List<EntityObservation> observations,
            List<java.util.UUID> removed) {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(observations, "observations");
        Objects.requireNonNull(removed, "removed");
        return new AttributableWorldUpdate(List.of(), observations.stream()
                .map(observation -> new AttributableWorldUpdate.EntityFact(
                        dimension, observedTick, observation)).toList(), removed);
    }

    public static void publishBlockOutcome(
            net.minecraft.server.MinecraftServer server, String dimension, long observedTick,
            BlockPos position, BlockState state, BlockEvidenceSource source) {
        publishBlockOutcomes(server, dimension, observedTick,
                List.of(new BlockOutcome(position, state, source)));
    }

    static String liveBlockState(BotPlayer player, BlockPos position) {
        return BlockEvidenceCell.canonicalBlockState(
                player.level().getBlockState(Objects.requireNonNull(position, "position")));
    }

    private abstract static class BaseOperation implements Operation {
        final BotPlayer player;
        final ExactBlockAction action;
        final float startYaw;
        final float startPitch;
        final float startHeadYaw;
        Step terminal;
        boolean viewRestored;

        BaseOperation(BotPlayer player, ExactBlockAction action) {
            this.player = player;
            this.action = action;
            this.startYaw = player.getYRot();
            this.startPitch = player.getXRot();
            this.startHeadYaw = player.getYHeadRot();
        }

        final Step terminal(Step step) {
            terminal = step;
            cancelNative();
            restoreView();
            return step;
        }

        final Failed fail(Failure failure) { return (Failed) terminal(new Failed(failure)); }
        final Failure verifyBoundTarget() { return mismatch(player, action.target(), true); }
        final KnowledgeRevision publish(List<BlockOutcome> blocks) {
            if (!RuntimeBotManager.isRuntimeBot(player)) return null;
            return publishBlockOutcomes(player.getServer(), dimension(player),
                    player.getServer().getTickCount(), blocks);
        }

        @Override public final void cancel() {
            if (terminal == null) terminal = new Failed(new Failure(
                    FailureCode.VERIFICATION_FAILED, "physical action was interrupted", null));
            cancelNative();
            restoreView();
        }

        private void restoreView() {
            if (viewRestored) return;
            player.setYRot(startYaw);
            player.setXRot(startPitch);
            player.setYHeadRot(startHeadYaw);
            viewRestored = true;
        }

        abstract void cancelNative();
    }

    private static final class ActivateOperation extends BaseOperation {
        final Activate activate;
        VerifiedBlockInteraction.NeutralMainHandLease lease;
        Interaction interaction;
        BlockState before;

        ActivateOperation(BotPlayer player, Activate activate) {
            super(player, activate);
            this.activate = activate;
        }

        @Override public Step tick() {
            if (terminal != null) return terminal;
            if (interaction == null) {
                Failure mismatch = verifyBoundTarget();
                if (mismatch != null) return fail(mismatch);
                BlockHitResolver.Resolution resolved = BlockHitResolver.resolveTargetHit(
                        player, activate.target().position());
                if (resolved.hit() == null) return fail(hitFailure(resolved));
                lease = new VerifiedBlockInteraction.NeutralMainHandLease(player);
                before = player.level().getBlockState(activate.target().position());
                interaction = Interaction.useBlockExactHand(
                        player, resolved.hit(), InteractionHand.MAIN_HAND);
            }
            return switch (interaction.tick()) {
                case RUNNING -> new Running();
                case FAILED -> fail(new Failure(FailureCode.OCCLUDED,
                        interaction.failReason(), null));
                case DONE -> complete();
            };
        }

        private Step complete() {
            BlockState after = player.level().getBlockState(activate.target().position());
            if (player.containerMenu != player.inventoryMenu) {
                KnowledgeRevision revision = publish(List.of(new BlockOutcome(
                        activate.target().position(), after, BlockEvidenceSource.ATTRIBUTABLE_ACTION)));
                return terminal(new Succeeded(new ActivationOutcome("menu_opened", null), revision));
            }
            if (!after.equals(before)) {
                KnowledgeRevision revision = publish(List.of(new BlockOutcome(
                        activate.target().position(), after, BlockEvidenceSource.ATTRIBUTABLE_ACTION)));
                return terminal(new Succeeded(new ActivationOutcome("block_state_changed",
                        BlockEvidenceCell.canonicalBlockState(after)), revision));
            }
            publish(List.of(new BlockOutcome(activate.target().position(), after,
                    activate.rawInteraction() ? BlockEvidenceSource.MISMATCH
                            : BlockEvidenceSource.ATTRIBUTABLE_ACTION)));
            return fail(new Failure(FailureCode.NO_EFFECT,
                    activate.rawInteraction()
                            ? "right-click had no effect on the evidence-bound target"
                            : "activation produced no verified Menu or target BlockState change",
                    null));
        }

        @Override void cancelNative() {
            if (interaction != null) interaction.stop();
            if (lease != null) { lease.close(); lease = null; }
        }
    }

    private static final class PlacementOperation extends BaseOperation {
        final Place place;
        VerifiedBlockInteraction.ExactMainHandLease lease;
        Interaction interaction;
        List<PlacementContextResolver.PlacedCell> predicted;
        List<BlockState> before;
        List<BlockOutcome> captured;
        int consumed;
        int expectedConsumption;
        boolean capturedOutcome;
        PlacementOutcome verified;
        KnowledgeRevision publication;

        PlacementOperation(BotPlayer player, Place place) {
            super(player, place);
            this.place = place;
        }

        @Override public Step tick() {
            if (terminal != null) return terminal;
            if (capturedOutcome) return finishCaptured();
            if (interaction == null) {
                try {
                    lease = new VerifiedBlockInteraction.ExactMainHandLease(
                            player, place.item(), true);
                } catch (IllegalStateException missing) {
                    return fail(new Failure(FailureCode.ITEM_NOT_FOUND,
                            "requested BlockItem is not carried", null));
                }
                PlacementContextResolver.Resolution resolution = PlacementContextResolver.resolve(
                        player, place.target(), place.blockItem(), lease.current());
                if (resolution instanceof PlacementContextResolver.Unavailable unavailable) {
                    return fail(placementFailure(unavailable));
                }
                PlacementContextResolver.Ready ready = (PlacementContextResolver.Ready) resolution;
                predicted = ready.cells();
                before = predicted.stream()
                        .map(cell -> player.level().getBlockState(cell.position())).toList();
                expectedConsumption = player.getAbilities().instabuild ? 0 : 1;
                interaction = Interaction.useBlockExactHand(
                        player, ready.hit(), InteractionHand.MAIN_HAND);
            }
            return switch (interaction.tick()) {
                case RUNNING -> new Running();
                case FAILED -> fail(new Failure(FailureCode.OCCLUDED,
                        interaction.failReason(), null));
                case DONE -> {
                    captured = predicted.stream().map(cell -> new BlockOutcome(cell.position(),
                            player.level().getBlockState(cell.position()), BlockEvidenceSource.ATTRIBUTABLE_ACTION)).toList();
                    consumed = Math.max(0, lease.before().getCount() - lease.current().getCount());
                    capturedOutcome = true;
                    // Publish the whole native footprint once, before an interruption can settle.
                    publication = publish(captured);
                    verified = new PlacementOutcome(BlockEvidenceCell.canonicalBlockState(captured.getFirst().state()),
                            consumed, captured.stream().filter(cell -> !cell.state().isAir())
                                    .map(cell -> new PlacedBlock(cell.position(),
                                            BlockEvidenceCell.canonicalBlockState(cell.state()))).toList());
                    yield new Running();
                }
            };
        }

        private Step finishCaptured() {
            boolean unchanged = true;
            for (int index = 0; index < captured.size(); index++) {
                unchanged &= captured.get(index).state().equals(before.get(index));
            }
            if (unchanged) return fail(new Failure(FailureCode.NO_EFFECT,
                    "native placement produced no target-cell effect", null));
            boolean matches = true;
            for (int index = 0; index < predicted.size(); index++) {
                BlockState expected = predicted.get(index).state();
                BlockState actual = captured.get(index).state();
                matches &= predicted.size() > 1 ? actual.equals(expected) : actual.getBlock() == expected.getBlock();
            }
            if (!matches || consumed != expectedConsumption) {
                return fail(new Failure(FailureCode.VERIFICATION_FAILED,
                        "placed state or Inventory delta did not verify", null));
            }
            return terminal(new Succeeded(verified, publication));
        }

        @Override public Outcome verifiedOutcome() { return verified; }

        @Override void cancelNative() {
            if (interaction != null) interaction.stop();
            if (lease != null) { lease.close(); lease = null; }
        }
    }

    private static final class ItemUseOperation extends BaseOperation {
        final UseItemOn use;
        VerifiedBlockInteraction.ExactMainHandLease lease;
        Interaction interaction;
        BlockState beforeTarget;
        BlockState beforeAdjacent;
        BlockPos adjacent;
        Direction face;
        boolean captured;
        BlockState capturedTarget;
        BlockState capturedAdjacent;
        String resultingItemId;
        int consumed;
        int durability;

        ItemUseOperation(BotPlayer player, UseItemOn use) {
            super(player, use);
            this.use = use;
        }

        @Override public Step tick() {
            if (terminal != null) return terminal;
            if (captured) return finishCaptured();
            if (interaction == null) {
                Failure mismatch = verifyBoundTarget();
                if (mismatch != null) return fail(mismatch);
                try {
                    lease = new VerifiedBlockInteraction.ExactMainHandLease(player, use.item(), true);
                } catch (IllegalStateException missing) {
                    return fail(new Failure(FailureCode.ITEM_NOT_FOUND,
                            "requested item is not carried", null));
                }
                boolean bucketUse = fluidBucket(use.item())
                        && !(player.level().getBlockState(use.target().position()).getBlock()
                                instanceof AbstractCauldronBlock);
                BlockHitResult hit;
                if (bucketUse) {
                    if (VerifiedBlockInteraction.emptyBucketWithoutSource(
                            player, use.target().position(), use.item())) {
                        return fail(bucketFailure(player, use.target().position(), use.item()));
                    }
                    ClipContext.Fluid fluids = VerifiedBlockInteraction.bucketRayFluids(use.item());
                    BlockHitResult aimed = VerifiedBlockInteraction.resolveBucketHit(
                            player, use.target().position(), use.item());
                    if (aimed == null) {
                        Failure miss = bucketFailure(player, use.target().position(), use.item());
                        // The named first hit lies on the bot's own line of sight; publish it.
                        if (miss.occludingBlock() != null) recordOccluder(player, miss.occludingBlock());
                        return fail(miss);
                    }
                    // BucketItem.use performs its own full-length POV ray. Resolve that exact ray
                    // after aiming, before the one native use, so it cannot mutate another target.
                    InputDriver.lookAt(player, aimed.getLocation());
                    var eye = player.getEyePosition();
                    hit = player.level().clip(new ClipContext(eye,
                            eye.add(player.getViewVector(1.0F).scale(player.blockInteractionRange())),
                            ClipContext.Block.OUTLINE, fluids, player));
                    boolean clickedNeighbor = !aimed.getBlockPos().equals(use.target().position());
                    if (hit.getType() != HitResult.Type.BLOCK
                            || !hit.getBlockPos().equals(aimed.getBlockPos())
                            || (clickedNeighbor && hit.getDirection() != aimed.getDirection())) {
                        return fail(new Failure(FailureCode.OCCLUDED,
                                "native bucket ray does not match the evidence-bound target", null));
                    }
                } else {
                    // One shape-aware resolver for probe and execution.
                    BlockHitResolver.Resolution resolved = BlockHitResolver.resolveTargetHit(
                            player, use.target().position());
                    if (resolved.hit() == null) return fail(hitFailure(resolved));
                    hit = resolved.hit();
                }
                face = hit.getDirection();
                beforeTarget = player.level().getBlockState(use.target().position());
                adjacent = use.target().position().relative(face);
                beforeAdjacent = player.level().getBlockState(adjacent);
                interaction = bucketUse
                        ? Interaction.useInAir(player, InteractionHand.MAIN_HAND, Interaction.Timing.once())
                        : Interaction.useBlockExactHand(player, hit, InteractionHand.MAIN_HAND);
            }
            return switch (interaction.tick()) {
                case RUNNING -> new Running();
                case FAILED -> fail(new Failure(FailureCode.OCCLUDED,
                        interaction.failReason(), null));
                case DONE -> {
                    captureItem();
                    capturedTarget = player.level().getBlockState(use.target().position());
                    capturedAdjacent = player.level().getBlockState(adjacent);
                    captured = true;
                    // Instant bucket conversion and its attributable world change settle together.
                    yield fluidBucket(use.item()) ? finishCaptured() : new Running();
                }
            };
        }

        private Step finishCaptured() {
            List<BlockOutcome> blocks = changedItemUseBlocks(use.target().position(), beforeTarget,
                    capturedTarget, adjacent, beforeAdjacent, capturedAdjacent);
            String outcome = null;
            BlockPos effect = null;
            BlockState effectState = null;
            if (!capturedTarget.equals(beforeTarget)) {
                outcome = "target_block_changed";
                effect = use.target().position();
                effectState = capturedTarget;
            }
            if (!capturedAdjacent.equals(beforeAdjacent)) {
                if (outcome == null) outcome = "adjacent_block_changed";
                if (effect == null) {
                    effect = adjacent;
                    effectState = capturedAdjacent;
                }
            }
            if (outcome == null && (consumed > 0 || durability > 0 || resultingItemId != null)) {
                outcome = "item_changed";
            }
            if (outcome == null) return fail(new Failure(FailureCode.NO_EFFECT,
                    "item use produced no verified requested-item or local BlockState effect", null));
            KnowledgeRevision revision = publish(blocks);
            return terminal(new Succeeded(new ItemUseOutcome(outcome, face, effect,
                    effectState == null ? null : BlockEvidenceCell.canonicalBlockState(effectState),
                    resultingItemId, consumed, durability), revision));
        }

        private void captureItem() {
            ItemStack before = lease.before();
            ItemStack after = lease.current();
            consumed = Math.max(0, before.getCount() - after.getCount());
            if (before.isDamageableItem()) {
                durability = after.isEmpty()
                        ? Math.max(0, before.getMaxDamage() - before.getDamageValue())
                        : after.is(before.getItem())
                        ? Math.max(0, after.getDamageValue() - before.getDamageValue()) : 0;
            }
            if (!after.isEmpty() && !after.is(before.getItem())) {
                resultingItemId = BuiltInRegistries.ITEM.getKey(after.getItem()).toString();
            }
        }

        @Override void cancelNative() {
            if (interaction != null) interaction.stop();
            if (lease != null) { lease.close(); lease = null; }
        }
    }

    private static Failure bucketFailure(BotPlayer player, BlockPos target, Item bucket) {
        VerifiedBlockInteraction.BucketMiss miss =
                VerifiedBlockInteraction.explainBucketMiss(player, target, bucket);
        String held = BlockEvidenceCell.canonicalBlockState(player.level().getBlockState(target));
        return switch (miss.kind()) {
            case NOT_FLUID_SOURCE -> new Failure(FailureCode.NOT_FLUID_SOURCE,
                    "the target holds " + held + ", which is not a fluid source; an empty bucket "
                            + "only picks up a source cell (level=0)", null);
            case NO_SUPPORT_FACE -> new Failure(FailureCode.NO_SUPPORT,
                    "no block face borders the target " + held + "; a full bucket empties into "
                            + "the cell beside a clicked block face", null);
            case OUT_OF_REACH -> new Failure(FailureCode.OUT_OF_REACH,
                    "no point of the target " + held + " is within native reach", null);
            case OCCLUDED -> new Failure(FailureCode.OCCLUDED, miss.blocker() == null
                    ? "no point of the target " + held + " is the native first hit"
                    : "the view toward the target " + held + " first hits "
                            + BlockEvidenceCell.canonicalBlockState(miss.blockerState()) + " at "
                            + miss.blocker().toShortString(), miss.blocker());
        };
    }

    private static boolean fluidBucket(Item item) {
        return item == Items.BUCKET || item == Items.WATER_BUCKET || item == Items.LAVA_BUCKET;
    }

    static List<BlockOutcome> changedItemUseBlocks(
            BlockPos target, BlockState beforeTarget, BlockState afterTarget,
            BlockPos adjacent, BlockState beforeAdjacent, BlockState afterAdjacent) {
        List<BlockOutcome> blocks = new ArrayList<>(2);
        if (!afterTarget.equals(beforeTarget)) blocks.add(new BlockOutcome(
                target, afterTarget, BlockEvidenceSource.ATTRIBUTABLE_ACTION));
        if (!afterAdjacent.equals(beforeAdjacent)) blocks.add(new BlockOutcome(
                adjacent, afterAdjacent, BlockEvidenceSource.ATTRIBUTABLE_ACTION));
        return List.copyOf(blocks);
    }

    private static final class AirUseOperation extends BaseOperation {
        final UseAtAir use;
        VerifiedBlockInteraction.ExactMainHandLease lease;
        Interaction interaction;
        long holdUntil = -1L;

        AirUseOperation(BotPlayer player, UseAtAir use) {
            super(player, use);
            this.use = use;
        }

        @Override public Step tick() {
            if (terminal != null) return terminal;
            if (interaction == null) {
                Failure mismatch = verifyBoundTarget();
                if (mismatch != null) return fail(mismatch);
                if (use.item() != null) {
                    try {
                        lease = new VerifiedBlockInteraction.ExactMainHandLease(
                                player, use.item(), true);
                    } catch (IllegalStateException missing) {
                        return fail(new Failure(FailureCode.ITEM_NOT_FOUND,
                                "requested item is not carried", null));
                    }
                }
                InputDriver.lookAt(player, net.minecraft.world.phys.Vec3.atCenterOf(
                        use.target().position()));
                HitResult hit = Interaction.nativeRaytrace(player, player.blockInteractionRange());
                if (hit.getType() != HitResult.Type.MISS) {
                    BlockPos blocker = hit instanceof BlockHitResult block
                            ? block.getBlockPos() : null;
                    if (blocker != null) recordOccluder(player, blocker);
                    return fail(new Failure(FailureCode.OCCLUDED,
                            "native first hit does not match the evidence-bound air aim", blocker));
                }
                interaction = Interaction.forHit(
                        player, hit, Interaction.Button.USE, use.holdTicks());
                if (interaction == null) return fail(new Failure(FailureCode.NO_EFFECT,
                        "native air use produced no action", null));
                if (use.holdTicks() > 0) {
                    holdUntil = player.level().getGameTime() + use.holdTicks();
                }
            }
            if (holdUntil >= 0L && player.level().getGameTime() >= holdUntil) {
                interaction.stop();
                return complete();
            }
            return switch (interaction.tick()) {
                case RUNNING -> new Running();
                case FAILED -> fail(new Failure(FailureCode.NO_EFFECT,
                        interaction.failReason(), null));
                case DONE -> complete();
            };
        }

        private Step complete() {
            if (!interaction.lastUseConsumed()) return fail(new Failure(FailureCode.NO_EFFECT,
                    "right-click had no effect on the evidence-bound air aim", null));
            BlockState state = player.level().getBlockState(use.target().position());
            KnowledgeRevision revision = publish(List.of(new BlockOutcome(
                    use.target().position(), state, BlockEvidenceSource.ATTRIBUTABLE_ACTION)));
            return terminal(new Succeeded(new ActivationOutcome("air_item_used",
                    state.isAir() ? null : BlockEvidenceCell.canonicalBlockState(state)), revision));
        }

        @Override void cancelNative() {
            if (interaction != null) interaction.stop();
            if (lease != null) { lease.close(); lease = null; }
        }
    }

    private static final class BreakOperation extends BaseOperation {
        /**
         * Ticks the button stays held while nothing of the target is in sight (a mob crossing
         * the ray) before the break fails as occluded. Like a vanilla client, losing sight aborts
         * the dig and resets its progress; when the target is visible again the dig restarts.
         */
        static final int OCCLUSION_WAIT_TICKS = 10;

        final Break breaking;
        Interaction interaction;
        BlockHitResult boundHit;
        int occludedTicks;
        long holdUntil = -1L;
        AABB dropArea;
        final Set<java.util.UUID> preexistingDrops = new HashSet<>();

        BreakOperation(BotPlayer player, Break breaking) {
            super(player, breaking);
            this.breaking = breaking;
        }

        @Override public Step tick() {
            if (terminal != null) return terminal;
            if (interaction == null) {
                Failure mismatch = verifyBoundTarget();
                if (mismatch != null) return fail(mismatch);
                BlockState live = player.level().getBlockState(breaking.target().position());
                if (live.getDestroySpeed(player.level(), breaking.target().position()) < 0.0F) {
                    return fail(new Failure(FailureCode.UNBREAKABLE,
                            "the exact target is unbreakable", null));
                }
                BlockHitResolver.Resolution resolved = BlockHitResolver.resolveTargetHit(
                        player, breaking.target().position());
                if (resolved.hit() == null) {
                    if (resolved.blocker() instanceof BlockHitResult blocker) {
                        recordOccluder(player, blocker.getBlockPos());
                    }
                    return fail(hitFailure(resolved));
                }
                boundHit = resolved.hit();
                if (!player.getAbilities().instabuild) {
                    ToolSelect.holdBestTool(player, live);
                }
                dropArea = new AABB(breaking.target().position()).inflate(1.0);
                // Every item already in the level is older than this break, wherever it lies:
                // one that drifts into the drop area while the block is mined is not its drop.
                player.serverLevel()
                        .getEntities(EntityTypeTest.forClass(ItemEntity.class), item -> true)
                        .forEach(item -> preexistingDrops.add(item.getUUID()));
                interaction = Interaction.forHit(player, boundHit,
                        Interaction.Button.ATTACK, breaking.holdTicks());
                if (breaking.holdTicks() > 0) {
                    holdUntil = player.level().getGameTime() + breaking.holdTicks();
                }
            }
            BlockState live = player.level().getBlockState(breaking.target().position());
            if (live.isAir()) return complete();
            if (!breaking.target().evidence().matches(live)) {
                publish(List.of(new BlockOutcome(breaking.target().position(), live,
                        BlockEvidenceSource.MISMATCH)));
                return fail(new Failure(FailureCode.TARGET_CHANGED,
                        "the exact target changed while the break was in progress", null));
            }
            BlockPos target = breaking.target().position();
            InputDriver.lookAt(player, boundHit.getLocation());
            HitResult ray = Interaction.nativeRaytrace(player, player.blockInteractionRange());
            if (!(ray instanceof BlockHitResult block) || !block.getBlockPos().equals(target)) {
                // A client keeps digging while its crosshair moves to another point of the same
                // block, so re-aim at one that is visible within reach before giving up the dig.
                BlockHitResolver.Resolution again = BlockHitResolver.resolveTargetHit(player, target);
                if (again.hit() != null) {
                    boundHit = again.hit();
                    interaction.retarget(boundHit);
                    InputDriver.lookAt(player, boundHit.getLocation());
                } else if (again.failure() == BlockHitResolver.Failure.OUT_OF_REACH) {
                    return fail(new Failure(FailureCode.OUT_OF_REACH,
                            "no point of the target is within native reach any more", null));
                } else {
                    // Nothing of the target is in sight: abort the dig as a client does when its
                    // crosshair leaves the block, then keep holding in case the sight line clears.
                    if (occludedTicks++ == 0) interaction.stop();
                    if (occludedTicks > OCCLUSION_WAIT_TICKS) {
                        BlockPos blocker = ray instanceof BlockHitResult blocked ? blocked.getBlockPos() : null;
                        if (blocker != null) recordOccluder(player, blocker);
                        return fail(new Failure(FailureCode.OCCLUDED,
                                "the exact target stayed occluded while the break was in progress",
                                blocker));
                    }
                    return new Running();
                }
            }
            occludedTicks = 0;
            if (holdUntil >= 0L && player.level().getGameTime() >= holdUntil) {
                interaction.stop();
                return fail(new Failure(FailureCode.NO_EFFECT,
                        "hold duration ended before the exact target disappeared", null));
            }
            return switch (interaction.tick()) {
                case RUNNING -> new Running();
                case FAILED -> fail(new Failure(FailureCode.OCCLUDED,
                        interaction.failReason(), null));
                case DONE -> player.level().getBlockState(breaking.target().position()).isAir()
                        ? complete() : fail(new Failure(FailureCode.NO_EFFECT,
                        "the native break completed without removing the exact target", null));
            };
        }

        private Step complete() {
            List<ItemEntity> drops = player.level().getEntitiesOfClass(ItemEntity.class, dropArea)
                    .stream().filter(item -> !item.isRemoved()
                            && !preexistingDrops.contains(item.getUUID()))
                    .sorted(Comparator.comparing(item -> item.getUUID().toString())).toList();
            String dimension = dimension(player);
            long tick = player.getServer().getTickCount();
            List<EntityObservation> observations = drops.stream().map(item ->
                    EntityObservation.attributable(item.getUUID(),
                            BuiltInRegistries.ENTITY_TYPE.getKey(item.getType()).toString(),
                            BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString(),
                            item.getItem().getCount(), item.position(), null, null)).toList();
            AttributableWorldUpdate update = new AttributableWorldUpdate(List.of(
                    new AttributableWorldUpdate.BlockFact(dimension, tick,
                            BlockObservation.of(breaking.target().position(),
                                    player.level().getBlockState(breaking.target().position()),
                                    BlockEvidenceSource.ATTRIBUTABLE_ACTION))),
                    observations.stream().map(observation ->
                            new AttributableWorldUpdate.EntityFact(dimension, tick, observation)).toList(),
                    List.of());
            KnowledgeRevision revision = RuntimeBotManager.isRuntimeBot(player)
                    ? RuntimeBotManager.publishAttributable(player.getServer(), update) : null;
            return terminal(new Succeeded(new BreakOutcome(observations), revision));
        }

        @Override void cancelNative() { if (interaction != null) interaction.stop(); }
    }

    private static final class SleepOperation extends BaseOperation {
        final Sleep sleep;
        VerifiedBlockInteraction.NeutralMainHandLease lease;
        Interaction interaction;
        BlockPos requested;
        BlockPos head;
        BlockState requestedState;
        BlockState headState;

        SleepOperation(BotPlayer player, Sleep sleep) {
            super(player, sleep);
            this.sleep = sleep;
        }

        @Override public Step tick() {
            if (terminal != null) return terminal;
            if (interaction == null) {
                Failure mismatch = verifyBoundTarget();
                if (mismatch != null) return fail(mismatch);
                requested = sleep.target().position();
                requestedState = player.level().getBlockState(requested);
                if (!(requestedState.getBlock() instanceof BedBlock)) {
                    return fail(new Failure(FailureCode.TARGET_CHANGED,
                            "the exact target is no longer a bed", null));
                }
                head = requestedState.getValue(BedBlock.PART) == BedPart.HEAD
                        ? requested : requested.relative(requestedState.getValue(BedBlock.FACING));
                headState = player.level().getBlockState(head);
                if (!(headState.getBlock() instanceof BedBlock)
                        || headState.getValue(BedBlock.PART) != BedPart.HEAD) {
                    return fail(new Failure(FailureCode.TARGET_CHANGED,
                            "the exact target is no longer a complete bed", null));
                }
                if (!player.level().dimensionType().bedWorks()) {
                    return fail(new Failure(FailureCode.BED_NOT_USABLE,
                            "bed use is explosive in this dimension; native activation was refused", null));
                }
                if (headState.getValue(BedBlock.OCCUPIED)) {
                    return fail(new Failure(FailureCode.OCCUPIED, "the bed is occupied", null));
                }
                BlockHitResolver.Resolution resolved = BlockHitResolver.resolveTargetHit(
                        player, requested);
                if (resolved.hit() == null) {
                    if (resolved.blocker() instanceof BlockHitResult blocker) {
                        recordOccluder(player, blocker.getBlockPos());
                    }
                    return fail(hitFailure(resolved));
                }
                lease = new VerifiedBlockInteraction.NeutralMainHandLease(player);
                interaction = Interaction.useBlockExactHand(
                        player, resolved.hit(), InteractionHand.MAIN_HAND);
            }
            return switch (interaction.tick()) {
                case RUNNING -> new Running();
                case FAILED -> fail(new Failure(FailureCode.OCCLUDED,
                        interaction.failReason(), null));
                case DONE -> finishSleep();
            };
        }

        private Step finishSleep() {
            if (!player.isSleeping()) {
                var result = player.startSleepInBed(head);
                Player.BedSleepingProblem rejection = result.left().orElse(null);
                if (rejection != null) {
                    return fail(new Failure(bedFailureCode(rejection),
                            bedFailureMessage(rejection), null));
                }
            }
            if (!player.isSleeping()) {
                return fail(new Failure(FailureCode.ACCEPTED_NOT_SLEEPING,
                        "the sleep request was accepted but the Runtime Bot did not enter sleep", null));
            }
            List<BlockOutcome> facts = requested.equals(head)
                    ? List.of(new BlockOutcome(head, headState,
                            BlockEvidenceSource.ATTRIBUTABLE_ACTION))
                    : List.of(
                            new BlockOutcome(requested, requestedState,
                                    BlockEvidenceSource.ATTRIBUTABLE_ACTION),
                            new BlockOutcome(head, headState,
                                    BlockEvidenceSource.ATTRIBUTABLE_ACTION));
            KnowledgeRevision revision = publish(facts);
            return terminal(new Succeeded(new SleepOutcome(head), revision));
        }

        @Override void cancelNative() {
            if (interaction != null) interaction.stop();
            if (lease != null) { lease.close(); lease = null; }
        }
    }

    private static Failure mismatch(
            BotPlayer player, BoundBlock target, boolean publishMismatch) {
        BlockState live = player.level().getBlockState(target.position());
        if (target.evidence().matches(live)) return null;
        if (publishMismatch && RuntimeBotManager.isRuntimeBot(player)) {
            publishBlockOutcomes(player.getServer(), dimension(player),
                    player.getServer().getTickCount(), List.of(new BlockOutcome(
                            target.position(), live, BlockEvidenceSource.MISMATCH)));
        }
        return new Failure(FailureCode.TARGET_CHANGED,
                "target no longer matches its bound World Knowledge fact", null);
    }

    private static void recordOccluder(BotPlayer player, BlockPos blocker) {
        if (!RuntimeBotManager.isRuntimeBot(player)) return;
        BlockState state = player.level().getBlockState(blocker);
        publishBlockOutcomes(player.getServer(), dimension(player), player.getServer().getTickCount(),
                List.of(new BlockOutcome(blocker, state, BlockEvidenceSource.MISMATCH)));
    }

    public static FailureCode bedFailureCode(Player.BedSleepingProblem problem) {
        return switch (problem) {
            case NOT_POSSIBLE_HERE -> FailureCode.BED_NOT_USABLE;
            case NOT_POSSIBLE_NOW -> FailureCode.NOT_SLEEP_TIME;
            case TOO_FAR_AWAY -> FailureCode.OUT_OF_REACH;
            case OBSTRUCTED -> FailureCode.OBSTRUCTED;
            case OTHER_PROBLEM -> FailureCode.OCCUPIED;
            case NOT_SAFE -> FailureCode.UNSAFE;
        };
    }

    public static String bedFailureType(
            Player.BedSleepingProblem problem, boolean sleeping) {
        return problem == null ? sleeping ? null : FailureCode.ACCEPTED_NOT_SLEEPING.wireValue()
                : bedFailureCode(problem).wireValue();
    }

    public static String bedFailureMessage(Player.BedSleepingProblem problem) {
        var message = problem.getMessage();
        return message == null ? "the bed refused entry (" + problem.name().toLowerCase(
                java.util.Locale.ROOT) + ")" : message.getString();
    }

    private static Failure hitFailure(BlockHitResolver.Resolution resolved) {
        if (resolved.failure() == BlockHitResolver.Failure.OUT_OF_REACH) {
            return new Failure(FailureCode.OUT_OF_REACH,
                    "no target outline point is within native reach", null);
        }
        if (resolved.failure() == BlockHitResolver.Failure.UNSUPPORTED_SHAPE) {
            return new Failure(FailureCode.UNSUPPORTED_SHAPE,
                    "the target outline cannot be resolved safely: " + resolved.detail(), null);
        }
        BlockPos blocker = resolved.blocker() instanceof BlockHitResult block
                ? block.getBlockPos() : null;
        return new Failure(FailureCode.OCCLUDED,
                "no target outline point is the native first hit", blocker);
    }

    private static Failure placementFailure(PlacementContextResolver.Unavailable unavailable) {
        FailureCode code = switch (unavailable.reason()) {
            case SECOND_CELL_NOT_FREE -> FailureCode.SECOND_CELL_NOT_FREE;
            case BODY_IN_TARGET -> FailureCode.BODY_IN_TARGET;
            case TARGET_CHANGED -> FailureCode.TARGET_CHANGED;
            case OUT_OF_REACH -> FailureCode.OUT_OF_REACH;
            case OCCLUDED -> FailureCode.OCCLUDED;
            case UNSUPPORTED_SHAPE -> FailureCode.UNSUPPORTED_SHAPE;
            case NO_SUPPORT, NO_VIABLE_SUPPORT -> FailureCode.NO_SUPPORT;
            case ENTITY_BLOCKED -> FailureCode.ENTITY_BLOCKED;
        };
        BlockPos blocker = unavailable.blockers().stream()
                .map(PlacementContextResolver.Blocker::position).filter(Objects::nonNull)
                .findFirst().orElse(null);
        // Diagnostics: include each blocker's kind/position/hit point. OCCLUDED is only a category; the
        // cause may be an entity, another block, or an unaligned line of sight, and without details the
        // root cause cannot be told apart.
        String detail = unavailable.blockers().stream()
                .map(b -> b.kind()
                        + (b.position() != null ? "@" + b.position().toShortString() : "")
                        + "@(" + String.format(java.util.Locale.ROOT, "%.2f,%.2f,%.2f",
                                b.location().x, b.location().y, b.location().z) + ")")
                .distinct()
                .reduce((a, b) -> a + ";" + b).orElse(null);
        return new Failure(code, unavailable.message(), blocker, detail);
    }

    private static String dimension(BotPlayer player) {
        return player.level().dimension().location().toString();
    }
}
