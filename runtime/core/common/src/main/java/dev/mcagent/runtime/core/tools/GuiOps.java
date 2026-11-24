package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskResult;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AbstractFurnaceMenu;
import net.minecraft.world.inventory.CraftingContainer;
import net.minecraft.world.inventory.DataSlot;
import net.minecraft.world.inventory.FurnaceFuelSlot;
import net.minecraft.world.inventory.FurnaceResultSlot;
import net.minecraft.world.inventory.ResultSlot;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

import java.util.List;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;

/** Implementation of the menu tools: read the open menu, press one of its buttons, close it. */
public final class GuiOps {

    public String inspectGui(BotPlayer self) {
        AbstractContainerMenu menu = self.containerMenu;
        if (menu == null) {
            return TaskResult.fail("no menu is open", "menu_not_open").toJson();
        }
        // With no block menu open the Bot's own inventory menu is current; it carries the 2x2 grid.
        boolean ownInventory = menu == self.inventoryMenu;
        boolean furnace = menu instanceof AbstractFurnaceMenu;
        List<Map<String, Object>> slots = new ArrayList<>();
        int gridWidth = 0, gridHeight = 0, resultIndex = -1;
        for (int i = 0; i < menu.slots.size(); i++) {
            Slot slot = menu.slots.get(i);
            boolean playerSide = slot.container == self.getInventory();
            ItemStack stack = slot.getItem();
            if (slot instanceof ResultSlot) resultIndex = slot.index;
            if (slot.container instanceof CraftingContainer grid) {
                gridWidth = grid.getWidth();
                gridHeight = grid.getHeight();
            }
            // Output-only = a non-empty menu slot that will not take its own item back.
            boolean output = !playerSide && !stack.isEmpty() && !slot.mayPlace(stack);
            Map<String, Object> projection = new LinkedHashMap<>();
            projection.put("index", i);
            projection.put("owner", playerSide ? "player" : "menu");
            projection.put("role", role(slot, playerSide, furnace));
            projection.put("container_slot", slot.getContainerSlot());
            projection.put("item_id", stack.isEmpty()
                    ? null : BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
            projection.put("count", stack.isEmpty() ? 0 : stack.getCount());
            projection.put("output", output || slot instanceof ResultSlot);
            projection.put("max_stack_size", stack.isEmpty()
                    ? slot.getMaxStackSize() : slot.getMaxStackSize(stack));
            slots.add(projection);
        }
        // The menu's synced integers, as a screen reads them for progress bars; their meaning
        // belongs to the menu type (a furnace: lit time, lit duration, cook progress, cook total).
        List<Integer> dataValues = new ArrayList<>();
        List<DataSlot> data = ((dev.mcagent.runtime.entity.mixin.MenuDataSlotsAccessor) (Object) menu).mc_agent$dataSlots();
        for (DataSlot value : data) dataValues.add(value.get());

        ItemStack cursor = menu.getCarried();
        Map<String, Object> cursorData = new LinkedHashMap<>();
        cursorData.put("item_id", cursor.isEmpty()
                ? null : BuiltInRegistries.ITEM.getKey(cursor.getItem()).toString());
        cursorData.put("count", cursor.isEmpty() ? 0 : cursor.getCount());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("menu_type", ownInventory
                ? null : String.valueOf(BuiltInRegistries.MENU.getKey(menu.getType())));
        result.put("menu_id", menu.containerId);
        result.put("menu_revision", menu.getStateId());
        result.put("own_inventory", ownInventory);
        result.put("slots", slots);
        result.put("cursor", cursorData);
        result.put("data_values", dataValues);
        if (gridWidth > 0) {
            result.put("crafting", Map.of(
                    "width", gridWidth,
                    "height", gridHeight,
                    "result_slot", resultIndex));
        }
        return TaskResult.ok("open menu", result).toJson();
    }

    /** What a slot is for, so a caller need not know each menu's slot numbering. */
    private static String role(Slot slot, boolean playerSide, boolean furnace) {
        if (playerSide) {
            int index = slot.getContainerSlot();
            if (index < 9) return "hotbar";
            if (index < 36) return "inventory";
            return index < 40 ? "armor" : "offhand";
        }
        if (slot instanceof ResultSlot) return "crafting_result";
        if (slot.container instanceof CraftingContainer) return "crafting_grid";
        if (slot instanceof FurnaceResultSlot) return "output";
        if (slot instanceof FurnaceFuelSlot) return "fuel";
        return furnace ? "input" : "container";
    }

    /** Presses one of the open block menu's buttons, as a click on the screen would. */
    public String menuButton(int expectedMenuId, int expectedMenuRevision, int button, BotPlayer self) {
        AbstractContainerMenu menu = self.containerMenu;
        if (menu == null || menu == self.inventoryMenu) {
            return TaskResult.fail("no block menu is open", "menu_not_open").toJson();
        }
        Map<String, Object> identity = Map.of(
                "menu_id", menu.containerId, "menu_revision", menu.getStateId());
        if (menu.containerId != expectedMenuId || menu.getStateId() != expectedMenuRevision) {
            return TaskResult.fail("the open menu changed since inspect_gui", "menu_changed", identity).toJson();
        }
        if (!menu.stillValid(self) || !menu.clickMenuButton(self, button)) {
            return TaskResult.fail("the open menu did not accept button " + button, "no_effect", identity).toJson();
        }
        menu.broadcastChanges();
        menu.incrementStateId();
        return TaskResult.ok("pressed menu button " + button, Map.of(
                "menu_id", menu.containerId,
                "before_revision", expectedMenuRevision,
                "after_revision", menu.getStateId())).toJson();
    }

    public String closeGui(BotPlayer self) {
        AbstractContainerMenu menu = self.containerMenu;
        if (menu == null || menu == self.inventoryMenu) {
            return TaskResult.ok("no block menu was open").toJson();
        }
        self.closeContainer();
        return TaskResult.ok("closed the menu").toJson();
    }
}
