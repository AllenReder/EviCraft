package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.core.task.collect.CollectItemsTask;
import dev.mcagent.runtime.core.task.collect.CollectItemsTaskRecord;
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/** Native playerTouch plus the production task lifecycle/result, without navigation timing. */
@GameTestHolder("mc_agent_collect_pickup")
@PrefixGameTestTemplate(false)
public final class CollectItemsPickupGameTests {
    @GameTest(templateNamespace = "mc_agent_collect_pickup", template = "floor16", timeoutTicks = 100)
    public static void native_pickups_count_only_this_collection(GameTestHelper helper) {
        var server = helper.getLevel().getServer();
        RuntimeBotManager.stop(server);
        RuntimeBotManager.start(server, Map.of());
        RuntimeBotManager.create(server, "bot");
        BotPlayer bot = RuntimeBotManager.current(server).orElseThrow();
        BlockPos position = helper.absolutePos(new BlockPos(3, 2, 3));
        bot.teleportTo(helper.getLevel(), position.getX() + 0.5, position.getY(),
                position.getZ() + 0.5, Set.of(), 0, 0);
        try {
            bot.getInventory().clearContent();
            for (int slot = 0; slot < 36; slot++) {
                bot.getInventory().setItem(slot, new ItemStack(Items.DIAMOND_SWORD));
            }
            bot.getInventory().setItem(0, new ItemStack(Items.DIAMOND, 60));
            bot.getInventory().offhand.set(0, new ItemStack(Items.DIAMOND_SWORD));
            ItemEntity partial = drop(bot, 5);
            CollectItemsTask first = collect(bot, partial);
            partial.playerTouch(bot);
            helper.assertTrue(partial.getItem().getCount() == 1
                            && bot.getInventory().getItem(0).getCount() == 64,
                    "fixture must perform a real 4/5 native pickup");
            var cancelled = first.result(TaskState.CANCELLED);
            helper.assertTrue(cancelled.interrupted(), "cancellation must remain interrupted");
            helper.assertTrue(Integer.valueOf(4).equals(cancelled.data().get("collected_items")),
                    "partial pickup before cancellation must report 4: " + cancelled);
            helper.assertTrue(Integer.valueOf(0).equals(cancelled.data().get("collected_entities")),
                    "partial pickup must not mark the whole entity collected");
            helper.assertTrue(first.result(TaskState.CANCELLED).data().equals(cancelled.data()),
                    "repeated settlement must not double count");

            // Four units already picked up belong to the previous action.
            CollectItemsTask second = collect(bot, partial);
            bot.getInventory().clearContent();
            partial.playerTouch(bot);
            helper.assertTrue(second.tick(bot) == TaskState.SUCCESS, "remaining item must settle");
            var completed = second.result(TaskState.SUCCESS);
            helper.assertTrue(Integer.valueOf(1).equals(completed.data().get("collected_items"))
                            && Integer.valueOf(1).equals(completed.data().get("collected_entities")),
                    "new collection must report only the remaining 1: " + completed);

            ItemEntity a = drop(bot, 2);
            ItemEntity b = drop(bot, 3);
            ItemEntity unrelated = drop(bot, 7);
            CollectItemsTask batch = collect(bot, a, b);
            a.playerTouch(bot);
            b.playerTouch(bot);
            unrelated.playerTouch(bot);
            helper.assertTrue(batch.tick(bot) == TaskState.SUCCESS, "both exact targets must settle");
            var batchResult = batch.result(TaskState.SUCCESS);
            helper.assertTrue(Integer.valueOf(5).equals(batchResult.data().get("collected_items"))
                            && Integer.valueOf(2).equals(batchResult.data().get("collected_entities")),
                    "same-tick targets must exclude unrelated pickup: " + batchResult);

            ItemEntity lost = drop(bot, 5);
            CollectItemsTask missing = collect(bot, lost);
            lost.discard();
            drop(bot, 5).playerTouch(bot);
            missing.tick(bot);
            var missingResult = missing.result(TaskState.TIMEOUT);
            helper.assertTrue(Integer.valueOf(0).equals(missingResult.data().get("collected_items")),
                    "disappearance plus unrelated inventory increase is not collection: " + missingResult);
        } finally {
            RuntimeBotManager.stop(server);
        }
        helper.succeed();
    }

    private static ItemEntity drop(BotPlayer bot, int count) {
        ItemEntity item = new ItemEntity(bot.level(), bot.getX(), bot.getY(), bot.getZ(),
                new ItemStack(Items.DIAMOND, count));
        item.setNoPickUpDelay();
        bot.level().addFreshEntity(item);
        PhysicalVerificationAuthority.publishItemDrop(bot, item);
        return item;
    }

    private static CollectItemsTask collect(BotPlayer bot, ItemEntity... items) {
        var record = new CollectItemsTaskRecord("pickup-regression", Long.MAX_VALUE,
                Arrays.stream(items).map(ItemEntity::getUUID).collect(Collectors.toSet()),
                null, "", "uuids", 8);
        var task = new CollectItemsTask(bot, record);
        task.start(bot);
        if (record.getState() == TaskState.FAILED) throw new AssertionError(task.result(TaskState.FAILED));
        return task;
    }
}
