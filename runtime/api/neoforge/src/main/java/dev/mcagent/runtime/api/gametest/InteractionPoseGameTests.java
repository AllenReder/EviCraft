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
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.concurrent.atomic.AtomicReference;

/** Real geometry, navigation, and raycast contracts for interaction-reachable poses. */
@GameTestHolder("mc_agent_api")
@PrefixGameTestTemplate(false)
public final class InteractionPoseGameTests {
    private InteractionPoseGameTests() {}

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 300, batch = "interaction_pose_geometry")
    public static void already_reachable_vertical_slab_requires_exact_final_hit(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 2941L);
        BlockPos target = fixture.start().east().above(3);
        fixture.level().setBlockAndUpdate(target.below(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(target, Blocks.STONE_SLAB.defaultBlockState()
                .setValue(SlabBlock.TYPE, SlabType.BOTTOM));
        bind(fixture, fixture.start().offset(-2, -1, -2), target.offset(2, 2, 2));
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, target, "pose-slab", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "interaction pose slab call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal);
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "vertical non-full target did not resolve: " + terminal.get());
                    helper.assertTrue(result.getAsJsonObject("data").has("feet"),
                            "successful pose omitted final Feet Cell: " + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 600, batch = "interaction_pose_activation_chain")
    public static void successful_pose_is_immediately_usable_by_activate_block(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 2945L);
        BlockPos target = fixture.start().offset(4, 3, 4);
        for (BlockPos support : BlockPos.betweenClosed(
                fixture.start().offset(-1, -1, -1), fixture.start().offset(5, -1, 5))) {
            fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        }
        fixture.level().setBlockAndUpdate(target, Blocks.CHEST.defaultBlockState());
        bind(fixture, fixture.start().offset(-2, -2, -2), target.offset(2, 2, 2));
        AtomicReference<String> poseTerminal = new AtomicReference<>();
        AtomicReference<String> activateTerminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, target, "pose-activation-chain", poseTerminal))
                .thenWaitUntil(() -> helper.assertTrue(poseTerminal.get() != null,
                        "interaction pose call did not terminate"))
                .thenExecute(() -> {
                    JsonObject pose = result(poseTerminal);
                    helper.assertTrue(pose.get("success").getAsBoolean(),
                            "interaction pose did not resolve: " + poseTerminal.get());
                    fixture.tools().call(JsonParser.parseString("\"activate-after-pose\""),
                            "activate_block", args(target), activateTerminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(activateTerminal.get() != null,
                        "activate_block after interaction pose did not terminate"))
                .thenExecute(() -> {
                    JsonObject activate = result(activateTerminal);
                    helper.assertTrue(activate.get("success").getAsBoolean()
                                    && "menu_opened".equals(activate.getAsJsonObject("data")
                                    .get("outcome").getAsString()),
                            "successful interaction pose was not immediately usable: "
                                    + activateTerminal.get());
                    fixture.bot().closeContainer();
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 1200, batch = "interaction_pose_navigation")
    public static void navigation_breaks_an_ordinary_route_blocker_but_preserves_target(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 2942L);
        BlockPos target = fixture.start().east(8).above();
        BlockPos blockerLow = fixture.start().east(3);
        BlockPos blockerHigh = blockerLow.above();
        for (int x = fixture.start().getX() - 1; x <= target.getX() + 1; x++) {
            fixture.level().setBlockAndUpdate(new BlockPos(x, fixture.start().getY() - 1,
                    fixture.start().getZ()), Blocks.STONE.defaultBlockState());
            for (int y = fixture.start().getY(); y <= fixture.start().getY() + 2; y++) {
                fixture.level().setBlockAndUpdate(new BlockPos(x, y,
                        fixture.start().getZ() - 1), Blocks.BEDROCK.defaultBlockState());
                fixture.level().setBlockAndUpdate(new BlockPos(x, y,
                        fixture.start().getZ() + 1), Blocks.BEDROCK.defaultBlockState());
            }
            fixture.level().setBlockAndUpdate(new BlockPos(x, fixture.start().getY() + 2,
                    fixture.start().getZ()), Blocks.BEDROCK.defaultBlockState());
        }
        fixture.level().setBlockAndUpdate(blockerLow, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(blockerHigh, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(target, Blocks.OBSIDIAN.defaultBlockState());
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.DIAMOND_PICKAXE));
        fixture.bot().getInventory().selected = 0;
        bind(fixture, fixture.start().offset(-2, -2, -2), target.offset(2, 3, 2));
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, target, "pose-route-break", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "interaction pose route call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal);
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "ordinary route breaking did not reach a verified pose: " + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(blockerLow).isAir()
                                    || fixture.level().getBlockState(blockerHigh).isAir(),
                            "the authorized route blocker was not consumed");
                    helper.assertTrue(fixture.level().getBlockState(target).is(Blocks.OBSIDIAN),
                            "interaction target was broken or replaced during navigation");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 1200, batch = "interaction_pose_fallback")
    public static void failed_occluded_arrival_advances_without_destroying_the_occluder(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 2943L);
        BlockPos target = fixture.start().east(3).above();
        BlockPos occluder = target.west();
        fixture.level().setBlockAndUpdate(target, Blocks.GOLD_BLOCK.defaultBlockState());
        fixture.level().setBlockAndUpdate(occluder, Blocks.OBSIDIAN.defaultBlockState());
        BlockPos northPose = target.north(2).below();
        for (BlockPos support : new BlockPos[] {
                fixture.start().below(), fixture.start().north().below(),
                fixture.start().north(2).below(), northPose.below() }) {
            fixture.level().setBlockAndUpdate(support, Blocks.STONE.defaultBlockState());
        }
        fixture.bot().moveTo(fixture.start().getX() + 0.5, fixture.start().getY(),
                fixture.start().getZ() + 0.5, -90.0F, 0.0F);
        bind(fixture, fixture.start().offset(-2, -2, -4), target.offset(2, 3, 2));
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, target, "pose-fallback", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "interaction pose fallback call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal);
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "an occluded arrival did not advance to another frozen pose: "
                                    + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(occluder).is(Blocks.OBSIDIAN),
                            "the operation proactively destroyed its raycast occluder");
                    helper.assertTrue(fixture.level().getBlockState(target).is(Blocks.GOLD_BLOCK),
                            "fallback navigation mutated the exact target");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 1600, batch = "interaction_pose_excavation")
    public static void buried_target_digs_out_an_adjacent_pose_and_preserves_target(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 2946L);
        BlockPos target = fixture.start().east(3);
        for (BlockPos stone : BlockPos.betweenClosed(
                fixture.start().offset(2, -1, -1), fixture.start().offset(4, 2, 1))) {
            fixture.level().setBlockAndUpdate(stone, Blocks.STONE.defaultBlockState());
        }
        fixture.level().setBlockAndUpdate(fixture.start().east().below(),
                Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(target, Blocks.IRON_ORE.defaultBlockState());
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.DIAMOND_PICKAXE));
        fixture.bot().getInventory().selected = 0;
        bind(fixture, fixture.start().offset(-2, -2, -2), fixture.start().offset(6, 4, 2));
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, target, "pose-excavation", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "buried interaction pose call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal);
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "no dug-out pose reached the buried target: " + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(target).is(Blocks.IRON_ORE),
                            "excavation broke or replaced the buried target");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_interaction", template = "empty_36x20x20",
            timeoutTicks = 360, batch = "interaction_pose_failures")
    public static void unknown_changed_and_exhausted_targets_return_stable_failures(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 2944L);
        BlockPos unknown = fixture.start().east(12).above(5);
        BlockPos changed = fixture.start().east(10).above(4);
        BlockPos exhausted = fixture.start().east(9).above(8);
        fixture.level().setBlockAndUpdate(unknown, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(changed, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(exhausted, Blocks.DIAMOND_BLOCK.defaultBlockState());
        RuntimeKnowledgeFixtures.publishBlock(
                fixture.level().getServer(), fixture.level().dimension().location().toString(),
                fixture.level().getGameTime(), exhausted,
                fixture.level().getBlockState(exhausted), BlockEvidenceSource.MISMATCH);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, unknown, "pose-unknown", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "unknown interaction target did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "target_not_known_block");
                    terminal.set(null);
                    // Stale the record and call in the same tick: the target floats in plain
                    // sight, so any later tick lets grounded perception refresh it legitimately.
                    RuntimeKnowledgeFixtures.publishBlock(fixture.level().getServer(),
                            fixture.level().dimension().location().toString(),
                            fixture.level().getGameTime(), changed,
                            Blocks.STONE.defaultBlockState(), BlockEvidenceSource.MISMATCH);
                    fixture.level().setBlockAndUpdate(changed, Blocks.DIRT.defaultBlockState());
                    call(fixture, changed, "pose-changed", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "changed interaction target did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "target_changed");
                    terminal.set(null);
                    call(fixture, exhausted, "pose-exhausted", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "exhausted interaction target did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "no_interaction_pose");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    private static Fixture fixture(GameTestHelper helper, long session) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        BlockPos start = helper.absolutePos(new BlockPos(4, 300, 4));
        for (BlockPos position : BlockPos.betweenClosed(
                start.offset(-4, -4, -6), start.offset(16, 14, 6))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        level.setBlockAndUpdate(start.below(), Blocks.STONE.defaultBlockState());
        bot.getInventory().clearContent();
        bot.moveTo(start.getX() + 0.5, start.getY(), start.getZ() + 0.5,
                -90.0F, 0.0F);
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, start, tools);
    }

    private static void bind(Fixture fixture, BlockPos min, BlockPos max) {
        RuntimeBotManager.tick(fixture.level().getServer());
        for (BlockPos position : BlockPos.betweenClosed(min, max)) {
            RuntimeKnowledgeFixtures.publishBlock(
                    fixture.level().getServer(),
                    fixture.level().dimension().location().toString(),
                    fixture.level().getGameTime(), position,
                    fixture.level().getBlockState(position), BlockEvidenceSource.MISMATCH);
        }
    }

    private static void call(
            Fixture fixture, BlockPos target, String id, AtomicReference<String> terminal) {
        fixture.tools().call(JsonParser.parseString('"' + id + '"'),
                "goto_block_interaction_pose", args(target), terminal::set);
    }

    private static JsonObject args(BlockPos target) {
        JsonObject args = new JsonObject();
        JsonObject position = new JsonObject();
        position.addProperty("x", target.getX());
        position.addProperty("y", target.getY());
        position.addProperty("z", target.getZ());
        args.add("position", position);
        return args;
    }

    private static JsonObject result(AtomicReference<String> terminal) {
        return JsonParser.parseString(terminal.get()).getAsJsonObject();
    }

    private static void assertFailure(GameTestHelper helper, String raw, String failureType) {
        JsonObject result = JsonParser.parseString(raw).getAsJsonObject();
        helper.assertTrue(!result.get("success").getAsBoolean()
                        && failureType.equals(result.getAsJsonObject("data")
                        .get("failure_type").getAsString()),
                "expected " + failureType + ": " + raw);
    }

    private static void cleanup(Fixture fixture) {
        fixture.tools().sessionClosed(Long.MAX_VALUE);
        RuntimeBotManager.stop(fixture.level().getServer());
    }

    private record Fixture(ServerLevel level, BotPlayer bot, BlockPos start,
                           DefaultRuntimeToolGateway tools) {}
}
