package dev.mcagent.runtime.benchmark;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.advancements.CriterionProgress;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.knowledge.GroundedEvidencePolicy;
import dev.mcagent.runtime.knowledge.WorldKnowledgeProfile;
import dev.mcagent.runtime.sdk.RuntimeActorView;
import dev.mcagent.runtime.sdk.RuntimeSimulationControl;
import dev.mcagent.runtime.sdk.RuntimeBuildInfo;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.level.levelgen.structure.StructureStart;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;
import org.slf4j.Logger;
import com.mojang.logging.LogUtils;

/** Post-tick JSON-RPC dispatcher for the intentionally narrow Benchmark Authority surface. */
public final class BenchmarkAuthorityDispatcher {

    private static final Logger LOGGER = LogUtils.getLogger();
    public static final int PROTOCOL_VERSION = 1;
    private static final int HORIZONTAL_WORLD_BOUND = 29_999_984;

    private final MinecraftServer minecraftServer;
    private final RuntimeBuildInfo buildInfo;
    private final WorldKnowledgeProfile profile;
    private final GroundedEvidencePolicy expiry;
    private long fenceSequence;
    /** Set by {@code benchmark.run.start}; samples and the tick budget are counted from its start tick. */
    private Run run;
    private boolean runFinished;
    private java.util.function.Consumer<JsonObject> notifications = notification -> {};

    private record Run(long startTick, long tickBudget, long sampleIntervalTicks) {}

    public BenchmarkAuthorityDispatcher(MinecraftServer minecraftServer, RuntimeBuildInfo buildInfo,
                                        WorldKnowledgeProfile profile,
                                        GroundedEvidencePolicy expiry) {
        this.minecraftServer = Objects.requireNonNull(minecraftServer, "minecraftServer");
        this.buildInfo = Objects.requireNonNull(buildInfo, "buildInfo");
        this.profile = Objects.requireNonNull(profile, "profile");
        this.expiry = Objects.requireNonNull(expiry, "expiry");
    }

    /** Where unsolicited notifications to the Authority controller go. */
    public void notifications(java.util.function.Consumer<JsonObject> sink) {
        this.notifications = Objects.requireNonNull(sink, "sink");
    }

    /**
     * Runs after every simulation tick. A sample is taken on each multiple of the interval, counted from the
     * run's start tick, and on the budget tick; the budget tick also holds the World Run. {@link #atRest} adds
     * the samples between intervals.
     */
    public void afterTick() {
        if (run == null || runFinished) return;
        long elapsed = minecraftServer.getTickCount() - run.startTick;
        boolean budgetReached = elapsed >= run.tickBudget;
        if (budgetReached || elapsed % run.sampleIntervalTicks == 0) notifications.accept(notification("benchmark.sample", sample(elapsed)));
        if (!budgetReached) return;
        runFinished = true;
        RuntimeSimulationControl.forServer(minecraftServer).suspend();
        JsonObject finished = new JsonObject();
        finished.addProperty("reason", "tick_budget");
        finished.addProperty("elapsed_tick", elapsed);
        receipt(finished);
        notifications.accept(notification("benchmark.run.finished", finished));
    }

    /**
     * Runs each time the World Run comes to rest. The sample records what the Bot holds once its actions are
     * over: without it, a change made after the last interval sample would go unseen for as long as the World
     * Run stays idle. It carries the tick the World Run stopped on, so it may repeat an interval sample's tick.
     */
    public void atRest() {
        if (run == null || runFinished) return;
        notifications.accept(notification("benchmark.sample", sample(minecraftServer.getTickCount() - run.startTick)));
    }

    private JsonObject runStart(JsonElement id, JsonElement paramsElement) {
        JsonObject params = objectWith(paramsElement, "tick_budget", "sample_interval_ticks");
        int tickBudget = integer(params, "tick_budget");
        int sampleIntervalTicks = integer(params, "sample_interval_ticks");
        if (tickBudget < 1 || sampleIntervalTicks < 1) throw new InvalidParams();
        if (run != null) throw new IllegalStateException("Benchmark run already started");
        run = new Run(minecraftServer.getTickCount(), tickBudget, sampleIntervalTicks);
        JsonObject result = new JsonObject();
        result.addProperty("start_tick", run.startTick);
        result.add("sample", sample(0));
        // Setup is over: from here the World Run advances on demand, or freely without pause-when-idle.
        RuntimeSimulationControl.forServer(minecraftServer).resume();
        return success(id, result);
    }

    /** The facts scoring reads, stamped with the tick they were taken on. */
    private JsonObject sample(long elapsedTick) {
        JsonObject sample = new JsonObject();
        sample.addProperty("elapsed_tick", elapsedTick);
        sample.add("actor", actorProjection());
        sample.add("inventory", inventoryProjection());
        sample.add("blocks", new JsonArray());
        var events = WorldEventCounters.counts(minecraftServer);
        sample.addProperty("portal_activation_count", events.portalActivations());
        sample.addProperty("actor_death_count", events.actorDeaths());
        sample.add("evaluation", evaluationProjection());
        receipt(sample);
        return sample;
    }

    private static JsonObject notification(String method, JsonObject params) {
        JsonObject notification = new JsonObject();
        notification.addProperty("jsonrpc", "2.0");
        notification.addProperty("method", method);
        notification.add("params", params);
        return notification;
    }

    public String dispatch(String textFrame) {
        JsonObject request;
        try {
            JsonElement parsed = JsonParser.parseString(textFrame);
            if (!parsed.isJsonObject()) return error(null, -32600, "Invalid Request").toString();
            request = parsed.getAsJsonObject();
        } catch (RuntimeException error) {
            return error(null, -32700, "Parse error").toString();
        }
        JsonElement id = request.get("id");
        if (!isRequest(request, id)) return error(null, -32600, "Invalid Request").toString();
        String method = request.get("method").getAsString();
        try {
            return switch (method) {
                case "benchmark.diagnostics" -> diagnostics(id, request.get("params")).toString();
                case "benchmark.info" -> info(id, request.get("params")).toString();
                case "world.block.get" -> blockGet(id, request.get("params")).toString();
                case "world.block.set" -> blockSet(id, request.get("params")).toString();
                case "actor.get" -> actorGet(id, request.get("params")).toString();
                case "benchmark.snapshot.get" -> snapshotGet(id, request.get("params")).toString();
                case "benchmark.run.start" -> runStart(id, request.get("params")).toString();
                case "benchmark.advancement_definitions.get" -> advancementDefinitions(id, request.get("params")).toString();
                case "actor.create" -> actorCreate(id, request.get("params")).toString();
                case "actor.respawn.set" -> actorRespawn(id, request.get("params")).toString();
                case "actor.item.give", "actor.inventory.set", "actor.equipment.set" -> actorItem(id, method, request.get("params")).toString();
                case "world.command.execute" -> executeCommand(id, request.get("params")).toString();
                case "world.time.pause", "world.time.resume", "world.time.get" -> time(id, method, request.get("params")).toString();
                case "actor.teleport" -> actorTeleport(id, request.get("params")).toString();
                default -> error(id, -32601, "Method not found").toString();
            };
        } catch (InvalidParams invalid) {
            return error(id, -32602, "Invalid params").toString();
        } catch (IllegalStateException unavailable) {
            return error(id, -32009, unavailable.getMessage()).toString();
        } catch (RuntimeException failure) {
            return error(id, -32603, "Internal error").toString();
        }
    }

    private JsonObject info(JsonElement id, JsonElement params) {
        requireEmpty(params);
        JsonObject result = new JsonObject();
        result.addProperty("protocol_version", PROTOCOL_VERSION);
        result.addProperty("build_version", buildInfo.buildVersion());
        result.addProperty("minecraft_version", buildInfo.minecraftVersion());
        result.addProperty("neoforge_version", buildInfo.neoForgeVersion());
        result.addProperty("readiness", "ready");
        result.addProperty("world_knowledge_profile", profile.wireValue());
        result.addProperty("grounded_block_expiry_ticks", expiry.blockExpiryTicks());
        result.addProperty("grounded_entity_expiry_ticks", expiry.entityExpiryTicks());
        JsonArray capabilities = new JsonArray();
        capabilities.add("world.block.get@1");
        capabilities.add("world.block.set@1");
        capabilities.add("actor.get@1");
        capabilities.add("actor.teleport@1");
        capabilities.add("benchmark.snapshot.get@1");
        capabilities.add("benchmark.run.start@1");
        capabilities.add("benchmark.evaluation_snapshot@1");
        capabilities.add("benchmark.advancement_definitions.get@1");
        for (String capability : new String[] { "actor.create", "actor.respawn.set", "actor.item.give", "actor.inventory.set", "actor.equipment.set", "world.command.execute", "world.time.pause", "world.time.resume", "world.time.get" }) capabilities.add(capability + "@1");
        result.add("capabilities", capabilities);
        return success(id, result);
    }

    private JsonObject blockGet(JsonElement id, JsonElement params) {
        Position position = position(objectWith(params, "dimension", "x", "y", "z"));
        JsonObject result = new JsonObject();
        result.addProperty("block_state", canonical(position.level.getBlockState(position.blockPos())));
        return success(id, result);
    }

    private JsonObject blockSet(JsonElement id, JsonElement paramsElement) {
        JsonObject params = objectWith(paramsElement, "dimension", "x", "y", "z", "block_id");
        Position position = position(params);
        String rawId = string(params, "block_id");
        ResourceLocation blockId = ResourceLocation.tryParse(rawId);
        if (blockId == null || !rawId.contains(":") || !BuiltInRegistries.BLOCK.containsKey(blockId)) {
            throw new InvalidParams();
        }
        BlockState previous = position.level.getBlockState(position.blockPos());
        BlockState requested = BuiltInRegistries.BLOCK.get(blockId).defaultBlockState();
        position.level.setBlockAndUpdate(position.blockPos(), requested);
        JsonObject result = new JsonObject();
        result.addProperty("previous_block_state", canonical(previous));
        result.addProperty("current_block_state", canonical(position.level.getBlockState(position.blockPos())));
        return success(id, result);
    }

    private JsonObject actorGet(JsonElement id, JsonElement params) {
        requireEmpty(params);
        JsonObject result = actorProjection();
        return success(id, result);
    }

    private JsonObject snapshotGet(JsonElement id, JsonElement paramsElement) {
        JsonObject params = paramsElement != null && paramsElement.isJsonObject() ? paramsElement.getAsJsonObject() : null;
        if (params == null || !(params.keySet().equals(Set.of("actor", "inventory", "blocks"))
                || params.keySet().equals(Set.of("actor", "inventory", "blocks", "evaluation")))) throw new InvalidParams();
        requireTrue(params, "actor");
        requireTrue(params, "inventory");
        if (params.has("evaluation")) requireTrue(params, "evaluation");
        JsonArray requestedBlocks = array(params, "blocks");
        JsonObject result = new JsonObject();
        result.add("actor", actorProjection());
        result.add("inventory", inventoryProjection());
        JsonArray blocks = new JsonArray();
        for (JsonElement requested : requestedBlocks) {
            Position position = position(objectWith(requested, "dimension", "x", "y", "z"));
            JsonObject block = new JsonObject();
            block.addProperty("dimension", position.level.dimension().location().toString());
            block.addProperty("x", position.x);
            block.addProperty("y", position.y);
            block.addProperty("z", position.z);
            block.addProperty("block_state", canonical(position.level.getBlockState(position.blockPos())));
            blocks.add(block);
        }
        result.add("blocks", blocks);
        var events = WorldEventCounters.counts(minecraftServer);
        result.addProperty("portal_activation_count", events.portalActivations());
        result.addProperty("actor_death_count", events.actorDeaths());
        if (params.has("evaluation")) result.add("evaluation", evaluationProjection());
        return success(id, result);
    }

    private JsonObject advancementDefinitions(JsonElement id, JsonElement params) {
        requireEmpty(params);
        JsonArray definitions = new JsonArray();
        minecraftServer.getAdvancements().getAllAdvancements().stream()
            .sorted(Comparator.comparing(holder -> holder.id().toString()))
            .forEach(holder -> {
                JsonObject definition = new JsonObject();
                definition.addProperty("id", holder.id().toString());
                JsonArray names = new JsonArray();
                holder.value().criteria().keySet().stream().sorted().forEach(names::add);
                definition.add("criteria_names", names);
                JsonArray requirements = new JsonArray();
                holder.value().requirements().requirements().forEach(group -> {
                    JsonArray alternatives = new JsonArray();
                    group.forEach(alternatives::add);
                    requirements.add(alternatives);
                });
                definition.add("requirements", requirements);
                definitions.add(definition);
            });
        JsonObject result = new JsonObject();
        result.add("definitions", definitions);
        return success(id, result);
    }

    private JsonObject evaluationProjection() {
        JsonObject result = new JsonObject();
        BotPlayer body = RuntimeBotManager.current(minecraftServer).orElse(null);
        if (body == null) {
            for (String section : List.of("location", "advancements", "nearby_portals")) result.add(section, unavailable("actor_absent"));
            return result;
        }
        ServerLevel level = minecraftServer.getLevel(body.level().dimension());
        if (level == null) {
            for (String section : List.of("location", "advancements", "nearby_portals")) result.add(section, unavailable("dimension_absent"));
            return result;
        }
        result.add("location", factSection("location", () -> locationProjection(level, body.blockPosition())));
        result.add("advancements", factSection("advancements", () -> advancementProjection(body)));
        result.add("nearby_portals", factSection("nearby_portals", () -> portalProjection(level, body.blockPosition())));
        return result;
    }

    private JsonObject factSection(String name, Supplier<JsonElement> projection) {
        try {
            JsonObject result = new JsonObject();
            result.addProperty("status", "ok");
            result.add("value", projection.get());
            return result;
        } catch (RuntimeException error) {
            LOGGER.warn("Benchmark evaluation {} unavailable", name, error);
            return unavailable(error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
        }
    }

    private static JsonObject unavailable(String reason) {
        JsonObject result = new JsonObject();
        result.addProperty("status", "unavailable");
        result.addProperty("reason", reason);
        return result;
    }

    private JsonObject locationProjection(ServerLevel level, BlockPos actorPos) {
        JsonObject result = new JsonObject();
        result.addProperty("biome_id", level.getBiome(actorPos).unwrapKey()
            .orElseThrow(() -> new IllegalStateException("Biome has no registry key")).location().toString());
        JsonArray structures = new JsonArray();
        var registry = level.registryAccess().registryOrThrow(Registries.STRUCTURE);
        for (Structure structure : level.structureManager().getAllStructuresAt(actorPos).keySet()) {
            StructureStart start = level.structureManager().getStructureAt(actorPos, structure);
            if (!start.isValid()) continue;
            JsonObject located = new JsonObject();
            located.addProperty("id", registry.getKey(structure).toString());
            BoundingBox box = start.getBoundingBox();
            JsonObject bounds = new JsonObject();
            bounds.add("min", position(level, new BlockPos(box.minX(), box.minY(), box.minZ())));
            bounds.add("max", position(level, new BlockPos(box.maxX(), box.maxY(), box.maxZ())));
            located.add("bounds", bounds);
            structures.add(located);
        }
        result.add("structures", structures);
        return result;
    }

    private JsonArray advancementProjection(BotPlayer body) {
        JsonArray result = new JsonArray();
        for (AdvancementHolder holder : minecraftServer.getAdvancements().getAllAdvancements().stream()
                .sorted(Comparator.comparing(value -> value.id().toString())).toList()) {
            AdvancementProgress progress = body.getAdvancements().getOrStartProgress(holder);
            JsonObject entry = new JsonObject();
            entry.addProperty("id", holder.id().toString());
            entry.addProperty("done", progress.isDone());
            JsonArray criteria = new JsonArray();
            holder.value().criteria().keySet().stream().sorted().forEach(name -> {
                CriterionProgress criterion = progress.getCriterion(name);
                JsonObject state = new JsonObject();
                state.addProperty("name", name);
                state.addProperty("done", criterion != null && criterion.isDone());
                if (criterion != null && criterion.getObtained() != null) state.addProperty("obtained_at", criterion.getObtained().toString());
                criteria.add(state);
            });
            entry.add("criteria", criteria);
            result.add(entry);
        }
        return result;
    }

    private JsonObject portalProjection(ServerLevel level, BlockPos actorPos) {
        BlockPos min = actorPos.offset(-5, -5, -5);
        BlockPos max = actorPos.offset(4, 4, 4);
        JsonArray candidates = new JsonArray();
        List<BlockPos> frameBlocks = new ArrayList<>();
        BlockPos netherPortal = null;
        BlockPos endFrame = null;
        BlockPos endPortal = null;
        for (BlockPos pos : BlockPos.betweenClosed(min, max)) {
            BlockState state = loadedState(level, pos);
            if (state.is(Blocks.OBSIDIAN) || state.is(Blocks.NETHER_PORTAL)) frameBlocks.add(pos.immutable());
            if (netherPortal == null && state.is(Blocks.NETHER_PORTAL)) netherPortal = pos.immutable();
            if (endFrame == null && state.is(Blocks.END_PORTAL_FRAME)) endFrame = pos.immutable();
            if (endPortal == null && state.is(Blocks.END_PORTAL)) endPortal = pos.immutable();
        }
        Set<String> seenFrames = new HashSet<>();
        for (BlockPos nearFrame : frameBlocks) {
            for (Direction.Axis axis : List.of(Direction.Axis.X, Direction.Axis.Z)) {
                for (BlockPos interior : List.of(nearFrame, nearFrame.above(), nearFrame.below(),
                        nearFrame.north(), nearFrame.south(), nearFrame.east(), nearFrame.west())) {
                    NetherFrame frame = findNetherFrame(level, interior, axis);
                    if (frame == null || !seenFrames.add(axis + ":" + frame.anchor())) continue;
                    candidates.add(portalCandidate(level, "nether", frame.anchor(), true, frame.active(), frame.evidence()));
                }
            }
        }
        if (netherPortal != null) candidates.add(portalCandidate(level, "nether", netherPortal, false, true, List.of(netherPortal)));
        if (endFrame != null) candidates.add(portalCandidate(level, "end", endFrame, false, false, List.of(endFrame)));
        if (endPortal != null) candidates.add(portalCandidate(level, "end", endPortal, false, true, List.of(endPortal)));
        JsonObject result = new JsonObject();
        result.add("min", position(level, min));
        result.add("max", position(level, max));
        result.add("candidates", candidates);
        return result;
    }

    private record NetherFrame(BlockPos anchor, boolean active, List<BlockPos> evidence) {}

    private NetherFrame findNetherFrame(ServerLevel level, BlockPos origin, Direction.Axis axis) {
        Direction right = axis == Direction.Axis.X ? Direction.EAST : Direction.SOUTH;
        if (!portalInterior(loadedState(level, origin))) return null;
        BlockPos bottom = origin;
        for (int i = 0; i < 21 && portalInterior(loadedState(level, bottom.below())); i++) bottom = bottom.below();
        BlockPos left = bottom;
        for (int i = 0; i < 21 && portalInterior(loadedState(level, left.relative(right.getOpposite()))); i++) left = left.relative(right.getOpposite());
        if (!loadedState(level, left.relative(right.getOpposite())).is(Blocks.OBSIDIAN)) return null;
        List<BlockPos> evidence = new ArrayList<>();
        int width = 0;
        for (; width <= 21 && portalInterior(loadedState(level, left.relative(right, width))); width++) {
            BlockPos floor = left.relative(right, width).below();
            if (!loadedState(level, floor).is(Blocks.OBSIDIAN)) return null;
            evidence.add(floor);
        }
        if (width < 2 || width > 21) return null;
        BlockPos rightFrame = left.relative(right, width);
        if (!loadedState(level, rightFrame).is(Blocks.OBSIDIAN)) return null;
        boolean active = false;
        for (int height = 0; height <= 21; height++) {
            BlockPos leftFrame = left.relative(right.getOpposite()).above(height);
            rightFrame = left.relative(right, width).above(height);
            boolean top = true;
            boolean mixed = false;
            for (int offset = 0; offset < width; offset++) {
                BlockPos cell = left.relative(right, offset).above(height);
                BlockState state = loadedState(level, cell);
                if (!state.is(Blocks.OBSIDIAN)) top = false;
                if (state.is(Blocks.NETHER_PORTAL)) active = true;
                evidence.add(cell);
                if (state.is(Blocks.OBSIDIAN)) mixed = true;
                else if (!portalInterior(state)) return null;
            }
            if (top) return height >= 3 && height <= 21 ? new NetherFrame(left, active, evidence) : null;
            if (mixed) return null;
            if (!loadedState(level, leftFrame).is(Blocks.OBSIDIAN) || !loadedState(level, rightFrame).is(Blocks.OBSIDIAN)) return null;
            evidence.add(leftFrame);
            evidence.add(rightFrame);
        }
        return null;
    }

    private static boolean portalInterior(BlockState state) {
        return state.isAir() || state.is(Blocks.FIRE) || state.is(Blocks.SOUL_FIRE) || state.is(Blocks.NETHER_PORTAL);
    }

    private static BlockState loadedState(ServerLevel level, BlockPos pos) {
        if (!level.hasChunkAt(pos)) throw new IllegalStateException("Portal scan reached an unloaded chunk");
        return level.getBlockState(pos);
    }

    private static JsonObject portalCandidate(ServerLevel level, String kind, BlockPos position,
                                              boolean frameComplete, boolean active, List<BlockPos> evidence) {
        JsonObject result = new JsonObject();
        result.addProperty("kind", kind);
        result.add("position", position(level, position));
        result.addProperty("frame_complete", frameComplete);
        result.addProperty("active", active);
        JsonArray blocks = new JsonArray();
        for (BlockPos witness : evidence) {
            JsonObject block = position(level, witness);
            block.addProperty("block_state", canonical(level.getBlockState(witness)));
            blocks.add(block);
        }
        result.add("evidence", blocks);
        return result;
    }

    private static JsonObject position(ServerLevel level, BlockPos pos) {
        JsonObject result = new JsonObject();
        result.addProperty("dimension", level.dimension().location().toString());
        result.addProperty("x", pos.getX());
        result.addProperty("y", pos.getY());
        result.addProperty("z", pos.getZ());
        return result;
    }

    private JsonObject actorTeleport(JsonElement id, JsonElement paramsElement) {
        JsonObject params = objectWith(paramsElement, "dimension", "x", "y", "z", "yaw", "pitch");
        ServerLevel level = level(params);
        double x = finiteNumber(params, "x");
        double y = finiteNumber(params, "y");
        double z = finiteNumber(params, "z");
        if (Math.abs(x) > HORIZONTAL_WORLD_BOUND || Math.abs(z) > HORIZONTAL_WORLD_BOUND
                || y < level.getMinBuildHeight() || y >= level.getMaxBuildHeight()) {
            throw new InvalidParams();
        }
        float yaw = finiteFloat(params, "yaw");
        float pitch = finiteFloat(params, "pitch");
        if (pitch < -90.0F || pitch > 90.0F) throw new InvalidParams();
        BotPlayer body = RuntimeBotManager.current(minecraftServer).orElse(null);
        RuntimeActorView actor = RuntimeBotManager.view(minecraftServer);
        if (body == null || actor == null || actor.lifecycle() != RuntimeActorView.Lifecycle.ALIVE
                || !body.isAlive()) {
            throw new IllegalStateException("Runtime Bot is not alive");
        }
        body.teleportTo(level, x, y, z, yaw, pitch);
        return success(id, actorProjection());
    }

    private JsonObject actorCreate(JsonElement id, JsonElement params) {
        RuntimeBotManager.create(minecraftServer, string(objectWith(params, "username"), "username"));
        return success(id, actorProjection());
    }

    private BotPlayer body() {
        return RuntimeBotManager.current(minecraftServer)
                .orElseThrow(() -> new IllegalStateException("Runtime Bot is absent"));
    }

    private JsonObject actorRespawn(JsonElement id, JsonElement input) {
        JsonObject params = objectWith(input, "dimension", "x", "y", "z", "yaw");
        Position position = position(params);
        body().setRespawnPosition(position.level.dimension(), position.blockPos(), finiteFloat(params, "yaw"), true, false);
        return success(id, new JsonObject());
    }

    private JsonObject actorItem(JsonElement id, String method, JsonElement input) {
        boolean give = method.equals("actor.item.give");
        JsonObject params = give ? objectWith(input, "item_id", "count")
                : objectWith(input, "item_id", "count", "slot");
        ResourceLocation itemId = ResourceLocation.tryParse(string(params, "item_id"));
        int count = integer(params, "count");
        if (itemId == null || !BuiltInRegistries.ITEM.containsKey(itemId) || count < 0) throw new InvalidParams();
        ItemStack stack = count == 0 ? ItemStack.EMPTY : new ItemStack(BuiltInRegistries.ITEM.get(itemId), count);
        BotPlayer actor = body();
        if (give) {
            actor.getInventory().add(stack);
            if (!stack.isEmpty()) actor.drop(stack, false);
        } else if (method.equals("actor.inventory.set")) {
            int slot = integer(params, "slot");
            if (slot < 0 || slot >= 36) throw new InvalidParams();
            actor.getInventory().setItem(slot, stack);
        } else {
            EquipmentSlot slot;
            try { slot = EquipmentSlot.valueOf(string(params, "slot").toUpperCase(Locale.ROOT)); }
            catch (IllegalArgumentException invalid) { throw new InvalidParams(); }
            actor.setItemSlot(slot, stack);
        }
        actor.getInventory().setChanged();
        actor.containerMenu.broadcastChanges();
        JsonObject result = new JsonObject();
        result.add("inventory", inventoryProjection());
        return success(id, result);
    }

    private JsonObject executeCommand(JsonElement id, JsonElement input) {
        String command = string(objectWith(input, "command"), "command");
        JsonObject result = new JsonObject();
        minecraftServer.getCommands().performPrefixedCommand(
                minecraftServer.createCommandSourceStack().withCallback((ok, value) -> {
                    result.addProperty("success", ok);
                    result.addProperty("result", value);
                }), command);
        if (!result.has("success")) { result.addProperty("success", false); result.addProperty("result", 0); }
        return success(id, result);
    }

    /** Operator-only diagnostics stay on Authority, outside Agent knowledge. */
    private JsonObject diagnostics(JsonElement id, JsonElement params) {
        requireEmpty(params);
        var lifecycle = RuntimeSimulationControl.forServer(minecraftServer).diagnostics();
        JsonObject result = new com.google.gson.Gson().toJsonTree(lifecycle).getAsJsonObject();
        result.addProperty("pendingAuthorityRequests", BenchmarkAuthorityLifecycle.pendingRequests(minecraftServer));
        RuntimeBotManager.current(minecraftServer).ifPresent(body -> {
            var access = (dev.mcagent.runtime.knowledge.loaded.VirtualClientChunkTrackerAccess)
                    body.connection.chunkSender;
            var cache = access.mcagent$loadedChunkSnapshot();
            JsonArray columns = new JsonArray();
            cache.columns().keySet().stream().sorted().forEach(key -> {
                var position = new net.minecraft.world.level.ChunkPos(key);
                JsonArray coordinates = new JsonArray();
                coordinates.add(position.x); coordinates.add(position.z); columns.add(coordinates);
            });
            result.add("deliveredColumns", columns);
        });
        return success(id, result);
    }

    private JsonObject time(JsonElement id, String method, JsonElement params) {
        requireEmpty(params);
        RuntimeSimulationControl control = RuntimeSimulationControl.forServer(minecraftServer);
        if (method.equals("world.time.pause")) control.suspend();
        if (method.equals("world.time.resume")) control.resume();
        JsonObject result = new JsonObject();
        result.addProperty("paused", control.simulationSuspended());
        result.addProperty("pause_when_idle", control.pausesWhenIdle());
        return success(id, result);
    }

    private JsonObject actorProjection() {
        BotPlayer body = RuntimeBotManager.current(minecraftServer).orElse(null);
        RuntimeActorView actor = RuntimeBotManager.view(minecraftServer);
        if (body == null || actor == null) {
            JsonObject absent = new JsonObject();
            absent.addProperty("present", false);
            return absent;
        }
        JsonObject result = new JsonObject();
        result.addProperty("present", true);
        result.addProperty("uuid", actor.uuid().toString());
        result.addProperty("name", actor.name());
        result.addProperty("lifecycle", actor.lifecycle().name().toLowerCase(Locale.ROOT));
        result.addProperty("dimension", body.level().dimension().location().toString());
        JsonObject position = new JsonObject();
        position.addProperty("x", body.getX());
        position.addProperty("y", body.getY());
        position.addProperty("z", body.getZ());
        result.add("position", position);
        result.addProperty("yaw", body.getYRot());
        result.addProperty("pitch", body.getXRot());
        result.addProperty("health", body.getHealth());
        result.addProperty("food", body.getFoodData().getFoodLevel());
        return result;
    }

    private JsonElement inventoryProjection() {
        BotPlayer body = RuntimeBotManager.current(minecraftServer).orElse(null);
        if (body == null) return JsonNull.INSTANCE;
        JsonObject inventory = new JsonObject();
        inventory.addProperty("selected_hotbar_slot", body.getInventory().selected);
        JsonArray slots = new JsonArray();
        for (int slot = 0; slot < 36; slot++) {
            ItemStack stack = body.getInventory().getItem(slot);
            JsonObject entry = new JsonObject();
            entry.addProperty("slot", slot);
            entry.add("item", nullableItemStack(stack));
            slots.add(entry);
        }
        inventory.add("slots", slots);
        inventory.add("mainhand", nullableItemStack(body.getMainHandItem()));
        inventory.add("offhand", nullableItemStack(body.getOffhandItem()));
        JsonObject armor = new JsonObject();
        armor.add("head", nullableItemStack(body.getItemBySlot(EquipmentSlot.HEAD)));
        armor.add("chest", nullableItemStack(body.getItemBySlot(EquipmentSlot.CHEST)));
        armor.add("legs", nullableItemStack(body.getItemBySlot(EquipmentSlot.LEGS)));
        armor.add("feet", nullableItemStack(body.getItemBySlot(EquipmentSlot.FEET)));
        inventory.add("armor", armor);
        return inventory;
    }

    private JsonElement nullableItemStack(ItemStack stack) {
        return stack.isEmpty() ? JsonNull.INSTANCE : itemStack(stack);
    }

    private JsonObject itemStack(ItemStack stack) {
        JsonObject item = new JsonObject();
        item.addProperty("item_id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        item.addProperty("count", stack.getCount());
        if (stack.isDamageableItem()) {
            JsonObject durability = new JsonObject();
            durability.addProperty("remaining", stack.getMaxDamage() - stack.getDamageValue());
            durability.addProperty("maximum", stack.getMaxDamage());
            item.add("durability", durability);
        }
        String components = stack.getComponentsPatch().toString();
        if (!"{}".equals(components)) item.addProperty("components", components);
        return item;
    }

    private JsonObject success(JsonElement id, JsonObject result) {
        receipt(result);
        JsonObject response = envelope(id);
        response.add("result", result);
        return response;
    }

    private void receipt(JsonObject result) {
        result.addProperty("fence_sequence", ++fenceSequence);
        result.addProperty("server_tick", minecraftServer.getTickCount());
        result.addProperty("game_time", minecraftServer.overworld().getGameTime());
    }

    private Position position(JsonObject values) {
        ServerLevel level = level(values);
        int x = integer(values, "x");
        int y = integer(values, "y");
        int z = integer(values, "z");
        if (Math.abs((long) x) > HORIZONTAL_WORLD_BOUND || Math.abs((long) z) > HORIZONTAL_WORLD_BOUND
                || y < level.getMinBuildHeight() || y >= level.getMaxBuildHeight()) {
            throw new InvalidParams();
        }
        return new Position(level, x, y, z);
    }

    private ServerLevel level(JsonObject values) {
        String dimensionText = string(values, "dimension");
        ResourceLocation dimension = ResourceLocation.tryParse(dimensionText);
        if (dimension == null) throw new InvalidParams();
        ResourceKey<net.minecraft.world.level.Level> key = ResourceKey.create(Registries.DIMENSION, dimension);
        ServerLevel level = minecraftServer.getLevel(key);
        if (level == null) throw new InvalidParams();
        return level;
    }

    private static JsonObject objectWith(JsonElement value, String... allowed) {
        if (value == null || !value.isJsonObject()) throw new InvalidParams();
        JsonObject object = value.getAsJsonObject();
        if (!object.keySet().equals(java.util.Set.of(allowed))) throw new InvalidParams();
        return object;
    }

    private static void requireEmpty(JsonElement params) {
        if (params == null || !params.isJsonObject() || !params.getAsJsonObject().keySet().isEmpty()) {
            throw new InvalidParams();
        }
    }

    private static JsonArray array(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonArray()) throw new InvalidParams();
        return value.getAsJsonArray();
    }

    private static void requireTrue(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()
                || !value.getAsBoolean()) throw new InvalidParams();
    }

    private static String string(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new InvalidParams();
        }
        return value.getAsString();
    }

    private static int integer(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new InvalidParams();
        }
        try {
            double number = value.getAsDouble();
            if (!Double.isFinite(number) || number != Math.rint(number)
                    || number < Integer.MIN_VALUE || number > Integer.MAX_VALUE) throw new InvalidParams();
            return (int) number;
        } catch (NumberFormatException invalid) {
            throw new InvalidParams();
        }
    }

    private static double finiteNumber(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new InvalidParams();
        }
        try {
            double number = value.getAsDouble();
            if (!Double.isFinite(number)) throw new InvalidParams();
            return number;
        } catch (NumberFormatException invalid) {
            throw new InvalidParams();
        }
    }

    private static float finiteFloat(JsonObject object, String name) {
        double value = finiteNumber(object, name);
        if (value < -Float.MAX_VALUE || value > Float.MAX_VALUE) throw new InvalidParams();
        return (float) value;
    }

    private static boolean isRequest(JsonObject request, JsonElement id) {
        JsonElement version = request.get("jsonrpc");
        JsonElement method = request.get("method");
        return version != null && version.isJsonPrimitive() && version.getAsJsonPrimitive().isString()
                && "2.0".equals(version.getAsString())
                && method != null && method.isJsonPrimitive() && method.getAsJsonPrimitive().isString()
                && id != null && (id.isJsonNull() || id.isJsonPrimitive()
                && (id.getAsJsonPrimitive().isString() || id.getAsJsonPrimitive().isNumber()));
    }

    private static JsonObject error(JsonElement id, int code, String message) {
        JsonObject detail = new JsonObject();
        detail.addProperty("code", code);
        detail.addProperty("message", message);
        JsonObject response = envelope(id);
        response.add("error", detail);
        return response;
    }

    private static JsonObject envelope(JsonElement id) {
        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        response.add("id", id == null ? JsonNull.INSTANCE : id.deepCopy());
        return response;
    }

    private record Position(ServerLevel level, int x, int y, int z) {
        BlockPos blockPos() { return new BlockPos(x, y, z); }
    }

    private static final class InvalidParams extends RuntimeException {}

    private static String canonical(BlockState state) {
        String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if (state.getValues().isEmpty()) return id;
        return id + state.getValues().entrySet().stream()
                .sorted(java.util.Comparator.comparing(entry -> entry.getKey().getName()))
                .map(BenchmarkAuthorityDispatcher::property)
                .collect(java.util.stream.Collectors.joining(",", "[", "]"));
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private static String property(Map.Entry<Property<?>, Comparable<?>> entry) {
        return entry.getKey().getName() + "=" + ((Property) entry.getKey()).getName(entry.getValue());
    }
}
