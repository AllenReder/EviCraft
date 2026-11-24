package dev.mcagent.runtime.api.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;

import java.util.concurrent.atomic.AtomicReference;

/** Real NeoForge coverage for exact, safe, verified bed entry. */
public final class VerifiedBedEntryGameTests {
    private VerifiedBedEntryGameTests() {}

    public static void either_half_normalizes_to_head_and_verifies_sleep(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 300L);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> fixture.level().setDayTime(13000L))
                .thenIdle(1)
                .thenExecute(() -> call(fixture, fixture.foot(), "enter-foot", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "foot bed entry did not terminate"))
                .thenExecute(() -> {
                    assertSuccess(helper, terminal.get(), fixture.head());
                    helper.assertTrue(fixture.bot().isSleeping(),
                            "enter_bed reported success without isSleeping()");
                    fixture.bot().stopSleepInBed(true, true);
                    terminal.set(null);
                    call(fixture, fixture.head(), "enter-head", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "head bed entry did not terminate"))
                .thenExecute(() -> {
                    assertSuccess(helper, terminal.get(), fixture.head());
                    helper.assertTrue(fixture.bot().isSleeping(),
                            "head entry did not verify sleeping");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void local_failures_are_typed(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 301L);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> fixture.level().setDayTime(13000L))
                .thenIdle(1)
                .thenExecute(() -> {
                    setOccupied(fixture, true);
                    bind(fixture);
                    call(fixture, fixture.foot(), "enter-occupied", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "occupied bed entry did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "occupied");
                    setOccupied(fixture, false);
                    fixture.level().setBlockAndUpdate(fixture.foot().above(), Blocks.STONE.defaultBlockState());
                    fixture.level().setBlockAndUpdate(fixture.head().above(), Blocks.STONE.defaultBlockState());
                    bind(fixture);
                    terminal.set(null);
                    call(fixture, fixture.head(), "enter-obstructed", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "obstructed bed entry did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "obstructed");
                    fixture.level().setBlockAndUpdate(fixture.foot().above(), Blocks.AIR.defaultBlockState());
                    fixture.level().setBlockAndUpdate(fixture.head().above(), Blocks.AIR.defaultBlockState());
                    Zombie zombie = EntityType.ZOMBIE.create(fixture.level());
                    helper.assertTrue(zombie != null, "zombie did not spawn");
                    zombie.moveTo(fixture.head().getX() + 2.5, fixture.head().getY(),
                            fixture.head().getZ() + 0.5, 0.0F, 0.0F);
                    zombie.setNoAi(true);
                    fixture.level().addFreshEntity(zombie);
                    bind(fixture);
                    terminal.set(null);
                    call(fixture, fixture.foot(), "enter-monster", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "unsafe bed entry did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "unsafe_nearby_monster");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void daytime_is_a_stable_global_failure(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 302L);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> fixture.level().setDayTime(6000L))
                .thenIdle(1)
                .thenExecute(() -> call(fixture, fixture.foot(), "enter-day", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "daytime bed entry did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "not_sleep_time");
                    helper.assertTrue(!fixture.bot().isSleeping(),
                            "daytime rejection entered sleep");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void loaded_known_occluded_bed_has_no_physical_privilege(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 304L);
        AtomicReference<String> terminal = new AtomicReference<>();
        BlockPos blocker = fixture.foot().west();

        helper.startSequence()
                .thenExecute(() -> {
                    fixture.level().setDayTime(13000L);
                    fixture.bot().moveTo(fixture.foot().getX() - 3.5, fixture.foot().getY(),
                            fixture.foot().getZ() + 0.5, -90.0F, 0.0F);
                    fixture.level().setBlockAndUpdate(blocker, Blocks.STONE.defaultBlockState());
                    bind(fixture);
                })
                .thenIdle(1)
                .thenExecute(() -> call(fixture, fixture.foot(), "enter-occluded", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "occluded bed entry did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "occluded");
                    helper.assertTrue(!fixture.bot().isSleeping(),
                            "loaded-known occluded bed entered sleep");
                    helper.assertTrue(fixture.level().getBlockState(fixture.foot()).getBlock()
                                    instanceof BedBlock
                                    && fixture.level().getBlockState(fixture.head()).getBlock()
                                    instanceof BedBlock,
                            "failed occluded bed entry mutated the bed");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void explosive_dimension_is_refused_before_bed_activation(GameTestHelper helper) {
        Fixture overworld = fixture(helper, 303L);
        ServerLevel nether = helper.getLevel().getServer().getLevel(Level.NETHER);
        helper.assertTrue(nether != null, "Nether level is unavailable");
        BlockPos foot = new BlockPos(0, 80, 0);
        BlockPos head = foot.east();
        prepareBed(nether, foot, head);
        overworld.bot().teleportTo(nether, foot.getX() - 1.5, foot.getY(),
                foot.getZ() + 0.5, -90.0F, 0.0F);
        Fixture fixture = new Fixture(nether, overworld.bot(), foot, head, overworld.tools());
        bind(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, foot, "enter-nether", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "Nether bed refusal did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "bed_not_usable_in_dimension");
                    helper.assertTrue(nether.getBlockState(foot).getBlock() instanceof BedBlock
                                    && nether.getBlockState(head).getBlock() instanceof BedBlock,
                            "enter_bed activated and destroyed the Nether bed");
                    overworld.bot().teleportTo(helper.getLevel(),
                            helper.getLevel().getSharedSpawnPos().getX() + 0.5,
                            helper.getLevel().getSharedSpawnPos().getY(),
                            helper.getLevel().getSharedSpawnPos().getZ() + 0.5,
                            0.0F, 0.0F);
                    cleanup(new Fixture(helper.getLevel(), overworld.bot(),
                            overworld.foot(), overworld.head(), overworld.tools()));
                })
                .thenSucceed();
    }

    private static Fixture fixture(GameTestHelper helper, long session) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos foot = helper.absolutePos(new BlockPos(6, 4, 6));
        BlockPos head = foot.east();
        for (BlockPos position : BlockPos.betweenClosed(
                foot.offset(-4, -2, -4), foot.offset(5, 4, 4))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        prepareBed(level, foot, head);
        bot.moveTo(foot.getX() - 1.5, foot.getY(), foot.getZ() + 0.5, -90.0F, 0.0F);
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        Fixture fixture = new Fixture(level, bot, foot, head, tools);
        bind(fixture);
        return fixture;
    }

    private static void prepareBed(ServerLevel level, BlockPos foot, BlockPos head) {
        level.setBlockAndUpdate(foot.below(), Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(head.below(), Blocks.STONE.defaultBlockState());
        BlockState base = Blocks.RED_BED.defaultBlockState()
                .setValue(BedBlock.FACING, Direction.EAST)
                .setValue(BedBlock.OCCUPIED, false);
        level.setBlockAndUpdate(foot, base.setValue(BedBlock.PART, BedPart.FOOT));
        level.setBlockAndUpdate(head, base.setValue(BedBlock.PART, BedPart.HEAD));
    }

    private static void setOccupied(Fixture fixture, boolean occupied) {
        fixture.level().setBlockAndUpdate(fixture.foot(),
                fixture.level().getBlockState(fixture.foot()).setValue(BedBlock.OCCUPIED, occupied));
        fixture.level().setBlockAndUpdate(fixture.head(),
                fixture.level().getBlockState(fixture.head()).setValue(BedBlock.OCCUPIED, occupied));
    }

    private static void bind(Fixture fixture) {
        RuntimeBotManager.tick(fixture.level().getServer());
        for (BlockPos position : new BlockPos[]{fixture.foot(), fixture.head()}) {
            RuntimeKnowledgeFixtures.publishBlock(
                    fixture.level().getServer(), fixture.level().dimension().location().toString(),
                    fixture.level().getGameTime(), position, fixture.level().getBlockState(position),
                    BlockEvidenceSource.MISMATCH);
        }
    }

    private static void call(Fixture fixture, BlockPos target, String id,
                             AtomicReference<String> terminal) {
        JsonObject position = new JsonObject();
        position.addProperty("x", target.getX());
        position.addProperty("y", target.getY());
        position.addProperty("z", target.getZ());
        JsonObject args = new JsonObject();
        args.add("position", position);
        fixture.tools().call(JsonParser.parseString('"' + id + '"'),
                "enter_bed", args, terminal::set);
    }

    private static void assertSuccess(GameTestHelper helper, String terminal, BlockPos head) {
        JsonObject result = JsonParser.parseString(terminal).getAsJsonObject();
        JsonObject position = result.getAsJsonObject("data").getAsJsonObject("position");
        helper.assertTrue(result.get("success").getAsBoolean()
                        && result.getAsJsonObject("data").get("sleeping").getAsBoolean()
                        && position.get("x").getAsInt() == head.getX()
                        && position.get("y").getAsInt() == head.getY()
                        && position.get("z").getAsInt() == head.getZ(),
                "enter_bed did not return normalized verified sleep: " + terminal);
    }

    private static void assertFailure(GameTestHelper helper, String terminal, String expected) {
        JsonObject result = JsonParser.parseString(terminal).getAsJsonObject();
        helper.assertTrue(!result.get("success").getAsBoolean()
                        && expected.equals(result.getAsJsonObject("data")
                        .get("failure_type").getAsString()),
                "enter_bed did not return " + expected + ": " + terminal);
    }

    private static void cleanup(Fixture fixture) {
        if (fixture.bot().isSleeping()) fixture.bot().stopSleepInBed(true, true);
        fixture.bot().setDeltaMovement(net.minecraft.world.phys.Vec3.ZERO);
        fixture.bot().fallDistance = 0.0F;
    }

    private record Fixture(ServerLevel level, BotPlayer bot, BlockPos foot, BlockPos head,
                           DefaultRuntimeToolGateway tools) {}
}
