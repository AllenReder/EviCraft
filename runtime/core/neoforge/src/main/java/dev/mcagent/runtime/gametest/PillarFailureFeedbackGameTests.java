package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;
import dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials;
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
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Pillar-jump failure feedback: a feasible pillar forms real support; an infeasible pillar ends after
 * a bounded number of attempts with an explainable reason instead of retrying forever; a transient
 * entity blockage recovers once it clears. Driven through the goto tool (the same MoveToTask →
 * PlayerNav chain as production). The terminal message of an infeasible case must name the recurring
 * failed action and its failure code.
 */
public final class PillarFailureFeedbackGameTests {

    private static final int SCAFFOLD_COUNT = 16;

    private PillarFailureFeedbackGameTests() {}

    /** Feasible pillar: target two cells up, open headroom. Must succeed and consume scaffold material. */
    public static void feasible_pillar_forms_real_support(GameTestHelper helper) {
        Fixture fixture = pillarFixture(helper, 45901L, false);
        bindFixture(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> gotoExact(fixture, terminal))
                .thenWaitUntil(() -> terminated(terminal, helper, "feasible pillar"))
                .thenExecute(() -> {
                    helper.assertTrue(result(terminal).get("success").getAsBoolean(),
                            "feasible pillar did not arrive: " + terminal.get());
                    helper.assertTrue(scaffoldCount(fixture.bot()) < SCAFFOLD_COUNT,
                            "pillar formed without consuming Scaffold Material");
                    helper.assertTrue(
                            fixture.level().getBlockState(fixture.start().above(1)).is(Blocks.DIRT)
                                    || fixture.level().getBlockState(
                                            fixture.start().above(1)).isSolid(),
                            "no support block was placed at the pillar cell");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    /** Infeasible pillar: every pillar placement is proven impossible, so after bounded attempts the
     * navigation FAILS with a reason that names the failure code. Drives PlayerNav directly: goto would
     * degrade an unreachable target to "nearby ground" and succeed, never exercising the failure chain.
     * The navigation's own retry bound keeps the outcome bounded. */
    public static void infeasible_pillar_fails_explained_within_bounded_attempts(GameTestHelper helper) {
        Fixture fixture = pillarFixture(helper, 45902L, false, true);
        bindFixture(fixture);
        AtomicReference<PlayerNav.Status> terminal = new AtomicReference<>();
        PlayerNav nav = PlayerNav.to(fixture.bot(),
                () -> GoalCompiler.standOn(fixture.target()),
                1.0, () -> feet(fixture.bot()).equals(fixture.target()));
        // Failure-chain probe: proves a failure receipt really travels from a PVA Failed result to the
        // movement, rather than the search layer ending with no-path. This is the evidence that the
        // explainable result comes from the failure feedback chain and not from an exhausted search budget.
        AtomicReference<Integer> receipts = new AtomicReference<>(0);
        nav.core().harness().setFailureSinkForTest((movement, mutation, failure) -> {
            receipts.set(receipts.get() + 1);
            movement.onRouteMutationFailed(mutation, failure);
        });

        helper.startSequence()
                .thenExecute(() -> driveNav(fixture, nav, terminal, 900))
                .thenWaitUntil(() -> assertNavTerminated(terminal, helper, "infeasible pillar"))
                .thenExecute(() -> {
                    nav.core().harness().resetFailureSink();
                    // Bounded failure: must not be ARRIVED, and must end within the budget.
                    helper.assertTrue(terminal.get() == PlayerNav.Status.FAILED,
                            "infeasible pillar unexpectedly arrived");
                    String reason = nav.failReason();
                    helper.assertTrue(reason != null && !reason.isBlank(),
                            "failure produced no explainable reason");
                    helper.assertTrue(receipts.get() > 0,
                            "no failure receipt reached the movement — the failure "
                                    + "did not travel the feedback chain: " + reason);
                    // The failure must be explainable: it names the recurring failed action or failure
                    // code, not a bare "no progress".
                    helper.assertTrue(reason.contains("MovementPillar")
                                    || reason.contains("UNREACHABLE")
                                    || reason.contains("occluded")
                                    || reason.contains("OCCLUDED")
                                    || reason.contains("no_support")
                                    || reason.contains("body_in_target")
                                    || reason.contains("no path"),
                            "failure reason does not name the recurring failure: " + reason);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    /** Ticks the navigation until it is terminal or the budget runs out. An exhausted budget counts as
     * FAILED: boundedness is itself the assertion, so an infeasible case must not retry forever. */
    private static void driveNav(Fixture fixture, PlayerNav nav,
            AtomicReference<PlayerNav.Status> terminal, int budgetTicks) {
        for (int i = 0; i < budgetTicks; i++) {
            RuntimeBotManager.tick(fixture.level().getServer());
            PlayerNav.Status status = nav.tick();
            if (status != PlayerNav.Status.RUNNING) {
                terminal.set(status);
                return;
            }
        }
        terminal.set(PlayerNav.Status.FAILED); // budget exhausted = unbounded, recorded as failure
    }

    private static boolean assertNavTerminated(
            AtomicReference<PlayerNav.Status> terminal, GameTestHelper helper, String label) {
        helper.assertTrue(terminal.get() != null, label + " did not terminate");
        return true;
    }

    private static BlockPos feet(BotPlayer bot) {
        return BlockPos.containing(bot.getX(), Math.floor(bot.getY()), bot.getZ());
    }

    /** Transient entity blockage: a zombie occupies the placement volume at the jump cell and is removed
     * after 100 ticks. The pillar must then complete instead of staying marked unreachable. */
    public static void transient_blockage_recovers_after_clearing(GameTestHelper helper) {
        Fixture fixture = pillarFixture(helper, 45903L, false);
        net.minecraft.world.entity.monster.Zombie blocker =
                net.minecraft.world.entity.EntityType.ZOMBIE.create(fixture.level());
        BlockPos blockerPos = fixture.start().above(1);
        blocker.moveTo(blockerPos.getX() + 0.5, blockerPos.getY(),
                blockerPos.getZ() + 0.5, 0.0F, 0.0F);
        blocker.setNoAi(true);
        fixture.level().addFreshEntity(blocker);
        bindFixture(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<Integer> ticks = new AtomicReference<>(0);

        helper.startSequence()
                .thenExecute(() -> gotoExact(fixture, terminal))
                // Remove the blocker after 100 ticks.
                .thenExecuteAfter(100, blocker::discard)
                .thenWaitUntil(() -> terminated(terminal, helper, "transient blockage"))
                .thenExecute(() -> {
                    helper.assertTrue(result(terminal).get("success").getAsBoolean(),
                            "pillar did not recover after transient blockage cleared: "
                                    + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    // ==================== Drivers and fixtures ====================

    /** Exact-cell goto (x+y+z) through the production goto chain: target two cells up, one pillar step. */
    private static void gotoExact(Fixture fixture, AtomicReference<String> terminal) {
        JsonObject args = new JsonObject();
        JsonObject position = new JsonObject();
        position.addProperty("x", fixture.target().getX());
        position.addProperty("y", fixture.target().getY());
        position.addProperty("z", fixture.target().getZ());
        JsonObject goal = new JsonObject();
        goal.addProperty("kind", "cell");
        goal.add("position", position);
        args.add("goal", goal);
        fixture.tools().call(JsonParser.parseString("\"pillar-feedback\""),
                "goto", args, terminal::set);
    }

    private static boolean terminated(
            AtomicReference<String> terminal, GameTestHelper helper, String label) {
        helper.assertTrue(terminal.get() != null, label + " did not terminate");
        return true;
    }

    private static JsonObject result(AtomicReference<String> terminal) {
        return JsonParser.parseString(terminal.get()).getAsJsonObject();
    }

    /**
     * Pillar fixture: a 5×5 stone platform with open headroom and the target two cells up in the same
     * column (one pillar block at y+1, then stand on it). {@code capped} seals the headroom (infeasible).
     */
    private static Fixture pillarFixture(GameTestHelper helper, long session, boolean capped) {
        return pillarFixture(helper, session, capped, false);
    }

    private static Fixture pillarFixture(GameTestHelper helper, long session,
            boolean capped, boolean obstructed) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos start = helper.absolutePos(new BlockPos(4, 260, 4));
        for (BlockPos position : BlockPos.betweenClosed(
                start.offset(-3, -2, -3), start.offset(3, 8, 3))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        BlockPos target = start.above(2);
        for (BlockPos position : BlockPos.betweenClosed(
                start.below().offset(-2, 0, -2), start.below().offset(2, 0, 2))) {
            level.setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
        }
        if (capped) {
            // The pillar cell y+1 stays empty, so the pillar still executes, but the headroom at y+2 (where
            // the body stands on the pillar, and the head cell of the next jump) is bedrock. The body cannot
            // fit at y+2 after placing, so no placement forms support to the target; it ends after bounded
            // attempts.
            level.setBlockAndUpdate(start.above(2), Blocks.BEDROCK.defaultBlockState());
            level.setBlockAndUpdate(start.above(3), Blocks.BEDROCK.defaultBlockState());
        }
        if (obstructed) {
            // The placement cell y+1 is known non-air (bedrock). The pillar executes, but the Place precheck
            // proves the target is not air (TARGET_NOT_KNOWN_AIR) or unsupported, so it keeps failing and
            // ends after bounded attempts: an infeasible pillar that really goes through the failure chain.
            level.setBlockAndUpdate(start.above(1), Blocks.BEDROCK.defaultBlockState());
        }
        bot.getInventory().clearContent();
        bot.getInventory().setItem(0, new ItemStack(Items.DIRT, SCAFFOLD_COUNT));
        bot.getInventory().selected = 0;
        ScaffoldMaterials.store(bot, List.of("minecraft:dirt"));
        bot.moveTo(start.getX() + 0.5, start.getY(), start.getZ() + 0.5, 0.0F, 0.0F);
        bot.fallDistance = 0.0F;
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, start, target, tools);
    }

    private static void bindFixture(Fixture fixture) {
        RuntimeBotManager.tick(fixture.level().getServer());
        for (BlockPos position : BlockPos.betweenClosed(
                fixture.start().offset(-3, -2, -3), fixture.target().offset(3, 5, 3))) {
            dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.publishBlock(
                    fixture.level().getServer(),
                    fixture.level().dimension().location().toString(),
                    fixture.level().getGameTime(),
                    position,
                    fixture.level().getBlockState(position),
                    BlockEvidenceSource.MISMATCH);
        }
    }

    private static int scaffoldCount(BotPlayer bot) {
        return bot.getInventory().countItem(Items.DIRT);
    }

    private static void cleanup(Fixture fixture) {
        fixture.tools().sessionClosed(Long.MAX_VALUE);
        RuntimeBotManager.stop(fixture.level().getServer());
    }

    private record Fixture(
            ServerLevel level,
            BotPlayer bot,
            BlockPos start,
            BlockPos target,
            DefaultRuntimeToolGateway tools) {}
}
