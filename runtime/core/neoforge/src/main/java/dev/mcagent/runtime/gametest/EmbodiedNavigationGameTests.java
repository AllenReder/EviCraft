package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.concurrent.atomic.AtomicReference;

@GameTestHolder("mc_agent_api")
@PrefixGameTestTemplate(false)
public final class EmbodiedNavigationGameTests {

    private EmbodiedNavigationGameTests() {}

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 1200, batch = "embodied_unknown_navigation")
    public static void goto_stops_at_unknown_frontier_then_replans_after_observation(
            GameTestHelper helper) {
        goto_stops_at_unknown_frontier_then_replans_after_observation(helper, helper::succeed);
    }

    public static void goto_stops_at_unknown_frontier_then_replans_after_observation(
            GameTestHelper helper, Runnable onSuccess) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos start = helper.absolutePos(new BlockPos(4, 260, 4));
        BlockPos wallCenter = start.east(2);
        BlockPos target = start.east(5);
        BlockPos frontierApproach = wallCenter.east().south(3);
        BlockPos underFrontier = frontierApproach.below(3);
        BlockPos underTarget = target.below(3);
        for (BlockPos position : BlockPos.betweenClosed(
                start.offset(-2, -2, -6), target.offset(2, 5, 6))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        for (BlockPos position : BlockPos.betweenClosed(
                start.offset(-2, -1, -6), target.offset(2, -1, 6))) {
            level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
        }
        for (BlockPos position : BlockPos.betweenClosed(
                wallCenter.offset(0, 0, -2), wallCenter.offset(0, 3, 2))) {
            level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
        }
        level.setBlockAndUpdate(underFrontier.below(), Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(underTarget.below(), Blocks.STONE.defaultBlockState());
        bot.setInvulnerable(true);
        bot.fallDistance = 0.0F;
        bot.setHealth(bot.getMaxHealth());
        bot.moveTo(underFrontier.getX() + 0.5, underFrontier.getY(), underFrontier.getZ() + 0.5,
                90.0F, 0.0F);

        String dimension = level.dimension().location().toString();
        long initialRevision = RuntimeBotManager.observationRevision(level.getServer());
        AtomicReference<String> terminal = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(2L);
        long[] targetFloorRevision = new long[1];
        long[] startRevision = new long[1];

        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > initialRevision
                                && dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                frontierApproach.below()).state()
                                == BlockEvidenceCell.State.KNOWN_BLOCK,
                        "underside observation did not establish the frontier-route support"))
                .thenExecute(() -> {
                    bot.moveTo(underTarget.getX() + 0.5, underTarget.getY(),
                            underTarget.getZ() + 0.5, 90.0F, 0.0F);
                    targetFloorRevision[0] = RuntimeBotManager.observationRevision(
                            level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer())
                                > targetFloorRevision[0]
                                && dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                target.below()).state() == BlockEvidenceCell.State.KNOWN_BLOCK
                                && dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                target).state() == BlockEvidenceCell.State.UNKNOWN,
                        "underside observation leaked the hidden target or missed its support"))
                .thenExecute(() -> {
                    bot.moveTo(start.getX() + 0.5, start.getY(), start.getZ() + 0.5,
                            90.0F, 0.0F);
                    startRevision[0] = RuntimeBotManager.observationRevision(level.getServer());
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > startRevision[0]
                                && dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                wallCenter).state() == BlockEvidenceCell.State.KNOWN_BLOCK
                                && dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                frontierApproach).state() == BlockEvidenceCell.State.UNKNOWN
                                && dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                target).state() == BlockEvidenceCell.State.UNKNOWN,
                        "start observation did not establish a visible wall with an occluded "
                                + "UNKNOWN target"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    JsonObject position = new JsonObject();
                    position.addProperty("x", target.getX());
                    position.addProperty("y", target.getY());
                    position.addProperty("z", target.getZ());
                    JsonObject goal = new JsonObject();
                    goal.addProperty("kind", "cell");
                    goal.add("position", position);
                    args.add("goal", goal);
                    tools.call(JsonParser.parseString("\"unknown-frontier-goto\""),
                            "goto", args, terminal::set);
                })
                // Which cell the route first ends on depends on how much the eye sees past the
                // wall's corner on the way there, so the test pins the order of events only:
                // the dependency behind the wall is observed while the goto is still running.
                .thenWaitUntil(() -> {
                    helper.assertTrue(dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                    frontierApproach).state() != BlockEvidenceCell.State.UNKNOWN,
                            "frontier observation has not resolved the first UNKNOWN dependency");
                    helper.assertTrue(terminal.get() == null,
                            "goto completed before observing and replanning the UNKNOWN frontier");
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(), dimension, target).state()
                                != BlockEvidenceCell.State.UNKNOWN,
                        "bot did not move to the frontier and observe the hidden target"))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "goto did not replan to a terminal result after frontier observation"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "replanned UNKNOWN-frontier goto failed: " + terminal.get());
                    for (BlockPos position : BlockPos.betweenClosed(
                            wallCenter.offset(0, 0, -2), wallCenter.offset(0, 3, 2))) {
                        helper.assertTrue(level.getBlockState(position).is(Blocks.STONE),
                                "goto mutated the Evidence-known occluding wall");
                    }
                    bot.setInvulnerable(false);
                    bot.fallDistance = 0.0F;
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.getYRot(), bot.getXRot());
                })
                .thenExecute(onSuccess);
    }

}
