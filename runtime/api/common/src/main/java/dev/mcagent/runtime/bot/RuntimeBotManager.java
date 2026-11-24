package dev.mcagent.runtime.bot;

import dev.mcagent.runtime.Constants;
import dev.mcagent.runtime.entity.BotFactory;
import dev.mcagent.runtime.entity.BotLifecycle;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.entity.SafeSpawn;
import dev.mcagent.runtime.evidence.EmbodiedWorldEvidence;
import dev.mcagent.runtime.evidence.EntityObservation;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import dev.mcagent.runtime.knowledge.KnowledgeRevision;
import dev.mcagent.runtime.knowledge.GroundedEvidencePolicy;
import dev.mcagent.runtime.knowledge.WorldKnowledge;
import dev.mcagent.runtime.knowledge.WorldKnowledgeProfile;
import dev.mcagent.runtime.knowledge.loaded.LoadedWorldKnowledge;
import dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTrackerAccess;
import dev.mcagent.runtime.sdk.RuntimeActorView;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/** Owns the single, process-local Runtime Bot for each running Minecraft server. */
public final class RuntimeBotManager {

    private static final Map<MinecraftServer, ActiveRun> RUNS = new IdentityHashMap<>();

    private RuntimeBotManager() {}

    /** Fix Runtime Bot Server Tracking configuration before this World Run creates a body. */
    public static void start(MinecraftServer server, Map<String, String> environment) {
        Objects.requireNonNull(server, "server");
        Objects.requireNonNull(environment, "environment");
        if (RUNS.containsKey(server)) return;
        WorldKnowledgeProfile profile = WorldKnowledgeProfile.from(environment);
        GroundedEvidencePolicy evidencePolicy =
                GroundedEvidencePolicy.from(environment);
        RuntimeBotTracking.start(server, environment);
        RUNS.put(server, new ActiveRun(profile, evidencePolicy));
        Constants.LOG.info(
                "[mc_agent-runtime] World Knowledge Profile fixed as {}; grounded expiry block={} entity={} ticks, field of view {} degrees{}",
                profile.wireValue(), evidencePolicy.blockExpiryTicks(),
                evidencePolicy.entityExpiryTicks(), evidencePolicy.fieldOfViewDegrees(),
                profile == WorldKnowledgeProfile.GROUNDED_EVIDENCE ? "" : " (inactive)");
    }

    /** Refresh only a Bot that an SDK caller explicitly created. */
    public static void tick(MinecraftServer server) {
        Objects.requireNonNull(server, "server");
        ActiveRun active = RUNS.get(server);
        if (active == null || active.body == null) return;
        settlePendingImpacts(active);
        if (active.pendingRespawn != null) {
            BotPlayer unavailable = active.pendingRespawn;
            active.knowledge.publishBodyUnavailable(
                    unavailable.level().dimension().location().toString(),
                    server.getTickCount());
            if (!active.deathFramePublished) {
                active.deathFramePublished = true;
            } else if (active.lifecycle == RuntimeActorView.Lifecycle.DEAD) {
                active.lifecycle = RuntimeActorView.Lifecycle.RESPAWNING;
            } else {
                BotPlayer dead = active.pendingRespawn;
                active.pendingRespawn = null;
                respawnVanilla(server, active, dead);
            }
            return;
        }
        String dimension = active.body.level().dimension().location().toString();
        if (!dimension.equals(active.currentDimension)) {
            active.knowledge.publishBodyUnavailable(
                    active.currentDimension, server.getTickCount());
            active.currentDimension = dimension;
        }
        publishKnowledge(active);
    }

    private static void publishKnowledge(ActiveRun active) {
        var event = new dev.mcagent.runtime.diagnostics.KnowledgePublicationEvent();
        if (!event.isEnabled()) {
            active.knowledge.publish(active.body);
            return;
        }
        var bean = java.lang.management.ManagementFactory.getThreadMXBean();
        var allocation = bean instanceof com.sun.management.ThreadMXBean extended ? extended : null;
        long before = allocation != null && allocation.isThreadAllocatedMemoryEnabled()
                ? allocation.getThreadAllocatedBytes(Thread.currentThread().threadId()) : -1;
        event.profile = active.profile.name().toLowerCase(java.util.Locale.ROOT);
        event.begin();
        try {
            active.knowledge.publish(active.body);
        } finally {
            event.end();
            event.allocatedBytes = before < 0 ? -1
                    : allocation.getThreadAllocatedBytes(Thread.currentThread().threadId()) - before;
            event.commit();
        }
    }

    /** Explicitly create the singleton Bot or resolve the same case-insensitive username. */
    public static RuntimeActorView create(MinecraftServer server, String username) {
        Objects.requireNonNull(server, "server");
        Objects.requireNonNull(username, "username");
        start(server, System.getenv());
        ActiveRun existing = RUNS.get(server);
        if (existing.run != null) {
            String activeName = existing.run.identity().name();
            if (!activeName.equalsIgnoreCase(username)) {
                throw new IllegalStateException(
                        "Runtime Bot singleton already exists as " + activeName
                                + "; requested " + username);
            }
            return view(server);
        }
        ActiveRun created = existing;
        created.run = RuntimeBotRun.start(UUID::randomUUID, username);
        created.body = spawnFresh(server, created.run.identity());
        created.currentDimension = created.body.level().dimension().location().toString();
        created.lifecycle = RuntimeActorView.Lifecycle.ALIVE;
        RUNS.put(server, created);
        Constants.LOG.info("[mc_agent-runtime] Created bot {} ({})",
                created.body.getGameProfile().getName(), created.body.getUUID());
        return view(server);
    }

    /** Current live body, absent before the first tick or after this server stopped. */
    public static Optional<BotPlayer> current(MinecraftServer server) {
        ActiveRun active = RUNS.get(server);
        return active == null ? Optional.empty() : Optional.ofNullable(active.body);
    }

    /** Stable identity for this World Run, absent before the first tick or after stop. */
    public static Optional<RuntimeBotRun.Identity> identity(MinecraftServer server) {
        ActiveRun active = RUNS.get(server);
        return active == null || active.run == null
                ? Optional.empty() : Optional.of(active.run.identity());
    }

    /** Fixed public World Run profile, available before Runtime Bot creation. */
    public static WorldKnowledgeProfile worldKnowledgeProfile(MinecraftServer server) {
        ActiveRun active = RUNS.get(Objects.requireNonNull(server, "server"));
        if (active == null) {
            throw new IllegalStateException("World Run has not started");
        }
        return active.profile;
    }

    /** Fixed grounded evidence policy, reported even when the loaded profile is active. */
    public static GroundedEvidencePolicy groundedEvidencePolicy(MinecraftServer server) {
        ActiveRun active = RUNS.get(Objects.requireNonNull(server, "server"));
        if (active == null) {
            throw new IllegalStateException("World Run has not started");
        }
        return active.evidencePolicy;
    }

    /** SDK-safe projection of the current Runtime Bot. Must be called on the server thread. */
    public static RuntimeActorView view(MinecraftServer server) {
        ActiveRun active = RUNS.get(server);
        if (active == null || active.run == null) return null;
        return new RuntimeActorView(
                active.run.identity().uuid(),
                active.run.identity().name(),
                active.lifecycle,
                active.knowledge.revision().value()
        );
    }

    /** Operator/test-only diagnostics for the common vanilla tracking lifecycle. */
    public static Optional<RuntimeBotTrackingDiagnostics> trackingDiagnostics(
            MinecraftServer server) {
        ActiveRun active = RUNS.get(server);
        return RuntimeBotTracking.diagnostics(server, active == null ? null : active.body);
    }

    /** Current scheduled observation revision for this World Run. */
    public static long observationRevision(MinecraftServer server) {
        ActiveRun active = RUNS.get(server);
        return active == null ? 0L : active.knowledge.revision().value();
    }

    /** Explicit observation of the current body, independent of simulation advancement. */
    public static long observe(MinecraftServer server) {
        ActiveRun active = RUNS.get(server);
        if (active == null || active.body == null || !active.body.isAlive()) {
            throw new IllegalStateException("Runtime Bot is unavailable");
        }
        String dimension = active.body.level().dimension().location().toString();
        if (!dimension.equals(active.currentDimension)) {
            active.knowledge.publishBodyUnavailable(active.currentDimension, server.getTickCount());
            active.currentDimension = dimension;
        }
        publishKnowledge(active);
        return active.knowledge.revision().value();
    }

    /** The World Knowledge this World Run selected. Server-thread only. */
    public static WorldKnowledge knowledge(MinecraftServer server) {
        ActiveRun active = RUNS.get(server);
        if (active == null || active.run == null) {
            throw new IllegalStateException("Runtime Bot is not ready");
        }
        return active.knowledge;
    }

    public static boolean isRuntimeBot(BotPlayer body) {
        MinecraftServer server = body.getServer();
        ActiveRun active = RUNS.get(server);
        return active != null && active.body == body;
    }

    /** Incrementally update an already cached loaded-profile column after a server mutation. */
    public static void recordLoadedBlockChange(
            ServerLevel level, BlockPos position,
            net.minecraft.world.level.block.state.BlockState state) {
        Objects.requireNonNull(level, "level");
        Objects.requireNonNull(position, "position");
        Objects.requireNonNull(state, "state");
        ActiveRun active = RUNS.get(level.getServer());
        if (active == null || !(active.knowledge instanceof LoadedWorldKnowledge)
                || active.body == null || active.body.level() != level) {
            return;
        }
        ((VirtualClientChunkTrackerAccess) active.body.connection.chunkSender)
                .mcagent$blockUpdated(level.dimension().location().toString(), position, state);
    }

    /** Current body dimension used to scope profile-neutral knowledge requests. */
    public static String currentDimension(MinecraftServer server) {
        ActiveRun active = RUNS.get(server);
        if (active == null || active.body == null) {
            throw new IllegalStateException("Runtime Bot is not ready");
        }
        return active.currentDimension;
    }

    /** Publish every fact verified from one physical result in one Knowledge Revision. */
    public static KnowledgeRevision publishAttributable(
            MinecraftServer server, AttributableWorldUpdate update) {
        ActiveRun active = RUNS.get(Objects.requireNonNull(server, "server"));
        if (active == null || active.run == null) {
            throw new IllegalStateException("Runtime Bot is not ready");
        }
        AttributableWorldUpdate supplied = Objects.requireNonNull(update, "update");
        long observedTick = server.getTickCount();
        AttributableWorldUpdate timestamped = new AttributableWorldUpdate(
                supplied.blocks().stream().map(fact -> new AttributableWorldUpdate.BlockFact(
                        fact.dimension(), observedTick, fact.observation())).toList(),
                supplied.entities().stream().map(fact -> new AttributableWorldUpdate.EntityFact(
                        fact.dimension(), observedTick, fact.observation())).toList(),
                supplied.removedEntities());
        return active.knowledge.apply(timestamped);
    }

    /** Bind the exact Eye entity spawned synchronously by one native Runtime-Bot air use. */
    public static void recordAttributableEnderEyeLaunch(
            BotPlayer body, EyeOfEnder eye) {
        if (body == null || eye == null || !isRuntimeBot(body)
                || body.level() != eye.level()) return;
        ActiveRun active = RUNS.get(body.getServer());
        if (active == null) return;
        active.attribution.launch(body.getUUID(), eye);
    }

    /** Consume the exact Eye spawned by the caller's native air use; never scans nearby entities. */
    public static Optional<EyeOfEnder> consumeAttributableEnderEyeLaunch(
            MinecraftServer server, UUID bodyUuid) {
        ActiveRun active = RUNS.get(server);
        return active == null ? Optional.empty()
                : Optional.ofNullable(active.attribution.consumeLaunch(
                        Objects.requireNonNull(bodyUuid, "bodyUuid")));
    }

    /** Mark the exact launched Eye's vanilla discard; a later same-tick drop may refine it. */
    public static void recordAttributableEnderEyeDiscard(EyeOfEnder eye) {
        if (eye == null || !(eye.level() instanceof ServerLevel level)) return;
        ActiveRun active = RUNS.get(level.getServer());
        if (active == null || !active.attribution.ownsEye(eye.getUUID())) return;
        active.attribution.terminal(eye.getUUID(), EnderEyeTerminal.shattered());
    }

    /** Refine one exact launched Eye terminal with the exact vanilla ItemEntity it produced. */
    public static void recordAttributableEnderEyeDrop(
            EyeOfEnder eye, ItemEntity item) {
        if (eye == null || item == null || !(eye.level() instanceof ServerLevel level)
                || eye.level() != item.level()) return;
        ActiveRun active = RUNS.get(level.getServer());
        if (active == null || !active.attribution.ownsEye(eye.getUUID())) return;
        if (!item.getItem().isEmpty()) {
            publishAttributable(level.getServer(), new AttributableWorldUpdate(List.of(), List.of(
                    new AttributableWorldUpdate.EntityFact(
                            level.dimension().location().toString(), level.getServer().getTickCount(),
                            EntityObservation.attributable(item.getUUID(),
                                    BuiltInRegistries.ENTITY_TYPE.getKey(item.getType()).toString(),
                                    BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString(),
                                    item.getItem().getCount(), item.position(), null, null))), List.of()));
        }
        active.attribution.terminal(eye.getUUID(), EnderEyeTerminal.dropped(item.getUUID()));
    }

    /** Consume the exact terminal for one bound Eye UUID. */
    public static Optional<EnderEyeTerminal> consumeAttributableEnderEyeTerminal(
            MinecraftServer server, UUID eyeUuid) {
        ActiveRun active = RUNS.get(server);
        if (active == null) return Optional.empty();
        UUID exact = Objects.requireNonNull(eyeUuid, "eyeUuid");
        EnderEyeTerminal terminal = active.attribution.consumeTerminal(exact);
        return Optional.ofNullable(terminal);
    }

    /** Remove one exact Actor-attributed UUID without type, position, or time guessing. */
    /** Record one exact entity death caused by the current Runtime Bot. */
    public static void recordAttributableDeath(
            MinecraftServer server, UUID uuid, String dimension,
            long observedTick, Vec3 position) {
        ActiveRun active = RUNS.get(server);
        if (active == null) return;
        recordAttributableDeath(active, uuid, dimension, observedTick, position);
        active.knowledge.apply(new AttributableWorldUpdate(
                List.of(), List.of(), List.of(Objects.requireNonNull(uuid, "uuid"))));
    }

    private static void recordAttributableDeath(
            ActiveRun active, UUID uuid, String dimension,
            long observedTick, Vec3 position) {
        active.attribution.death(new AttributableDeath(uuid, dimension, observedTick, position));
    }

    /** Consume one exact Runtime-Bot-attributed death, if it occurred in this World Run. */
    public static Optional<AttributableDeath> consumeAttributableDeath(
            MinecraftServer server, UUID uuid) {
        ActiveRun active = RUNS.get(server);
        return active == null ? Optional.empty()
                : Optional.ofNullable(active.attribution.consumeDeath(Objects.requireNonNull(uuid, "uuid")));
    }

    /** Record actual units transferred from this exact ItemEntity by the current Runtime Bot. */
    public static KnowledgeRevision recordAttributablePickup(
            MinecraftServer server, UUID uuid, int count, boolean complete) {
        ActiveRun active = RUNS.get(server);
        if (active == null) return null;
        active.attribution.pickup(Objects.requireNonNull(uuid, "uuid"), count, complete);
        return complete ? active.knowledge.apply(new AttributableWorldUpdate(
                List.of(), List.of(), List.of(uuid))) : null;
    }

    /** Publish one death and all of its exact drops as one attributable revision. */
    public static void recordAttributableDeathWithDrops(
            MinecraftServer server, UUID uuid, String dimension, long observedTick,
            Vec3 position, List<EntityObservation> drops) {
        ActiveRun active = RUNS.get(server);
        if (active == null) return;
        UUID exact = Objects.requireNonNull(uuid, "uuid");
        List<EntityObservation> safeDrops = drops == null ? List.of() : drops;
        active.attribution.death(new AttributableDeath(exact, dimension, observedTick, position, safeDrops));
        List<AttributableWorldUpdate.EntityFact> facts = safeDrops.stream()
                .map(observation -> new AttributableWorldUpdate.EntityFact(
                        dimension, observedTick, observation)).toList();
        publishAttributable(server, new AttributableWorldUpdate(
                List.of(), facts, List.of(exact)));
    }

    /** Cumulative native pickup count; readers retain their own action-start baseline. */
    public static AttributablePickup attributablePickup(MinecraftServer server, UUID uuid) {
        ActiveRun active = RUNS.get(server);
        return active == null ? null : active.attribution.pickup(uuid);
    }

    public record AttributablePickup(int count, boolean complete) {}

    /** Defer exact verification of one non-living entity hit by a Runtime-Bot projectile. */
    public static void recordAttributableProjectileImpact(
            MinecraftServer server, Entity target) {
        ActiveRun active = RUNS.get(server);
        if (active == null || target == null || target.isRemoved()) return;
        active.attribution.impact(target);
    }

    /** Terminate work and replace a dead body through vanilla's respawn implementation. */
    public static void onDeath(BotPlayer body) {
        MinecraftServer server = body.getServer();
        ActiveRun active = RUNS.get(server);
        if (active == null || active.body != body || active.pendingRespawn != null) {
            return;
        }
        InputDriver.halt(body);
        body.setShiftKeyDown(false);
        active.lifecycle = RuntimeActorView.Lifecycle.DEAD;
        active.pendingRespawn = body;
        active.deathFramePublished = false;
        active.knowledge.publishBodyUnavailable(body.level().dimension().location().toString(), server.getTickCount());
        BotLifecycle.fireDeath(body);
    }

    /** Drop every process-local reference owned by a stopped World Run. */
    public static void stop(MinecraftServer server) {
        dev.mcagent.runtime.sdk.RuntimeSimulationControl.stop(server);
        ActiveRun active = RUNS.remove(server);
        RuntimeBotTracking.stop(server);
        if (active == null || active.body == null) return;
        InputDriver.halt(active.body);
        active.body.setShiftKeyDown(false);
        BotFactory.despawn(server, active.body);
    }

    private static BotPlayer spawnFresh(MinecraftServer server, RuntimeBotRun.Identity identity) {
        ServerLevel level = server.overworld();
        Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
        Vec3 safe = SafeSpawn.findAtOrNear(level, sharedSpawn);
        return BotFactory.spawnFresh(server, identity.uuid(), identity.name(), level,
                safe == null ? sharedSpawn : safe,
                RuntimeBotTracking.clientInformation(server));
    }

    private static void respawnVanilla(MinecraftServer server, ActiveRun active, BotPlayer dead) {
        if (RUNS.get(server) != active || active.body != dead) {
            return;
        }
        var replacement = server.getPlayerList().respawn(dead, false, Entity.RemovalReason.KILLED);
        if (!(replacement instanceof BotPlayer bot)) {
            throw new IllegalStateException("vanilla respawn did not preserve the Runtime Bot body type");
        }
        // Vanilla's packet handler assigns its returned respawn body to the existing
        // connection. A headless Runtime is the caller and owns that same assignment.
        bot.connection.player = bot;
        bot.showAllSkinLayers();
        active.body = bot;
        active.currentDimension = bot.level().dimension().location().toString();
        active.lifecycle = RuntimeActorView.Lifecycle.ALIVE;
        Constants.LOG.info("[mc_agent-runtime] bot {} respawned through vanilla at {}",
                bot.getUUID(), bot.blockPosition());
    }

    private static WorldKnowledge createWorldKnowledge(
            WorldKnowledgeProfile profile, GroundedEvidencePolicy evidencePolicy) {
        return switch (profile) {
            case GROUNDED_EVIDENCE -> new EmbodiedWorldEvidence(evidencePolicy);
            case LOADED_WORLD_STATE -> new LoadedWorldKnowledge();
        };
    }

    private static void settlePendingImpacts(ActiveRun active) {
        AttributionJournal.PendingImpact impact;
        while ((impact = active.attribution.pollImpact()) != null) {
            if (impact.target().isRemoved()) {
                recordAttributableDeath(active, impact.target().getUUID(),
                        impact.dimension(), impact.observedTick(), impact.position());
                active.knowledge.apply(new AttributableWorldUpdate(
                        List.of(), List.of(), List.of(impact.target().getUUID())));
            }
        }
    }

    public record AttributableDeath(
            UUID uuid, String dimension, long observedTick, Vec3 position,
            List<EntityObservation> drops) {
        public AttributableDeath {
            Objects.requireNonNull(uuid, "uuid");
            Objects.requireNonNull(dimension, "dimension");
            Objects.requireNonNull(position, "position");
            if (observedTick < 0) throw new IllegalArgumentException("observedTick must be non-negative");
            drops = drops == null ? List.of() : List.copyOf(drops);
        }

        public AttributableDeath(UUID uuid, String dimension, long observedTick, Vec3 position) {
            this(uuid, dimension, observedTick, position, List.of());
        }
    }

    public record EnderEyeTerminal(String terminal, UUID itemEntityUuid) {
        public EnderEyeTerminal {
            if (!"dropped".equals(terminal) && !"shattered".equals(terminal)) {
                throw new IllegalArgumentException("unknown Ender Eye terminal: " + terminal);
            }
            if ("dropped".equals(terminal) != (itemEntityUuid != null)) {
                throw new IllegalArgumentException("only dropped carries an ItemEntity UUID");
            }
        }
        public static EnderEyeTerminal dropped(UUID itemEntityUuid) {
            return new EnderEyeTerminal("dropped", Objects.requireNonNull(itemEntityUuid));
        }
        public static EnderEyeTerminal shattered() {
            return new EnderEyeTerminal("shattered", null);
        }
    }

    private static final class ActiveRun {
        private final WorldKnowledgeProfile profile;
        private final GroundedEvidencePolicy evidencePolicy;
        private final WorldKnowledge knowledge;
        private final AttributionJournal attribution = new AttributionJournal();
        private RuntimeBotRun run;
        private BotPlayer body;
        private String currentDimension;
        private BotPlayer pendingRespawn;
        private boolean deathFramePublished;
        private RuntimeActorView.Lifecycle lifecycle = RuntimeActorView.Lifecycle.STARTING;

        private ActiveRun(
                WorldKnowledgeProfile profile, GroundedEvidencePolicy evidencePolicy) {
            this.profile = Objects.requireNonNull(profile, "profile");
            this.evidencePolicy = Objects.requireNonNull(evidencePolicy, "evidencePolicy");
            this.knowledge = createWorldKnowledge(profile, evidencePolicy);
        }
    }
}
