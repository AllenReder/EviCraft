package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.core.combat.Menace;
import dev.mcagent.runtime.core.combat.Swing;
import dev.mcagent.runtime.core.pathing.astar.NavPath;
import dev.mcagent.runtime.core.pathing.execute.ExecHarness;
import dev.mcagent.runtime.core.pathing.execute.PathExecutor;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.goals.GoalBlock;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDescend;
import dev.mcagent.runtime.core.pathing.moves.movements.MovementDownward;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.Task;
import dev.mcagent.runtime.task.TaskDispatch;
import dev.mcagent.runtime.task.TaskFactory;
import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.task.TaskResult;
import dev.mcagent.runtime.task.TaskState;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures;
import dev.mcagent.runtime.api.gametest.VerifiedBlockInteractionGameTests;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockObservation;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/** Baseline movement, interaction and combat behaviors. */
@GameTestHolder("mc_agent")
@PrefixGameTestTemplate(false)
public final class BaselineGameTests {

    private BaselineGameTests() {}

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 240, batch = "verified_activate_menu")
    public static void activate_block_menus(GameTestHelper helper) {
        VerifiedBlockInteractionGameTests
                .activate_block_opens_storage_crafting_and_furnace_menus_with_body_restoration(
                        helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 300, batch = "verified_activate_outcomes")
    public static void activate_block_outcomes(GameTestHelper helper) {
        VerifiedBlockInteractionGameTests
                .activate_block_requires_state_change_and_rejects_changed_evidence(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 300, batch = "verified_activate_failures")
    public static void activate_block_failures(GameTestHelper helper) {
        VerifiedBlockInteractionGameTests
                .activate_block_rejects_open_menu_unknown_reach_and_occlusion(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 900, batch = "verified_activate_cleanup")
    public static void activate_block_cleanup(GameTestHelper helper) {
        VerifiedBlockInteractionGameTests
                .activate_block_restores_body_on_interruption_and_timeout(helper);
    }

    @GameTest(templateNamespace = "mc_agent_goto", template = "floor16",
            timeoutTicks = 1200, batch = "baseline_smoke")
    public static void bot_goto(GameTestHelper helper) {
        prepareFloor16(helper);
        ServerLevel level = helper.getLevel();
        BotPlayer bot = botAt(helper, new BlockPos(2, 2, 2));
        BlockPos target = helper.absolutePos(new BlockPos(13, 2, 13));
        AtomicReference<String> terminal = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(1L);
        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(routeFloorKnown(helper, level, 2, 13),
                        "baseline goto route did not enter World Knowledge"))
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
                    tools.call(JsonParser.parseString("\"baseline-goto\""),
                            "goto", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "baseline goto Tool has not reached a terminal result"))
                .thenExecute(() -> {
                    helper.assertTrue(JsonParser.parseString(terminal.get()).getAsJsonObject()
                                    .get("success").getAsBoolean(),
                            "baseline goto Tool failed: " + terminal.get());
                    helper.assertTrue(bot.blockPosition().distSqr(target) <= 4,
                            "Runtime Bot has not reached the goto target");
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_movement_handoff", template = "empty_36x10x20",
            timeoutTicks = 400, batch = "movement_handoff")
    public static void descend_hands_off_to_vertical_descent(GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        BlockPos src = helper.absolutePos(new BlockPos(4, 4, 4));
        BlockPos descendDest = helper.absolutePos(new BlockPos(5, 3, 4));
        BlockPos downwardDest = descendDest.below();
        BlockPos overshoot = helper.absolutePos(new BlockPos(6, 3, 4));

        level.setBlockAndUpdate(src.below(), Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(downwardDest, Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(downwardDest.below(), Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(overshoot.below(), Blocks.STONE.defaultBlockState());

        BotPlayer bot = botAt(helper, new BlockPos(4, 4, 4));
        bot.getInventory().clearContent();
        bot.getInventory().add(new ItemStack(Items.DIAMOND_PICKAXE));
        bot.setDeltaMovement(Vec3.ZERO);
        bot.fallDistance = 0.0F;

        String dimension = level.dimension().location().toString();
        // The downward typed BREAK still goes through the Physical Verification Authority. Publish only
        // this exact target, so the test does not depend on when any World Knowledge Profile observes it.
        RuntimeKnowledgeFixtures.publishBlock(level.getServer(), dimension,
                level.getGameTime(), downwardDest, Blocks.STONE.defaultBlockState(),
                dev.mcagent.runtime.evidence.BlockEvidenceSource.ATTRIBUTABLE_ACTION);

        Supplier<CalculationContext> contexts = () -> new CalculationContext(
                bot, level, (x, z) -> true, false);
        CalculationContext initial = contexts.get();
        MovementDescend descend = new MovementDescend(bot, src, descendDest);
        MovementDownward downward = new MovementDownward(bot, descendDest, downwardDest);
        for (Movement movement : List.of(descend, downward)) {
            movement.getCost(initial);
            movement.checkLoadedChunk(initial);
        }
        NavPath path = fixedPath(List.of(descend, downward),
                List.of(src, descendDest, downwardDest), new GoalBlock(downwardDest));
        path.sanityCheck();
        helper.assertTrue(path.movements().get(0) instanceof MovementDescend
                        && path.movements().get(1) instanceof MovementDownward,
                "fixture did not create the required Descend -> Downward handoff");

        ExecHarness harness = new ExecHarness(bot, contexts);
        PathExecutor executor = new PathExecutor(path, bot, harness, contexts,
                Optional::empty, (x, z) -> true);
        MovementHandoffTaskRecord record = new MovementHandoffTaskRecord(
                level.getGameTime() + 300, executor, harness);
        TaskFactory.register(MovementHandoffTaskRecord.class, MovementHandoffTask::new);
        TaskDispatch.runSync(bot, record, ignored -> {});

        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(record.getState().isTerminal(),
                        "movement handoff task has not reached a terminal result"))
                .thenExecute(() -> {
                    helper.assertTrue(record.getState() == TaskState.SUCCESS,
                            "Descend -> Downward executor failed: " + executor.failureCause());
                    helper.assertTrue(!executor.failed() && executor.failureCause() == null,
                            "executor recorded a handoff failure: " + executor.failureCause());
                    helper.assertTrue(executor.finished(),
                            "executor stopped before completing the explicit path");
                    helper.assertTrue(PathExecutor.playerFeet(bot).equals(downwardDest),
                            "Runtime Bot finished outside the downward destination: "
                                    + PathExecutor.playerFeet(bot).toShortString());
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_door", template = "floor16",
            timeoutTicks = 1200, batch = "baseline_smoke_door")
    public static void goto_through_closed_door(GameTestHelper helper) {
        prepareFloor16(helper);
        ServerLevel level = helper.getLevel();
        for (int x = 1; x <= 5; x++) {
            for (int z = 1; z <= 5; z++) {
                if (x != 1 && x != 5 && z != 1 && z != 5) continue;
                for (int y = 2; y <= 4; y++) {
                    if (x == 3 && z == 5 && y <= 3) continue;
                    level.setBlockAndUpdate(helper.absolutePos(new BlockPos(x, y, z)),
                            Blocks.STONE.defaultBlockState());
                }
            }
        }
        BlockPos doorLow = helper.absolutePos(new BlockPos(3, 2, 5));
        var lower = Blocks.OAK_DOOR.defaultBlockState()
                .setValue(net.minecraft.world.level.block.DoorBlock.FACING,
                        net.minecraft.core.Direction.SOUTH);
        level.setBlockAndUpdate(doorLow, lower);
        level.setBlockAndUpdate(doorLow.above(), lower.setValue(
                net.minecraft.world.level.block.DoorBlock.HALF,
                net.minecraft.world.level.block.state.properties.DoubleBlockHalf.UPPER));
        BotPlayer bot = botAt(helper, new BlockPos(3, 2, 3));
        BlockPos target = helper.absolutePos(new BlockPos(3, 2, 7));
        String dimension = level.dimension().location().toString();
        long initialRevision = RuntimeBotManager.observationRevision(level.getServer());
        AtomicReference<String> terminal = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(2L);
        List<AttributableWorldUpdate.BlockFact> facts = new java.util.ArrayList<>();
        for (int x = 1; x <= 5; x++) {
            for (int z = 1; z <= 8; z++) {
                for (int y = 1; y <= 4; y++) {
                    BlockPos routeCell = helper.absolutePos(new BlockPos(x, y, z));
                    facts.add(new AttributableWorldUpdate.BlockFact(dimension,
                            level.getGameTime(), BlockObservation.of(routeCell,
                                    level.getBlockState(routeCell), BlockEvidenceSource.MISMATCH)));
                }
            }
        }
        facts.add(new AttributableWorldUpdate.BlockFact(dimension, level.getGameTime(),
                BlockObservation.of(doorLow, level.getBlockState(doorLow),
                        BlockEvidenceSource.MISMATCH)));
        facts.add(new AttributableWorldUpdate.BlockFact(dimension, level.getGameTime(),
                BlockObservation.of(doorLow.above(), level.getBlockState(doorLow.above()),
                        BlockEvidenceSource.MISMATCH)));
        RuntimeBotManager.publishAttributable(level.getServer(),
                new AttributableWorldUpdate(facts, List.of(), List.of()));
        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(
                        RuntimeBotManager.observationRevision(level.getServer()) > initialRevision
                                && RuntimeKnowledgeFixtures.block(level.getServer(), dimension,
                                doorLow).state()
                                == dev.mcagent.runtime.evidence.BlockEvidenceCell.State.KNOWN_BLOCK,
                        "door route did not enter World Knowledge"))
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
                    tools.call(JsonParser.parseString("\"baseline-door-goto\""),
                            "goto", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "door goto Tool has not reached a terminal result"))
                .thenExecute(() -> {
                    helper.assertTrue(JsonParser.parseString(terminal.get()).getAsJsonObject()
                                    .get("success").getAsBoolean(),
                            "door goto Tool failed: " + terminal.get());
                    helper.assertTrue(bot.blockPosition().distSqr(target) <= 4,
                            "Runtime Bot has not escaped through the door");
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 100_000, batch = "baseline_combat")
    public static void combat_holds_the_skirmish_band(GameTestHelper helper) {
        prepareFloor16(helper);
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos spawn = helper.absolutePos(new BlockPos(3, 2, 3));
        bot.moveTo(spawn.getX() + 0.5, spawn.getY(), spawn.getZ() + 0.5,
                bot.getYRot(), bot.getXRot());
        bot.fallDistance = 0.0F;
        bot.setHealth(bot.getMaxHealth());
        bot.getFoodData().setFoodLevel(20);
        bot.getInventory().clearContent();
        bot.getInventory().add(new ItemStack(Items.IRON_SWORD));

        Zombie zombie = EntityType.ZOMBIE.create(level);
        helper.assertTrue(zombie != null, "zombie did not spawn");
        BlockPos zombieSpawn = helper.absolutePos(new BlockPos(6, 2, 3));
        zombie.moveTo(zombieSpawn.getX() + 0.5, zombieSpawn.getY(),
                zombieSpawn.getZ() + 0.5, 0.0F, 0.0F);
        zombie.setHealth(2.0F);
        zombie.setTarget(bot);
        level.addFreshEntity(zombie);

        double inner = Menace.rawDangerRadius(zombie, bot);
        double outer = Swing.reachTo(
                bot.getAttributeValue(Attributes.ENTITY_INTERACTION_RANGE),
                zombie.getBbWidth());
        float startHealth = zombie.getHealth();
        int[] insideBand = {0};
        AtomicReference<String> terminal = new AtomicReference<>();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(3L);

        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(
                        dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.entity(level.getServer(), zombie.getUUID())
                                .map(track -> track.state() == EntityTrack.State.VISIBLE)
                                .orElse(false),
                        "combat target did not become VISIBLE evidence"))
                .thenExecute(() -> {
                    JsonArray uuids = new JsonArray();
                    uuids.add(zombie.getUUID().toString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    tools.call(JsonParser.parseString("\"baseline-combat\""),
                            "attack", args, terminal::set);
                })
                .thenWaitUntil(() -> {
                    helper.assertTrue(bot.isAlive(), "Runtime Bot died to a single zombie");
                    double distance = bot.distanceTo(zombie);
                    if (distance >= inner && distance <= outer) insideBand[0]++;
                    helper.assertTrue(zombie.getHealth() < startHealth || !zombie.isAlive()
                                    || insideBand[0] < 200,
                            "Runtime Bot never landed a hit: distance "
                                    + String.format("%.2f", distance) + " band ["
                                    + String.format("%.2f", inner) + ", "
                                    + String.format("%.2f", outer) + "]");
                    helper.assertTrue(terminal.get() != null,
                            "baseline attack Tool has not reached a terminal result");
                })
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "baseline attack Tool failed: " + terminal.get());
                    helper.assertTrue(!zombie.isAlive(), "zombie still up");
                    helper.assertTrue(insideBand[0] > 0,
                            "Runtime Bot never occupied the skirmish band");
                    bot.getInventory().clearContent();
                    Vec3 sharedSpawn = Vec3.atBottomCenterOf(level.getSharedSpawnPos());
                    bot.moveTo(sharedSpawn.x, sharedSpawn.y, sharedSpawn.z,
                            bot.getYRot(), bot.getXRot());
                })
                .thenSucceed();
    }

    private static void prepareFloor16(GameTestHelper helper) {
        for (BlockPos position : BlockPos.betweenClosed(
                new BlockPos(0, 1, 0), new BlockPos(15, 1, 15))) {
            helper.getLevel().setBlockAndUpdate(
                    helper.absolutePos(position), Blocks.STONE.defaultBlockState());
        }
    }

    private static BotPlayer botAt(GameTestHelper helper, BlockPos relative) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos position = helper.absolutePos(relative);
        bot.teleportTo(level, position.getX() + 0.5, position.getY(), position.getZ() + 0.5,
                java.util.Set.of(), bot.getYRot(), bot.getXRot());
        return bot;
    }

    private static NavPath fixedPath(
            List<Movement> movements, List<BlockPos> positions, Goal goal) {
        return new NavPath() {
            @Override
            public List<Movement> movements() {
                return movements;
            }

            @Override
            public List<BlockPos> positions() {
                return positions;
            }

            @Override
            public Goal getGoal() {
                return goal;
            }

            @Override
            public int getNumNodesConsidered() {
                return 0;
            }
        };
    }

    private static final class MovementHandoffTaskRecord extends TaskRecord {
        private final PathExecutor executor;
        private final ExecHarness harness;

        private MovementHandoffTaskRecord(
                long deadlineGameTime, PathExecutor executor, ExecHarness harness) {
            super("movement_handoff", "runtime-movement-handoff", deadlineGameTime);
            this.executor = executor;
            this.harness = harness;
        }
    }

    private static final class MovementHandoffTask implements Task {
        private final MovementHandoffTaskRecord record;

        private MovementHandoffTask(BotPlayer player, MovementHandoffTaskRecord record) {
            this.record = record;
        }

        @Override
        public TaskState tick(BotPlayer bot) {
            record.executor.onTick();
            record.harness.commitIfDirty();
            bot.setSprinting(record.executor.isSprinting());
            if (record.executor.failed()) return TaskState.FAILED;
            return record.executor.finished() ? TaskState.SUCCESS : TaskState.RUNNING;
        }

        @Override
        public void stop(BotPlayer bot, StopReason why) {
            record.harness.clearAllKeys();
        }

        @Override
        public TaskResult result(TaskState terminal) {
            return terminal == TaskState.SUCCESS
                    ? TaskResult.ok("movement handoff completed", Map.of())
                    : TaskResult.fail("movement handoff failed: "
                            + record.executor.failureCause());
        }

        @Override
        public String name() {
            return "MovementHandoffTask";
        }
    }

    private static boolean routeFloorKnown(
            GameTestHelper helper, ServerLevel level, int start, int end) {
        String dimension = level.dimension().location().toString();
        for (int coordinate = start; coordinate <= end; coordinate++) {
            BlockPos floor = helper.absolutePos(new BlockPos(coordinate, 1, coordinate));
            if (RuntimeKnowledgeFixtures.block(level.getServer(), dimension, floor).state()
                    == dev.mcagent.runtime.evidence.BlockEvidenceCell.State.UNKNOWN) return false;
        }
        return true;
    }
}
