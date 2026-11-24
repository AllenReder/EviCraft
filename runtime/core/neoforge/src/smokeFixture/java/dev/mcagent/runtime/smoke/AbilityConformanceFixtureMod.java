package dev.mcagent.runtime.smoke;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.Registries;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.nbt.Tag;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.commands.Commands;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.Difficulty;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.storage.LevelResource;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/** Generates sealed-source worlds only during the dedicated preparation run. */
@Mod(AbilityConformanceFixtureMod.MOD_ID)
public final class AbilityConformanceFixtureMod {
    public static final String MOD_ID = "mc_agent_test_fixture";
    private static final Gson JSON = new Gson();
    private static final String SPECIFICATION_PROPERTY = "mcagent.smoke.specification";
    private static final int PLATFORM_RADIUS = 12;

    private MinecraftServer preparingServer;
    private JsonObject selectedScenario;
    private Path selectedSpecificationDirectory;
    private int ticksAfterGeneration;

    public AbilityConformanceFixtureMod(IEventBus modBus, ModContainer container) {
        NeoForge.EVENT_BUS.addListener(this::onServerStarted);
        NeoForge.EVENT_BUS.addListener(this::onServerTick);
        NeoForge.EVENT_BUS.addListener(this::onRegisterCommands);
    }

    private void onRegisterCommands(RegisterCommandsEvent event) {
        event.getDispatcher().register(Commands.literal("mcagent_smoke_damage_burst")
                .requires(source -> source.hasPermission(2))
                .executes(context -> {
                    MinecraftServer server = context.getSource().getServer();
                    var body = dev.mcagent.runtime.bot.RuntimeBotManager.current(server)
                            .orElseThrow(() -> new IllegalStateException("Runtime Bot is missing"));
                    body.hurt(body.damageSources().fellOutOfWorld(), 1.0F);
                    body.heal(1.0F);
                    body.invulnerableTime = 0;
                    body.hurt(body.damageSources().genericKill(), 1.0F);
                    body.heal(1.0F);
                    return 1;
                }));
    }

    private void onServerStarted(ServerStartedEvent event) {
        String specificationPath = System.getProperty(SPECIFICATION_PROPERTY);
        if (specificationPath == null) return;
        try {
            Path specification = Path.of(specificationPath);
            JsonObject scenario = JsonParser.parseReader(
                    Files.newBufferedReader(specification))
                    .getAsJsonObject();
            validateSpecification(scenario);
            generate(event.getServer(), scenario, specification.getParent());
            preparingServer = event.getServer();
            selectedScenario = scenario;
            selectedSpecificationDirectory = specification.getParent();
            System.out.println("ABILITY_CONFORMANCE_GENERATED scenario="
                    + scenario.get("id").getAsString());
        } catch (IOException | RuntimeException error) {
            throw new IllegalStateException("Could not generate Ability Conformance world", error);
        }
    }

    private void onServerTick(ServerTickEvent.Post event) {
        if (event.getServer() != preparingServer || ++ticksAfterGeneration < 5) return;
        try {
            writeGeneratedManifest(preparingServer, selectedScenario, selectedSpecificationDirectory);
            if (!preparingServer.saveEverything(true, true, true)) {
                throw new IllegalStateException("Minecraft declined the Ability Conformance world save");
            }
            System.out.println("ABILITY_CONFORMANCE_TEMPLATE_READY scenario="
                    + selectedScenario.get("id").getAsString());
            preparingServer.halt(false);
            preparingServer = null;
            selectedScenario = null;
            selectedSpecificationDirectory = null;
        } catch (IOException error) {
            throw new IllegalStateException("Could not seal Ability Conformance metadata", error);
        }
    }

    private static void generate(
            MinecraftServer server,
            JsonObject scenario,
            Path specificationDirectory
    ) throws IOException {
        ServerLevel level = server.overworld();
        server.setDifficulty(Difficulty.byName(scenario.get("difficulty").getAsString()), true);
        server.setDefaultGameType(net.minecraft.world.level.GameType.SURVIVAL);
        level.getGameRules().getRule(GameRules.RULE_DOMOBSPAWNING).set(false, server);
        level.getGameRules().getRule(GameRules.RULE_DAYLIGHT).set(false, server);
        level.getGameRules().getRule(GameRules.RULE_WEATHER_CYCLE).set(false, server);
        level.setDayTime(13000L);
        level.setWeatherParameters(1_000_000, 0, false, false);

        BlockPos spawn = position(scenario.getAsJsonObject("sharedSpawn"));
        for (int x = spawn.getX() - PLATFORM_RADIUS; x <= spawn.getX() + PLATFORM_RADIUS; x++) {
            for (int z = spawn.getZ() - PLATFORM_RADIUS; z <= spawn.getZ() + PLATFORM_RADIUS; z++) {
                level.setBlock(new BlockPos(x, spawn.getY() - 1, z), Blocks.STONE.defaultBlockState(), 3);
                for (int y = spawn.getY(); y <= spawn.getY() + 5; y++) {
                    level.setBlock(new BlockPos(x, y, z), Blocks.AIR.defaultBlockState(), 3);
                }
            }
        }
        if (scenario.has("structureFixture")) {
            placeStructureFixture(level, scenario.getAsJsonObject("structureFixture"),
                    specificationDirectory);
        }
        boolean netherPrepared = false;
        for (Map.Entry<String, JsonElement> entry
                : scenario.getAsJsonObject("fixtures").entrySet()) {
            JsonObject fixture = entry.getValue().getAsJsonObject();
            if (isNetherFixture(fixture) && !netherPrepared) {
                prepareDryFixtureArea(fixtureLevel(server, fixture),
                        position(fixture.getAsJsonObject("position")));
                netherPrepared = true;
            }
        }
        for (Map.Entry<String, JsonElement> entry
                : scenario.getAsJsonObject("fixtures").entrySet()) {
            JsonObject fixture = entry.getValue().getAsJsonObject();
            ServerLevel fixtureLevel = fixtureLevel(server, fixture);
            Block block = BuiltInRegistries.BLOCK.get(ResourceLocation.parse(
                    fixture.get("blockId").getAsString()));
            BlockPos fixturePosition = position(fixture.getAsJsonObject("position"));
            fixtureLevel.setBlock(fixturePosition, fixtureState(block, fixture), 3);
            fixtureLevel.setChunkForced(fixturePosition.getX() >> 4,
                    fixturePosition.getZ() >> 4, true);
            if (fixture.has("contents")) fillContainer(fixtureLevel, fixturePosition,
                    fixture.getAsJsonArray("contents"), entry.getKey());
        }
        level.setDefaultSpawnPos(spawn, 0.0F);
        level.setChunkForced(spawn.getX() >> 4, spawn.getZ() >> 4, true);
        if (scenario.has("combat")) prepareCombatTargets(level, scenario.getAsJsonObject("combat"));
        verifyGeneratedLayout(server, scenario);
        if (scenario.has("structureFixture")) {
            verifyHiddenMarkers(level, scenario.getAsJsonObject("structureFixture"),
                    specificationDirectory);
        }
    }

    private static void placeStructureFixture(
            ServerLevel level,
            JsonObject reference,
            Path specificationDirectory
    ) throws IOException {
        StructureFixture fixture = readStructureFixture(reference, specificationDirectory);
        CompoundTag structure;
        try {
            structure = NbtUtils.snbtToStructure(Files.readString(fixture.source()));
        } catch (CommandSyntaxException error) {
            throw new IllegalArgumentException("Invalid Ability Conformance structure fixture SNBT", error);
        }
        if (!structure.getList("entities", Tag.TAG_COMPOUND).isEmpty()) {
            throw new IllegalArgumentException("Ability Conformance structure fixtures cannot contain entities");
        }
        BlockPos declaredSize = position(fixture.bundle().getAsJsonObject("size"));
        ListTag size = structure.getList("size", Tag.TAG_INT);
        if (size.size() != 3 || size.getInt(0) != declaredSize.getX()
                || size.getInt(1) != declaredSize.getY() || size.getInt(2) != declaredSize.getZ()) {
            throw new IllegalArgumentException("Structure fixture size does not match its bundle manifest");
        }
        ListTag paletteTag = structure.contains("palettes", Tag.TAG_LIST)
                ? structure.getList("palettes", Tag.TAG_LIST).getList(0)
                : structure.getList("palette", Tag.TAG_COMPOUND);
        List<BlockState> palette = new ArrayList<>(paletteTag.size());
        for (int index = 0; index < paletteTag.size(); index++) {
            palette.add(NbtUtils.readBlockState(
                    level.holderLookup(Registries.BLOCK), paletteTag.getCompound(index)));
        }
        BlockPos origin = position(reference.getAsJsonObject("origin"));
        ListTag blocks = structure.getList("blocks", Tag.TAG_COMPOUND);
        for (int index = 0; index < blocks.size(); index++) {
            CompoundTag cell = blocks.getCompound(index);
            if (cell.contains("nbt", Tag.TAG_COMPOUND)) {
                throw new IllegalArgumentException(
                        "Ability Conformance structure fixtures do not support block entity data");
            }
            ListTag relative = cell.getList("pos", Tag.TAG_INT);
            int paletteIndex = cell.getInt("state");
            if (relative.size() != 3 || paletteIndex < 0 || paletteIndex >= palette.size()) {
                throw new IllegalArgumentException("Invalid block in Ability Conformance structure fixture");
            }
            BlockPos target = origin.offset(relative.getInt(0), relative.getInt(1), relative.getInt(2));
            level.setBlock(target, palette.get(paletteIndex), 3);
            level.setChunkForced(target.getX() >> 4, target.getZ() >> 4, true);
        }
    }

    private static void verifyHiddenMarkers(
            ServerLevel level,
            JsonObject reference,
            Path specificationDirectory
    ) throws IOException {
        for (Map.Entry<String, BlockPos> marker
                : resolveHiddenMarkers(reference, specificationDirectory).entrySet()) {
            if (level.getBlockState(marker.getValue()).isAir()) {
                throw new IllegalStateException("Hidden marker did not resolve to fixture terrain: "
                        + marker.getKey());
            }
        }
    }

    private static Map<String, BlockPos> resolveHiddenMarkers(
            JsonObject reference,
            Path specificationDirectory
    ) throws IOException {
        StructureFixture fixture = readStructureFixture(reference, specificationDirectory);
        BlockPos origin = position(reference.getAsJsonObject("origin"));
        Map<String, BlockPos> resolved = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> marker
                : fixture.bundle().getAsJsonObject("hiddenMarkers").entrySet()) {
            resolved.put(marker.getKey(), origin.offset(position(marker.getValue().getAsJsonObject())));
        }
        return resolved;
    }

    private static StructureFixture readStructureFixture(
            JsonObject reference,
            Path specificationDirectory
    ) throws IOException {
        String id = reference.get("id").getAsString();
        int version = reference.get("version").getAsInt();
        Path directory = specificationDirectory.resolve("world-fixtures")
                .resolve(id).resolve("v" + version);
        JsonObject bundle = JsonParser.parseReader(
                Files.newBufferedReader(directory.resolve("fixture.json"))).getAsJsonObject();
        if (bundle.get("schemaVersion").getAsInt() != 1
                || !"structure.snbt".equals(bundle.get("structure").getAsString())
                || !bundle.has("size") || !bundle.has("hiddenMarkers")) {
            throw new IllegalArgumentException("Invalid Ability Conformance structure fixture bundle");
        }
        return new StructureFixture(bundle, directory.resolve("structure.snbt"));
    }

    private static void prepareCombatTargets(ServerLevel level, JsonObject combat) {
        prepareCombatZombie(level, position(combat.getAsJsonObject("zombiePosition")), 4.0F);
        if (combat.has("distractorZombiePosition")) {
            prepareCombatZombie(level,
                    position(combat.getAsJsonObject("distractorZombiePosition")), 20.0F);
        }
    }

    private static void prepareCombatZombie(ServerLevel level, BlockPos target, float health) {
        Entity entity = EntityType.ZOMBIE.create(level);
        if (!(entity instanceof Zombie zombie)) {
            throw new IllegalArgumentException("Combat fixture currently requires a zombie target");
        }
        zombie.moveTo(target.getX() + 0.5D, target.getY(), target.getZ() + 0.5D, 0.0F, 0.0F);
        zombie.setNoAi(true);
        zombie.setPersistenceRequired();
        zombie.setHealth(health);
        level.setChunkForced(target.getX() >> 4, target.getZ() >> 4, true);
        if (!level.addFreshEntity(zombie)) {
            throw new IllegalStateException("Could not add combat fixture target");
        }
    }

    private static void prepareDryFixtureArea(ServerLevel level, BlockPos center) {
        int radius = 6;
        for (int x = center.getX() - radius; x <= center.getX() + radius; x++) {
            for (int z = center.getZ() - radius; z <= center.getZ() + radius; z++) {
                level.setBlock(new BlockPos(x, center.getY() - 1, z),
                        Blocks.STONE.defaultBlockState(), 3);
                for (int y = center.getY(); y <= center.getY() + 5; y++) {
                    boolean wall = x == center.getX() - radius || x == center.getX() + radius
                            || z == center.getZ() - radius || z == center.getZ() + radius;
                    level.setBlock(new BlockPos(x, y, z),
                            wall ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState(), 3);
                }
            }
        }
    }

    private static BlockState fixtureState(Block block, JsonObject fixture) {
        BlockState state = block.defaultBlockState();
        if (block instanceof BedBlock && fixture.has("state")) {
            JsonObject values = fixture.getAsJsonObject("state");
            state = state
                    .setValue(BedBlock.PART, BedPart.valueOf(values.get("part").getAsString().toUpperCase()))
                    .setValue(BedBlock.FACING, Direction.byName(values.get("facing").getAsString()))
                    .setValue(BedBlock.OCCUPIED, false);
        }
        return state;
    }

    private static void fillContainer(
            ServerLevel level,
            BlockPos position,
            JsonArray contents,
            String fixtureName
    ) {
        if (!(level.getBlockEntity(position) instanceof Container container)) {
            throw new IllegalStateException("Fixture is not a Container: " + fixtureName);
        }
        for (JsonElement element : contents) {
            JsonObject entry = element.getAsJsonObject();
            int slot = entry.get("slot").getAsInt();
            Item item = BuiltInRegistries.ITEM.get(ResourceLocation.parse(entry.get("itemId").getAsString()));
            container.setItem(slot, new ItemStack(item, entry.get("count").getAsInt()));
        }
        level.getBlockEntity(position).setChanged();
    }

    private static void verifyGeneratedLayout(MinecraftServer server, JsonObject scenario) {
        ServerLevel level = server.overworld();
        BlockPos expectedSpawn = position(scenario.getAsJsonObject("sharedSpawn"));
        if (!level.getSharedSpawnPos().equals(expectedSpawn)) {
            throw new IllegalStateException("Generated shared spawn does not match the selected scenario");
        }
        for (Map.Entry<String, JsonElement> entry
                : scenario.getAsJsonObject("fixtures").entrySet()) {
            JsonObject fixture = entry.getValue().getAsJsonObject();
            ServerLevel fixtureLevel = fixtureLevel(server, fixture);
            BlockPos fixturePosition = position(fixture.getAsJsonObject("position"));
            String actualBlock = BuiltInRegistries.BLOCK.getKey(
                    fixtureLevel.getBlockState(fixturePosition).getBlock()).toString();
            if (!fixture.get("blockId").getAsString().equals(actualBlock)) {
                throw new IllegalStateException("Generated fixture block mismatch: " + entry.getKey());
            }
            if (fixture.has("contents")) verifyContainer(
                    fixtureLevel, fixturePosition, fixture.getAsJsonArray("contents"), entry.getKey());
        }
    }

    private static ServerLevel fixtureLevel(MinecraftServer server, JsonObject fixture) {
        if (!fixture.has("dimension")
                || "minecraft:overworld".equals(fixture.get("dimension").getAsString())) {
            return server.overworld();
        }
        if (isNetherFixture(fixture)) {
            ServerLevel nether = server.getLevel(Level.NETHER);
            if (nether == null) throw new IllegalStateException("Nether fixture level is unavailable");
            return nether;
        }
        throw new IllegalArgumentException("Unsupported fixture dimension: "
                + fixture.get("dimension").getAsString());
    }

    private static boolean isNetherFixture(JsonObject fixture) {
        return fixture.has("dimension")
                && "minecraft:the_nether".equals(fixture.get("dimension").getAsString());
    }

    private static void verifyContainer(
            ServerLevel level,
            BlockPos position,
            JsonArray contents,
            String fixtureName
    ) {
        if (!(level.getBlockEntity(position) instanceof Container container)) {
            throw new IllegalStateException("Generated Container is missing: " + fixtureName);
        }
        for (JsonElement element : contents) {
            JsonObject expected = element.getAsJsonObject();
            int slot = expected.get("slot").getAsInt();
            ItemStack actual = container.getItem(slot);
            String actualItem = BuiltInRegistries.ITEM.getKey(actual.getItem()).toString();
            if (!expected.get("itemId").getAsString().equals(actualItem)
                    || expected.get("count").getAsInt() != actual.getCount()) {
                throw new IllegalStateException("Generated Container contents mismatch: "
                        + fixtureName + " slot " + slot);
            }
        }
    }

    private static void validateSpecification(JsonObject scenario) {
        if (!scenario.has("schemaVersion") || scenario.get("schemaVersion").getAsInt() != 1
                || !scenario.has("id") || scenario.get("id").getAsString().isBlank()
                || !scenario.has("difficulty")
                || Difficulty.byName(scenario.get("difficulty").getAsString()) == null
                || !scenario.has("sharedSpawn") || !scenario.get("sharedSpawn").isJsonObject()
                || !scenario.has("fixtures") || !scenario.get("fixtures").isJsonObject()) {
            throw new IllegalArgumentException("Invalid Ability Conformance World Specification");
        }
    }

    private static BlockPos position(JsonObject value) {
        return new BlockPos(
                value.get("x").getAsInt(),
                value.get("y").getAsInt(),
                value.get("z").getAsInt());
    }

    private static void writeGeneratedManifest(
            MinecraftServer server,
            JsonObject scenario,
            Path specificationDirectory
    ) throws IOException {
        JsonObject generated = new JsonObject();
        generated.addProperty("schemaVersion", 1);
        generated.addProperty("scenario", scenario.get("id").getAsString());
        generated.add("difficulty", scenario.get("difficulty"));
        generated.add("sharedSpawn", scenario.get("sharedSpawn"));
        generated.add("fixtures", scenario.get("fixtures"));
        JsonObject hiddenMarkers = new JsonObject();
        if (scenario.has("structureFixture")) {
            JsonObject reference = scenario.getAsJsonObject("structureFixture");
            generated.add("structureFixture", reference);
            for (Map.Entry<String, BlockPos> marker
                    : resolveHiddenMarkers(reference, specificationDirectory).entrySet()) {
                BlockPos absolute = marker.getValue();
                JsonObject value = new JsonObject();
                value.addProperty("x", absolute.getX());
                value.addProperty("y", absolute.getY());
                value.addProperty("z", absolute.getZ());
                hiddenMarkers.add(marker.getKey(), value);
            }
        }
        generated.add("hiddenMarkers", hiddenMarkers);
        if (scenario.has("combat")) generated.add("combat", scenario.get("combat"));
        Path world = server.getWorldPath(LevelResource.ROOT);
        Files.writeString(world.resolve(".ability-conformance-generated.json"),
                JSON.toJson(generated) + System.lineSeparator());
    }

    private record StructureFixture(JsonObject bundle, Path source) { }
}
