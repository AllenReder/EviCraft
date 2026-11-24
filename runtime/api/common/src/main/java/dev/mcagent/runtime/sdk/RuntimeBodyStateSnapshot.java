package dev.mcagent.runtime.sdk;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;

import java.util.ArrayList;
import java.util.List;

/** Complete factual body state shared by Runtime queries and Occurrences. */
public record RuntimeBodyStateSnapshot(
        float health,
        float maxHealth,
        int air,
        int maxAir,
        boolean underwater,
        boolean inLava,
        boolean onFire,
        boolean suffocating,
        List<BlockPosition> intersectingBlocks
) {

    public RuntimeBodyStateSnapshot {
        intersectingBlocks = List.copyOf(intersectingBlocks);
    }

    public static RuntimeBodyStateSnapshot capture(BotPlayer body) {
        Intersection intersection = intersection(body);
        return new RuntimeBodyStateSnapshot(
                body.getHealth(),
                body.getMaxHealth(),
                body.getAirSupply(),
                body.getMaxAirSupply(),
                body.isUnderWater(),
                body.isInLava(),
                body.isOnFire(),
                intersection.suffocating(),
                intersection.suffocating() ? intersection.blocks() : List.of()
        );
    }

    public JsonObject toJson() {
        JsonObject data = new JsonObject();
        data.addProperty("health", health);
        data.addProperty("max_health", maxHealth);
        data.addProperty("air", air);
        data.addProperty("max_air", maxAir);
        data.addProperty("underwater", underwater);
        data.addProperty("in_lava", inLava);
        data.addProperty("on_fire", onFire);
        data.addProperty("suffocating", suffocating);
        JsonArray blocks = new JsonArray();
        for (BlockPosition block : intersectingBlocks) blocks.add(block.toJson());
        data.add("intersecting_blocks", blocks);
        return data;
    }

    public boolean differsOnlyInHealthOrAir(RuntimeBodyStateSnapshot other) {
        return maxHealth == other.maxHealth
                && maxAir == other.maxAir
                && underwater == other.underwater
                && inLava == other.inLava
                && onFire == other.onFire
                && suffocating == other.suffocating
                && intersectingBlocks.equals(other.intersectingBlocks);
    }

    private static Intersection intersection(BotPlayer body) {
        AABB bounds = body.getBoundingBox();
        List<BlockPosition> positions = new ArrayList<>();
        boolean[] suffocating = {false};
        BlockPos.betweenClosedStream(
                BlockPos.containing(bounds.minX, bounds.minY, bounds.minZ),
                BlockPos.containing(bounds.maxX, bounds.maxY, bounds.maxZ)
        ).forEach(position -> {
            var state = body.level().getBlockState(position);
            boolean intersects = state.getCollisionShape(body.level(), position)
                    .toAabbs().stream()
                    .map(shape -> shape.move(position.getX(), position.getY(), position.getZ()))
                    .anyMatch(bounds::intersects);
            if (!intersects) return;
            positions.add(BlockPosition.from(position));
            suffocating[0] |= state.isSuffocating(body.level(), position);
        });
        return new Intersection(suffocating[0], positions);
    }

    private record Intersection(boolean suffocating, List<BlockPosition> blocks) {}

    public record BlockPosition(int x, int y, int z) {
        static BlockPosition from(BlockPos position) {
            return new BlockPosition(position.getX(), position.getY(), position.getZ());
        }

        JsonObject toJson() {
            JsonObject json = new JsonObject();
            json.addProperty("x", x);
            json.addProperty("y", y);
            json.addProperty("z", z);
            return json;
        }
    }
}
