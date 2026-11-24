package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.agent.tool.api.ToolContext;
import dev.mcagent.runtime.core.task.inventory.UnequipTaskRecord;
import dev.mcagent.runtime.task.TaskRecord;

import net.minecraft.world.entity.EquipmentSlot;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Pins argument routing for the two forms of {@code equip_item}: action=unequip yields an
 * {@link UnequipTaskRecord}. The schema keeps each form's required fields loose (action mode), so the
 * real gate is here and its behavior must be pinned. Pure JVM: only the unequip and rejection paths
 * run, and the item registry is never touched.
 */
class InventoryOpsUnequipTest {

    private final InventoryOps ops = new InventoryOps();
    private final ToolContext ctx = new ToolContext("call-1", 0L);

    @Test
    void armorExpandsToAllFourPieces() {
        TaskRecord rec = ops.equipItem("unequip", null, "armor", ctx);
        UnequipTaskRecord un = assertInstanceOf(UnequipTaskRecord.class, rec);
        assertEquals(List.of(EquipmentSlot.HEAD, EquipmentSlot.CHEST,
                EquipmentSlot.LEGS, EquipmentSlot.FEET), un.slots);
    }

    @Test
    void singleSlotUnequips() {
        UnequipTaskRecord un = assertInstanceOf(UnequipTaskRecord.class,
                ops.equipItem("unequip", null, "mainhand", ctx));
        assertEquals(List.of(EquipmentSlot.MAINHAND), un.slots);
    }

    @Test
    void unequipWithoutSlotIsRefused() {
        assertThrows(IllegalArgumentException.class,
                () -> ops.equipItem("unequip", null, null, ctx));
    }

    @Test
    void equipWithoutItemIsRefused() {
        // A missing action means equip; item_id is optional in the schema, so the gate is here
        assertThrows(IllegalArgumentException.class,
                () -> ops.equipItem(null, null, "head", ctx));
    }

    @Test
    void armorSlotIsUnequipOnly() {
        // Equip has no "armor" target: each armor piece goes to its own slot; the batch form is unequip-only
        assertThrows(IllegalArgumentException.class,
                () -> ops.equipItem(null, "minecraft:iron_helmet", "armor", ctx));
    }
}
