package dev.mcagent.runtime.api.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.concurrent.atomic.AtomicReference;

/** Real fluid geometry for evidence-bound bucket use: surfaces below eye level and lava pours. */
@GameTestHolder("mc_agent_api")
@PrefixGameTestTemplate(false)
public final class VerifiedBucketGameTests {
    private VerifiedBucketGameTests() {}

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 200, batch = "bucket_fluid_surface")
    public static void empty_bucket_fills_from_a_source_surface_below_eye_level(GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.WATER.defaultBlockState(), Items.BUCKET, 3101L);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "bucket-fill", "minecraft:bucket", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "bucket fill did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "empty bucket did not fill from the visible source: " + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(fixture.target()).isAir(),
                            "the exact source cell was not emptied");
                    helper.assertTrue(fixture.bot().getInventory().countItem(Items.WATER_BUCKET) == 1,
                            "the bucket did not become a water bucket");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 200, batch = "bucket_pour_on_lava")
    public static void water_bucket_pours_into_a_lava_cell_through_its_floor_face(GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.LAVA.defaultBlockState(), Items.WATER_BUCKET, 3102L);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "bucket-pour", "minecraft:water_bucket", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "water bucket pour did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && "target_block_changed".equals(result.getAsJsonObject("data")
                                    .get("outcome").getAsString()),
                            "water bucket did not change the lava cell: " + terminal.get());
                    helper.assertTrue(!fixture.level().getBlockState(fixture.target()).is(Blocks.LAVA),
                            "the lava cell still holds lava");
                    helper.assertTrue(fixture.bot().getInventory().countItem(Items.BUCKET) == 1,
                            "the water bucket was not emptied");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 200, batch = "bucket_not_a_source")
    public static void empty_bucket_on_a_block_without_a_source_names_the_source_rule(GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.STONE.defaultBlockState(), Items.BUCKET, 3103L);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "bucket-no-source", "minecraft:bucket", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "bucket use did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "not_fluid_source".equals(result.getAsJsonObject("data")
                                    .get("failure_type").getAsString()),
                            "empty bucket on stone did not report not_fluid_source: " + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 600, batch = "bucket_pose_to_fluid")
    public static void bucket_pose_walks_within_reach_of_a_distant_source(GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.WATER.defaultBlockState(), Items.BUCKET, 3104L, 7);
        AtomicReference<String> pose = new AtomicReference<>();
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> {
                    JsonObject args = args(fixture, "minecraft:bucket");
                    fixture.tools().call(JsonParser.parseString("\"bucket-pose\""),
                            "goto_block_interaction_pose", args, pose::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(pose.get() != null,
                        "bucket pose did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(pose.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "no pose reached the distant source: " + pose.get());
                    helper.assertTrue(fixture.level().getFluidState(fixture.bot().blockPosition()).isEmpty(),
                            "the pose stands in a fluid cell");
                    call(fixture, "bucket-fill-after-pose", "minecraft:bucket", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "bucket fill after the pose did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && fixture.bot().getInventory().countItem(Items.WATER_BUCKET) == 1,
                            "bucket did not fill from the pose: " + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 200, batch = "bucket_pose_missing_item")
    public static void pose_for_an_item_not_carried_fails_as_item_not_found(GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.WATER.defaultBlockState(), Items.BUCKET, 3105L, 7);
        AtomicReference<String> pose = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> fixture.tools().call(JsonParser.parseString("\"pose-missing-item\""),
                        "goto_block_interaction_pose", args(fixture, "minecraft:water_bucket"), pose::set))
                .thenWaitUntil(() -> helper.assertTrue(pose.get() != null,
                        "pose for a missing item did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(pose.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "item_not_found".equals(result.getAsJsonObject("data")
                                    .get("failure_type").getAsString()),
                            "pose for a missing item did not report item_not_found: " + pose.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    private static Fixture fixture(GameTestHelper helper, BlockState fluid, Item bucket, long session) {
        return fixture(helper, fluid, bucket, session, 2);
    }

    /** Bot on a stone floor; the target sits {@code east} cells east and one below, walled in stone. */
    private static Fixture fixture(
            GameTestHelper helper, BlockState fluid, Item bucket, long session, int east) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        BlockPos feet = helper.absolutePos(new BlockPos(4, 300, 4));
        BlockPos target = feet.east(east).below();
        for (BlockPos position : BlockPos.betweenClosed(feet.offset(-3, -3, -3), feet.offset(east + 3, 3, 3))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        for (BlockPos position : BlockPos.betweenClosed(feet.offset(-1, -2, -2), feet.offset(east + 1, -1, 2))) {
            level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
        }
        level.setBlockAndUpdate(target, fluid);
        bot.getInventory().clearContent();
        bot.getInventory().setItem(3, new ItemStack(bucket));
        bot.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, -90.0F, 0.0F);
        RuntimeBotManager.tick(level.getServer());
        // The whole cleared box is known, so a pose search can stand anywhere on the floor.
        for (BlockPos position : BlockPos.betweenClosed(feet.offset(-3, -3, -3), feet.offset(east + 3, 3, 3))) {
            RuntimeKnowledgeFixtures.publishBlock(level.getServer(),
                    level.dimension().location().toString(), level.getGameTime(), position,
                    level.getBlockState(position), BlockEvidenceSource.MISMATCH);
        }
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, target, tools);
    }

    private static void call(Fixture fixture, String id, String itemId, AtomicReference<String> terminal) {
        fixture.tools().call(JsonParser.parseString('"' + id + '"'),
                "use_item_on_block", args(fixture, itemId), terminal::set);
    }

    private static JsonObject args(Fixture fixture, String itemId) {
        JsonObject args = new JsonObject();
        args.addProperty("item_id", itemId);
        JsonObject position = new JsonObject();
        position.addProperty("x", fixture.target().getX());
        position.addProperty("y", fixture.target().getY());
        position.addProperty("z", fixture.target().getZ());
        args.add("position", position);
        return args;
    }

    private static void cleanup(Fixture fixture) {
        fixture.bot().getInventory().clearContent();
        fixture.tools().sessionClosed(Long.MAX_VALUE);
        RuntimeBotManager.stop(fixture.level().getServer());
    }

    private record Fixture(ServerLevel level, BotPlayer bot, BlockPos target,
                           DefaultRuntimeToolGateway tools) {}
}
