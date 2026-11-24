package dev.mcagent.runtime.core.pathing.bridge;

import dev.mcagent.runtime.core.pathing.cache.EmbodiedNavView;
import dev.mcagent.runtime.core.pathing.cache.ExecutionWorldView;
import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.pathing.execute.RouteMutationPolicy;
import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.util.BlockHelper;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceSnapshot;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.knowledge.EntityKnowledgeSelection;
import dev.mcagent.runtime.knowledge.WorldKnowledge;
import it.unimi.dsi.fastutil.longs.LongSet;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityType;

import java.util.List;

/** Runtime-Bot planning adapter backed exclusively by the selected World Knowledge. */
public final class WorldKnowledgeContextProvider implements PlayerNav.ContextProvider {

    static final int SNAPSHOT_RADIUS_BLOCKS = 128;
    private static final int SPAWNER_CAPTURE_RADIUS_BLOCKS = 16 * 16;
    private static final CanonicalIdentifierGlob SPAWNER =
            CanonicalIdentifierGlob.compile("minecraft:spawner");

    @Override
    public PlayerNav.ContextProvider.BlockSearchPlan planBlockSearch(
            BotPlayer player, BlockPos target, LongSet deniedPlace,
            RouteMutationPolicy routeMutations) {
        Captured captured = capture(player, List.of(target), true);
        EmbodiedNavView exactView = view(player, captured.exactBlocks());
        GoalCompiler.Compiled compiled = GoalCompiler.blockKnowledge(
                captured.exactBlocks().isKnown(target),
                BlockHelper.canWalkThrough(exactView, target), target);
        EmbodiedNavView view = view(player, captured.blocks());
        CalculationContext context = new CalculationContext(
                player, view, (x, z) -> true, true,
                compiled.sacred(), deniedPlace, routeMutations,
                captured.spawners(), captured.entityCenters());
        return new PlayerNav.ContextProvider.BlockSearchPlan(compiled, context);
    }

    @Override
    public CalculationContext forSearch(
            BotPlayer player, LongSet sacred, LongSet deniedPlace,
            RouteMutationPolicy routeMutations) {
        Captured captured = capture(player, List.of(), true);
        EmbodiedNavView view = view(player, captured.blocks());
        return new CalculationContext(player, view, (x, z) -> true, true,
                sacred, deniedPlace, routeMutations,
                captured.spawners(), captured.entityCenters());
    }

    private static EmbodiedNavView view(
            ServerPlayer player, BlockEvidenceSnapshot blocks) {
        return new EmbodiedNavView(
                blocks, player.level().getMinBuildHeight(), player.level().getHeight());
    }

    @Override
    public CalculationContext forExecution(
            BotPlayer player, LongSet sacred, LongSet deniedPlace,
            RouteMutationPolicy routeMutations) {
        Captured captured = capture(player, List.of(), false);
        return new CalculationContext(player, view(player, captured.blocks()),
                (x, z) -> true, false, sacred, deniedPlace,
                routeMutations, captured.spawners(), captured.entityCenters());
    }

    public static ExecutionWorldView executionView(ServerPlayer player) {
        Captured captured = capture(player, List.of(), false);
        String dimension = player.level().dimension().location().toString();
        var fallingBlocks = captured.entities().stream()
                .filter(track -> track.state() == EntityTrack.State.VISIBLE)
                .filter(track -> dimension.equals(track.dimension()))
                .filter(track -> "minecraft:falling_block".equals(track.entityId()))
                .map(track -> EntityType.FALLING_BLOCK.getDimensions().makeBoundingBox(track.position()))
                .toList();
        return new ExecutionWorldView(view(player, captured.blocks()), player.level(),
                player.blockPosition(), fallingBlocks);
    }

    /** Everything one planning or execution step reads, taken at one knowledge revision. */
    private static Captured capture(
            ServerPlayer player, List<BlockPos> exactPositions, boolean includeSpawners) {
        String dimension = player.level().dimension().location().toString();
        BlockPos center = player.blockPosition();
        WorldKnowledge knowledge = RuntimeBotManager.knowledge(player.getServer());
        BlockEvidenceSnapshot blocks = knowledge.blocks().snapshot(
                dimension, center, SNAPSHOT_RADIUS_BLOCKS);
        BlockEvidenceSnapshot exactBlocks = exactPositions.isEmpty() ? null
                : knowledge.blocks().snapshot(dimension, exactPositions.getFirst(), 1);
        List<BlockPos> spawners = !includeSpawners ? List.of()
                : knowledge.blocks().knownWithin(
                                dimension, SPAWNER, center, SPAWNER_CAPTURE_RADIUS_BLOCKS).stream()
                        .map(BlockKnowledge.LocatedCell::position)
                        .toList();
        List<EntityTrack> entities = knowledge.entities();
        return new Captured(blocks, exactBlocks, spawners,
                EntityKnowledgeSelection.avoidanceCenters(entities, dimension), entities);
    }

    private record Captured(
            BlockEvidenceSnapshot blocks,
            BlockEvidenceSnapshot exactBlocks,
            List<BlockPos> spawners,
            List<net.minecraft.world.phys.Vec3> entityCenters,
            List<EntityTrack> entities) {
        private Captured {
            spawners = List.copyOf(spawners);
            entityCenters = List.copyOf(entityCenters);
            entities = List.copyOf(entities);
        }
    }
}
