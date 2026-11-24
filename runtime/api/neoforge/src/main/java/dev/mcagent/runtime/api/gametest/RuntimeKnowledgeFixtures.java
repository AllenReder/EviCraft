package dev.mcagent.runtime.api.gametest;

import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockObservation;
import dev.mcagent.runtime.evidence.EntityObservation;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** GameTest-only access to World Knowledge fixtures; not part of the common Runtime API. */
public final class RuntimeKnowledgeFixtures {

    private RuntimeKnowledgeFixtures() {}

    public static BlockEvidenceCell block(
            MinecraftServer server, String dimension, BlockPos position) {
        return RuntimeBotManager.knowledge(server).blocks().cell(dimension, position);
    }

    public static Optional<EntityTrack> entity(MinecraftServer server, UUID uuid) {
        return RuntimeBotManager.knowledge(server).entity(uuid);
    }

    public static void publishBlock(
            MinecraftServer server, String dimension, long observedTick,
            BlockPos position, BlockState state, BlockEvidenceSource source) {
        RuntimeBotManager.publishAttributable(server, new AttributableWorldUpdate(List.of(
                new AttributableWorldUpdate.BlockFact(dimension, observedTick,
                        BlockObservation.of(position, state, source))),
                List.of(), List.of()));
    }

    public static void publishEntity(
            MinecraftServer server, String dimension, long observedTick,
            UUID uuid, String entityId, Vec3 position) {
        RuntimeBotManager.publishAttributable(server, new AttributableWorldUpdate(List.of(), List.of(
                new AttributableWorldUpdate.EntityFact(dimension, observedTick,
                        EntityObservation.attributable(uuid, entityId, null, null,
                                position, null, null))), List.of()));
    }
}
