package dev.mcagent.runtime.sdk;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import net.minecraft.core.BlockPos;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/** JSON codec and typed validation boundary for bounded knowledge.query operations. */
final class RuntimeKnowledgeRpcHandler {

    private final RuntimeEvidenceGateway evidence;

    RuntimeKnowledgeRpcHandler(RuntimeEvidenceGateway evidence) {
        this.evidence = Objects.requireNonNull(evidence, "evidence");
    }

    JsonObject handle(JsonElement id, JsonElement paramsElement) {
        if (id.isJsonNull() || paramsElement == null || !paramsElement.isJsonObject()) {
            return invalid(id);
        }
        JsonObject params = paramsElement.getAsJsonObject();
        JsonElement operation = params.get("operation");
        if (!isString(operation)) return invalid(id);
        return switch (operation.getAsString()) {
            case "block.get" -> blockGet(id, params);
            case "block.find" -> blockFind(id, params);
            case "block.region" -> blockRegion(id, params);
            case "entity.get" -> entityGet(id, params);
            case "entity.list" -> entityList(id, params);
            default -> invalid(id);
        };
    }

    private JsonObject blockGet(JsonElement id, JsonObject params) {
        JsonElement dimension = params.get("dimension");
        JsonElement positionsElement = params.get("positions");
        if (!validDimension(dimension)
                || positionsElement == null || !positionsElement.isJsonArray()
                || positionsElement.getAsJsonArray().isEmpty()
                || positionsElement.getAsJsonArray().size() > 256) {
            return invalid(id);
        }
        List<RuntimeBlockPosition> positions = new ArrayList<>();
        try {
            for (JsonElement element : positionsElement.getAsJsonArray()) {
                positions.add(exactPosition(element));
            }
        } catch (ArithmeticException | IllegalArgumentException | IllegalStateException exception) {
            return invalid(id);
        }
        try {
            JsonArray cells = new JsonArray();
            evidence.blockGet(dimension.getAsString(), positions)
                    .forEach(cell -> cells.add(blockEvidence(cell)));
            JsonObject result = new JsonObject();
            result.addProperty("operation", "block.get");
            result.add("cells", cells);
            return RuntimeRpcDispatcher.success(id, result);
        } catch (RuntimeException exception) {
            return internal(id);
        }
    }

    private JsonObject blockFind(JsonElement id, JsonObject params) {
        JsonElement dimension = params.get("dimension");
        JsonElement glob = params.get("block_id_glob");
        if (!validDimension(dimension)) return invalid(id);
        final CanonicalIdentifierGlob selector;
        final RuntimeBlockPosition origin;
        final int limit;
        try {
            selector = requiredGlob(glob);
            JsonElement originElement = params.get("origin");
            origin = originElement == null ? null : exactPosition(originElement);
            JsonElement limitElement = params.get("limit");
            limit = limitElement == null
                    ? BlockKnowledge.MAX_FIND_RESULTS : exactInt(limitElement);
            if (limit < 1 || limit > BlockKnowledge.MAX_FIND_RESULTS) {
                return invalid(id);
            }
        } catch (ArithmeticException | IllegalArgumentException | IllegalStateException exception) {
            return invalid(id);
        }
        try {
            RuntimeBlockFindResult found = evidence.blockFind(
                    dimension.getAsString(), selector, origin, limit);
            JsonArray matches = new JsonArray();
            found.matches().forEach(cell -> matches.add(blockEvidence(cell)));
            JsonObject result = new JsonObject();
            result.addProperty("operation", "block.find");
            result.add("matches", matches);
            result.addProperty("has_more", found.hasMore());
            result.addProperty("complete", found.complete());
            return RuntimeRpcDispatcher.success(id, result);
        } catch (RuntimeException exception) {
            return internal(id);
        }
    }

    private JsonObject blockRegion(JsonElement id, JsonObject params) {
        JsonElement dimension = params.get("dimension");
        if (!validDimension(dimension)) return invalid(id);
        final BlockKnowledge.RegionBounds bounds;
        try {
            RuntimeBlockPosition min = exactPosition(params.get("min"));
            RuntimeBlockPosition max = exactPosition(params.get("max"));
            bounds = BlockKnowledge.RegionBounds.between(blockPos(min), blockPos(max));
        } catch (ArithmeticException | IllegalArgumentException | IllegalStateException exception) {
            return invalid(id);
        }
        try {
            RuntimeBlockRegionResult region = evidence.blockRegion(
                    dimension.getAsString(), bounds);
            JsonObject result = new JsonObject();
            result.addProperty("operation", "block.region");
            result.addProperty("dimension", region.dimension());
            result.add("min", position(region.min()));
            result.add("size", position(region.size()));
            JsonArray palette = new JsonArray();
            region.palette().forEach(entry -> palette.add(blockPalette(entry)));
            result.add("palette", palette);
            JsonArray indices = new JsonArray();
            region.indices().forEach(indices::add);
            result.add("indices", indices);
            result.addProperty("complete", region.complete());
            return RuntimeRpcDispatcher.success(id, result);
        } catch (RuntimeException exception) {
            return internal(id);
        }
    }

    private JsonObject entityGet(JsonElement id, JsonObject params) {
        JsonElement uuidElement = params.get("uuid");
        if (!isString(uuidElement)) return invalid(id);
        final UUID uuid;
        try {
            uuid = UUID.fromString(uuidElement.getAsString());
        } catch (IllegalArgumentException exception) {
            return invalid(id);
        }
        try {
            JsonObject result = new JsonObject();
            result.addProperty("operation", "entity.get");
            result.add("track", evidence.entityGet(uuid)
                    .<JsonElement>map(RuntimeKnowledgeRpcHandler::entityTrack)
                    .orElse(com.google.gson.JsonNull.INSTANCE));
            return RuntimeRpcDispatcher.success(id, result);
        } catch (RuntimeException exception) {
            return internal(id);
        }
    }

    private JsonObject entityList(JsonElement id, JsonObject params) {
        JsonElement dimensionElement = params.get("dimension");
        if (dimensionElement != null && !validDimension(dimensionElement)) return invalid(id);
        final CanonicalIdentifierGlob entitySelector;
        final CanonicalIdentifierGlob itemSelector;
        try {
            entitySelector = optionalGlob(params.get("entity_id_glob"));
            itemSelector = optionalGlob(params.get("item_id_glob"));
        } catch (IllegalArgumentException exception) {
            return invalid(id);
        }
        try {
            String dimension = dimensionElement == null ? null : dimensionElement.getAsString();
            RuntimeEntityListResult listed = evidence.entityList(
                    dimension, entitySelector, itemSelector);
            JsonArray tracks = new JsonArray();
            listed.tracks().forEach(track -> tracks.add(entityTrack(track)));
            JsonObject result = new JsonObject();
            result.addProperty("operation", "entity.list");
            result.add("tracks", tracks);
            result.addProperty("has_more", listed.hasMore());
            return RuntimeRpcDispatcher.success(id, result);
        } catch (RuntimeException exception) {
            return internal(id);
        }
    }

    private static JsonObject blockEvidence(RuntimeBlockEvidence cell) {
        JsonObject result = new JsonObject();
        result.addProperty("dimension", cell.dimension());
        result.add("position", position(cell.position()));
        result.addProperty("state", cell.state().name());
        if (cell.blockState() != null) result.addProperty("block_state", cell.blockState());
        if (cell.fluid() != null) result.addProperty("fluid", cell.fluid());
        if (cell.source() != null) result.addProperty("source", cell.source());
        if (cell.observedTick() != null) result.addProperty("observed_tick", cell.observedTick());
        if (cell.observationRevision() != null) {
            result.addProperty("observation_revision", cell.observationRevision());
        }
        return result;
    }

    private static JsonObject blockPalette(RuntimeBlockPaletteEntry entry) {
        JsonObject result = new JsonObject();
        result.addProperty("state", entry.state().name());
        if (entry.blockState() != null) result.addProperty("block_state", entry.blockState());
        if (entry.fluid() != null) result.addProperty("fluid", entry.fluid());
        if (entry.source() != null) result.addProperty("source", entry.source());
        if (entry.observedTick() != null) result.addProperty("observed_tick", entry.observedTick());
        if (entry.observationRevision() != null) {
            result.addProperty("observation_revision", entry.observationRevision());
        }
        return result;
    }

    private static JsonObject entityTrack(RuntimeEntityTrack track) {
        JsonObject result = new JsonObject();
        result.addProperty("uuid", track.uuid().toString());
        result.addProperty("dimension", track.dimension());
        result.addProperty("entity_id", track.entityId());
        if (track.itemId() != null) {
            result.addProperty("item_id", track.itemId());
            result.addProperty("item_count", track.itemCount());
        }
        JsonObject position = new JsonObject();
        position.addProperty("x", track.position().x());
        position.addProperty("y", track.position().y());
        position.addProperty("z", track.position().z());
        result.add("position", position);
        result.addProperty("state", track.state().name());
        result.addProperty("source", track.source());
        result.addProperty("observed_tick", track.observedTick());
        result.addProperty("observation_revision", track.observationRevision());
        return result;
    }

    private static CanonicalIdentifierGlob requiredGlob(JsonElement glob) {
        CanonicalIdentifierGlob selector = optionalGlob(glob);
        if (selector == null) throw new IllegalArgumentException();
        return selector;
    }

    private static CanonicalIdentifierGlob optionalGlob(JsonElement glob) {
        if (glob != null) {
            if (!isString(glob)) throw new IllegalArgumentException();
            return CanonicalIdentifierGlob.compile(glob.getAsString());
        }
        return null;
    }

    private static JsonObject position(RuntimeBlockPosition value) {
        JsonObject result = new JsonObject();
        result.addProperty("x", value.x());
        result.addProperty("y", value.y());
        result.addProperty("z", value.z());
        return result;
    }

    private static RuntimeBlockPosition exactPosition(JsonElement element) {
        if (element == null || !element.isJsonObject()) throw new IllegalArgumentException();
        JsonObject position = element.getAsJsonObject();
        return new RuntimeBlockPosition(exactInt(position.get("x")),
                exactInt(position.get("y")), exactInt(position.get("z")));
    }

    private static int exactInt(JsonElement element) {
        if (element == null || !element.isJsonPrimitive()
                || !element.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException();
        }
        return element.getAsBigDecimal().intValueExact();
    }

    private static boolean validDimension(JsonElement dimension) {
        return isString(dimension) && !dimension.getAsString().isBlank();
    }

    private static boolean isString(JsonElement element) {
        return element != null && element.isJsonPrimitive()
                && element.getAsJsonPrimitive().isString();
    }

    private static BlockPos blockPos(RuntimeBlockPosition position) {
        return new BlockPos(position.x(), position.y(), position.z());
    }

    private static JsonObject invalid(JsonElement id) {
        return RuntimeRpcDispatcher.error(id, -32602, "Invalid params");
    }

    private static JsonObject internal(JsonElement id) {
        return RuntimeRpcDispatcher.error(id, -32603, "Internal error");
    }
}
