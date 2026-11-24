package dev.mcagent.runtime.core;

import dev.mcagent.runtime.agent.tool.ToolRegistry;
import dev.mcagent.runtime.task.TaskFactory;
import dev.mcagent.runtime.core.task.collect.CollectItemsTask;
import dev.mcagent.runtime.core.task.collect.CollectItemsTaskRecord;
import dev.mcagent.runtime.core.task.inventory.DropTask;
import dev.mcagent.runtime.core.task.inventory.DropItemsTaskRecord;
import dev.mcagent.runtime.core.task.inventory.EatTask;
import dev.mcagent.runtime.core.task.inventory.EatItemTaskRecord;
import dev.mcagent.runtime.core.task.inventory.EquipTask;
import dev.mcagent.runtime.core.task.inventory.EquipTaskRecord;
import dev.mcagent.runtime.core.task.inventory.ThrowEyeOfEnderTask;
import dev.mcagent.runtime.core.task.inventory.ThrowEyeOfEnderTaskRecord;
import dev.mcagent.runtime.core.task.inventory.UnequipTaskRecord;
import dev.mcagent.runtime.core.task.combat.AttackTask;
import dev.mcagent.runtime.core.task.combat.AttackTaskRecord;
import dev.mcagent.runtime.core.task.interact.BreakBlockTask;
import dev.mcagent.runtime.core.task.interact.BreakBlockTaskRecord;
import dev.mcagent.runtime.core.task.interact.UseItemTask;
import dev.mcagent.runtime.core.task.interact.UseItemTaskRecord;
import dev.mcagent.runtime.core.task.interact.ActivateBlockTask;
import dev.mcagent.runtime.core.task.interact.ActivateBlockTaskRecord;
import dev.mcagent.runtime.core.task.interact.UseItemOnBlockTask;
import dev.mcagent.runtime.core.task.interact.UseItemOnBlockTaskRecord;
import dev.mcagent.runtime.core.task.interact.PlaceBlockTask;
import dev.mcagent.runtime.core.task.interact.PlaceBlockTaskRecord;
import dev.mcagent.runtime.core.task.interact.InteractEntityTask;
import dev.mcagent.runtime.core.task.interact.InteractEntityTaskRecord;
import dev.mcagent.runtime.core.task.move.MoveToTask;
import dev.mcagent.runtime.core.task.move.MoveToTaskRecord;

/**
 * Loader-agnostic init for the core module — the worked example
 * of how a mod adds tools to the api module. Each loader entry
 * point calls {@link #init()} once (on both sides: a dedicated server runs the
 * task bodies), then registers its own server-tick hooks for the tools that need
 * per-tick server work (scans, the pathfinder caches).
 *
 * <p>Two things plug into the engine here:
 * <ul>
 *   <li>tools — each a {@link dev.mcagent.runtime.agent.tool.RuntimeTool} (raw) and
 *       added to the global {@link ToolRegistry} (order preserved for prompt
 *       caching);</li>
 *   <li>task runners — each {@code TaskRecord} type a world-action tool emits is
 *       paired with the {@code Task} that runs it, via
 *       {@link TaskFactory#register}.</li>
 * </ul>
 */
public final class RuntimeCore {

    private static boolean initialised = false;

    private RuntimeCore() {}

    public static void init() {
        if (initialised) return;
        initialised = true;
        registerTools();
        registerTaskRunners();
        Constants.LOG.info("[mc_agent-core] registered {} tool(s), {} task type(s); autonomous chains disabled",
                ToolRegistry.size(), TaskFactory.size());
    }

    private static void registerTools() {
        // Only Tools whose public semantics match the Baseline Runtime Profile are registered.
        // Hidden-world and disabled Tools never enter the callable registry.
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.perception.GetSelfStatusTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.perception.GetWorldInfoTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.perception.ManageScaffoldMaterialsTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.work.MoveToTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.GotoBlockInteractionPoseTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.GotoBlockPlacementPoseTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.BreakBlockTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.UseItemTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.ActivateBlockTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.UseItemOnBlockTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.PlaceBlockTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.EnterBedTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.InteractEntityTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.work.CollectItemsTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.work.AttackTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.InspectGuiTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.MenuButtonTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.interact.CloseGuiTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.inventory.EquipItemTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.inventory.EatItemTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.inventory.DropItemsTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.inventory.TransferTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.inventory.LookupRegistryTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.inventory.LookupRecipeTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.inventory.CraftTool());
        ToolRegistry.register(new dev.mcagent.runtime.core.tools.inventory.ThrowEyeOfEnderTool());
    }


    private static void registerTaskRunners() {
        TaskFactory.register(MoveToTaskRecord.class, (p, r) -> new MoveToTask(p, r));
        TaskFactory.register(dev.mcagent.runtime.core.task.interact.GotoBlockInteractionPoseTaskRecord.class,
                (p, r) -> new dev.mcagent.runtime.core.task.interact.GotoBlockInteractionPoseTask(p, r));
        TaskFactory.register(dev.mcagent.runtime.core.task.interact.GotoBlockPlacementPoseTaskRecord.class,
                (p, r) -> new dev.mcagent.runtime.core.task.interact.GotoBlockPlacementPoseTask(p, r));
        TaskFactory.register(EquipTaskRecord.class, (p, r) -> new EquipTask(p, r));
        TaskFactory.register(UnequipTaskRecord.class,
                (p, r) -> new dev.mcagent.runtime.core.task.inventory.UnequipTask(p, r));
        TaskFactory.register(DropItemsTaskRecord.class, (p, r) -> new DropTask(p, r));
        TaskFactory.register(EatItemTaskRecord.class, (p, r) -> new EatTask(p, r));
        TaskFactory.register(ThrowEyeOfEnderTaskRecord.class,
                (p, r) -> new ThrowEyeOfEnderTask(p, r));
        TaskFactory.register(AttackTaskRecord.class, (p, r) -> new AttackTask(p, r));
        TaskFactory.register(CollectItemsTaskRecord.class, (p, r) -> new CollectItemsTask(p, r));
        TaskFactory.register(BreakBlockTaskRecord.class, (p, r) -> new BreakBlockTask(p, r));
        TaskFactory.register(UseItemTaskRecord.class, (p, r) -> new UseItemTask(p, r));
        TaskFactory.register(ActivateBlockTaskRecord.class, (p, r) -> new ActivateBlockTask(p, r));
        TaskFactory.register(UseItemOnBlockTaskRecord.class, (p, r) -> new UseItemOnBlockTask(p, r));
        TaskFactory.register(PlaceBlockTaskRecord.class, (p, r) -> new PlaceBlockTask(p, r));
        TaskFactory.register(InteractEntityTaskRecord.class, (p, r) -> new InteractEntityTask(p, r));
    }
}
