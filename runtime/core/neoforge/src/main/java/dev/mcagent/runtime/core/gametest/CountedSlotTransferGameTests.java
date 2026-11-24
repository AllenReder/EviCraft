package dev.mcagent.runtime.core.gametest;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.tools.ContainerOps;
import dev.mcagent.runtime.entity.BotFactory;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.StructureUtils;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.AbstractFurnaceBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.FurnaceBlockEntity;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.List;
import java.util.UUID;

@GameTestHolder(Constants.MOD_ID)
@PrefixGameTestTemplate(false)
public final class CountedSlotTransferGameTests {

    static {
        String dir = System.getProperty("mc_agent.gametest.structures");
        if (dir != null) StructureUtils.testStructuresDir = dir;
    }

    private CountedSlotTransferGameTests() {}

    @GameTest(templateNamespace = "mc_agent_startup", template = "floor16",
            timeoutTicks = 200, batch = "counted_slot_transfer")
    public static void receipts_prove_immediately_consumed_furnace_fuel(GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        BlockPos furnacePos = helper.absolutePos(new BlockPos(3, 2, 2));
        level.setBlockAndUpdate(furnacePos, Blocks.FURNACE.defaultBlockState());
        FurnaceBlockEntity furnace = (FurnaceBlockEntity) level.getBlockEntity(furnacePos);
        helper.assertTrue(furnace != null, "furnace block entity was not created");
        furnace.setItem(0, new ItemStack(Items.RAW_IRON, 1));

        BlockPos at = helper.absolutePos(new BlockPos(2, 2, 2));
        dev.mcagent.runtime.bot.RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = dev.mcagent.runtime.bot.RuntimeBotManager.current(level.getServer())
                .orElseThrow();
        bot.teleportTo(level, at.getX() + 0.5, at.getY(), at.getZ() + 0.5,
                java.util.Set.of(), bot.getYRot(), bot.getXRot());
        bot.getFoodData().setFoodLevel(20);
        bot.getInventory().setItem(0, new ItemStack(Items.COAL, 2));
        bot.getInventory().setItem(1, new ItemStack(Items.IRON_INGOT, 1));
        bot.openMenu(furnace);

        int menuId = bot.containerMenu.containerId;
        int beforeRevision = bot.containerMenu.getStateId();
        JsonObject accepted = JsonParser.parseString(new ContainerOps().transfer(
                menuId, beforeRevision,
                List.of(new ContainerOps.Move(30, 1, 1)), bot)).getAsJsonObject();
        JsonObject acceptedData = accepted.getAsJsonObject("data");
        JsonObject acceptedMove = acceptedData.getAsJsonArray("moves").get(0).getAsJsonObject();

        helper.assertTrue(accepted.get("success").getAsBoolean(),
                "accepted fuel transfer did not return Runtime success");
        helper.assertTrue(acceptedData.get("menu_id").getAsInt() == menuId
                        && acceptedData.get("before_revision").getAsInt() == beforeRevision
                        && acceptedData.get("after_revision").getAsInt() > beforeRevision,
                "accepted fuel receipt was not bound to the Menu revision");
        helper.assertTrue(acceptedMove.get("item_id").getAsString().equals("minecraft:coal")
                        && acceptedMove.get("requested_count").getAsInt() == 1
                        && acceptedMove.get("moved_count").getAsInt() == 1
                        && acceptedMove.get("outcome").getAsString().equals("moved"),
                "accepted fuel receipt did not prove one exact coal move");

        JsonObject changedMenu = JsonParser.parseString(new ContainerOps().transfer(
                menuId, beforeRevision,
                List.of(new ContainerOps.Move(31, 1, 1)), bot)).getAsJsonObject();
        helper.assertTrue(!changedMenu.get("success").getAsBoolean()
                        && "menu_changed".equals(changedMenu.get("failure_type").getAsString()),
                "stale Menu revision did not fail before another transfer");
        helper.assertTrue(bot.getInventory().getItem(1).is(Items.IRON_INGOT)
                        && bot.getInventory().getItem(1).getCount() == 1,
                "stale Menu revision changed Inventory accounting");

        helper.runAfterDelay(2, () -> {
            helper.assertTrue(furnace.getItem(1).isEmpty()
                            && furnace.getBlockState().getValue(AbstractFurnaceBlock.LIT),
                    "furnace did not immediately consume the accepted fuel");
            helper.assertTrue(bot.getInventory().getItem(0).is(Items.COAL)
                            && bot.getInventory().getItem(0).getCount() == 1,
                    "accepted fuel move changed Inventory by other than one coal");
            helper.assertTrue(furnace.getItem(0).is(Items.RAW_IRON)
                            && furnace.getItem(0).getCount() == 1,
                    "fuel verification changed furnace input accounting");

            int rejectedRevision = bot.containerMenu.getStateId();
            JsonObject rejected = JsonParser.parseString(new ContainerOps().transfer(
                    menuId, rejectedRevision,
                    List.of(new ContainerOps.Move(31, 1, 1)), bot)).getAsJsonObject();
            JsonObject rejectedMove = rejected.getAsJsonObject("data")
                    .getAsJsonArray("moves").get(0).getAsJsonObject();
            helper.assertTrue(rejectedMove.get("item_id").getAsString().equals("minecraft:iron_ingot")
                            && rejectedMove.get("requested_count").getAsInt() == 1
                            && rejectedMove.get("moved_count").getAsInt() == 0
                            && rejectedMove.get("outcome").getAsString().equals("rejected"),
                    "invalid fuel receipt did not distinguish rejection");
            helper.assertTrue(bot.getInventory().getItem(1).is(Items.IRON_INGOT)
                            && bot.getInventory().getItem(1).getCount() == 1,
                    "rejected fuel changed Inventory accounting");
            helper.assertTrue(furnace.getItem(1).isEmpty()
                            && bot.containerMenu.getCarried().isEmpty(),
                    "fuel transfers changed Menu accounting or cursor state");

            bot.closeContainer();
            dev.mcagent.runtime.bot.RuntimeBotManager.stop(level.getServer());
            helper.succeed();
        });
    }
}
