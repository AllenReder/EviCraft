package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.WorldKnowledgeProfile;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.monster.Slime;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Regression coverage for omitted attack's dynamically admitted target lifecycle. */
@GameTestHolder("mc_agent")
@PrefixGameTestTemplate(false)
public final class AttackTerminalGameTests {

    private AttackTerminalGameTests() {}

    @GameTest(templateNamespace = "mc_agent_attack_terminal", template = "floor16",
            timeoutTicks = 500, batch = "omitted_attack_terminal")
    public static void disappearing_dynamic_target_reaches_a_terminal_status(
            GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        prepareFloor(helper);
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.start(level.getServer(), Map.of(
                WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "loaded_world_state"));
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        BlockPos botPosition = helper.absolutePos(new BlockPos(3, 2, 3));
        bot.teleportTo(level, botPosition.getX() + 0.5, botPosition.getY(),
                botPosition.getZ() + 0.5, java.util.Set.of(), 0.0F, 0.0F);
        bot.getInventory().clearContent();
        bot.getInventory().add(new ItemStack(Items.IRON_SWORD));
        bot.addEffect(new MobEffectInstance(MobEffects.DAMAGE_BOOST, 400, 4, false, false));

        Slime parent = slime(helper, new BlockPos(6, 2, 3));
        parent.setInvulnerable(true);
        AtomicReference<Slime> child = new AtomicReference<>();
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicBoolean childRemovedBeforeCombat = new AtomicBoolean();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(382L);

        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(visible(level, parent.getUUID()),
                        "omitted attack parent did not become VISIBLE"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("uuids", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"attack-terminal\""),
                            "attack", args, terminal::set);
                })
                .thenIdle(2)
                .thenExecute(() -> child.set(slime(helper, new BlockPos(5, 2, 5))))
                .thenWaitUntil(() -> {
                    Slime dynamic = child.get();
                    helper.assertTrue(dynamic != null && visible(level, dynamic.getUUID()),
                            "dynamic omitted-attack target did not become VISIBLE");
                    dynamic.discard();
                    childRemovedBeforeCombat.set(true);
                })
                .thenExecute(() -> {
                    Slime dynamic = child.get();
                    helper.assertTrue(childRemovedBeforeCombat.get() && dynamic.isRemoved(),
                            "dynamic target survived fixture removal");
                })
                .thenWaitUntil(() -> helper.assertTrue(RuntimeKnowledgeFixtures.entity(
                                level.getServer(), child.get().getUUID()).isEmpty(),
                        "disappearing target remained in Entity Knowledge"))
                .thenExecute(() -> {
                    parent.setInvulnerable(false);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "omitted attack remained pending after its dynamic target disappeared"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean(),
                            "omitted attack failed: " + terminal.get());
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(contains(data, "defeated_uuids", parent.getUUID()),
                            "surviving parent was not defeated: " + terminal.get());
                    helper.assertTrue(contains(data, "lost_uuids", child.get().getUUID()),
                            "disappearing dynamically admitted UUID was not settled as lost: "
                                    + terminal.get());
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_attack_restrike", template = "floor16",
            timeoutTicks = 500, batch = "omitted_attack_restrike")
    public static void surviving_omitted_target_is_struck_again_after_dynamic_loss(
            GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        prepareFloor(helper);
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.start(level.getServer(), Map.of(
                WorldKnowledgeProfile.ENVIRONMENT_VARIABLE, "loaded_world_state"));
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        BlockPos botPosition = helper.absolutePos(new BlockPos(3, 2, 3));
        bot.teleportTo(level, botPosition.getX() + 0.5, botPosition.getY(),
                botPosition.getZ() + 0.5, java.util.Set.of(), 0.0F, 0.0F);
        bot.getInventory().clearContent();
        bot.getInventory().add(new ItemStack(Items.DIAMOND_SWORD));

        Slime parent = slime(helper, new BlockPos(6, 2, 3));
        java.util.Objects.requireNonNull(parent.getAttribute(
                net.minecraft.world.entity.ai.attributes.Attributes.MAX_HEALTH))
                .setBaseValue(12.0);
        parent.setHealth(12.0F);
        parent.setInvulnerable(true);
        AtomicReference<Slime> child = new AtomicReference<>();
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicBoolean parentSurvivedFirstHit = new AtomicBoolean();
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(395L);

        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(visible(level, parent.getUUID()),
                        "omitted attack parent did not become VISIBLE"))
                .thenExecute(() -> {
                    JsonObject args = new JsonObject();
                    args.add("uuids", JsonNull.INSTANCE);
                    tools.call(JsonParser.parseString("\"attack-restrike\""),
                            "attack", args, terminal::set);
                })
                .thenIdle(2)
                .thenExecute(() -> child.set(slime(helper, new BlockPos(5, 2, 5))))
                .thenWaitUntil(() -> {
                    Slime dynamic = child.get();
                    helper.assertTrue(dynamic != null && visible(level, dynamic.getUUID()),
                            "dynamic omitted-attack target did not become VISIBLE");
                    dynamic.discard();
                })
                .thenWaitUntil(() -> helper.assertTrue(RuntimeKnowledgeFixtures.entity(
                                level.getServer(), child.get().getUUID()).isEmpty(),
                        "disappearing target remained in Entity Knowledge"))
                .thenExecute(() -> {
                    helper.assertTrue(parent.getHealth() == 12.0F,
                            "parent did not start with reproducible surviving-hit health");
                    parent.setInvulnerable(false);
                })
                .thenWaitUntil(() -> {
                    boolean survived = parent.isAlive() && parent.getHealth() > 0.0F
                            && parent.getHealth() < 12.0F;
                    helper.assertTrue(survived,
                            "parent did not survive the first verified omitted-mode hit");
                    parentSurvivedFirstHit.set(true);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "omitted attack did not restrike its surviving target"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(parentSurvivedFirstHit.get() && result.get("success").getAsBoolean(),
                            "omitted attack failed after parent survived its first hit: " + terminal.get());
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(contains(data, "defeated_uuids", parent.getUUID()),
                            "surviving parent was not defeated: " + terminal.get());
                    helper.assertTrue(contains(data, "lost_uuids", child.get().getUUID()),
                            "disappearing dynamically admitted UUID was not settled as lost: "
                                    + terminal.get());
                    int parentStrikes = data.getAsJsonObject("combat_by_entity")
                            .getAsJsonObject(parent.getUUID().toString())
                            .get("strikes").getAsInt();
                    helper.assertTrue(parentStrikes >= 2,
                            "surviving parent was not verified and struck again: " + terminal.get());
                    RuntimeBotManager.stop(level.getServer());
                })
                .thenSucceed();
    }

    private static Slime slime(GameTestHelper helper, BlockPos relative) {
        ServerLevel level = helper.getLevel();
        Slime slime = EntityType.SLIME.create(level);
        if (slime == null) throw new AssertionError("slime did not spawn");
        BlockPos position = helper.absolutePos(relative);
        slime.setSize(0, true);
        slime.setNoAi(true);
        slime.setInvulnerable(true);
        slime.moveTo(position.getX() + 0.5, position.getY(), position.getZ() + 0.5,
                0.0F, 0.0F);
        level.addFreshEntity(slime);
        return slime;
    }

    private static boolean visible(ServerLevel level, UUID uuid) {
        return RuntimeKnowledgeFixtures.entity(level.getServer(), uuid)
                .map(track -> track.state() == EntityTrack.State.VISIBLE)
                .orElse(false);
    }

    private static boolean contains(JsonObject data, String field, UUID uuid) {
        return data.getAsJsonArray(field).asList().stream()
                .anyMatch(value -> uuid.toString().equals(value.getAsString()));
    }

    private static void prepareFloor(GameTestHelper helper) {
        for (BlockPos position : BlockPos.betweenClosed(
                new BlockPos(0, 1, 0), new BlockPos(15, 1, 15))) {
            helper.getLevel().setBlockAndUpdate(helper.absolutePos(position),
                    Blocks.STONE.defaultBlockState());
        }
    }
}
