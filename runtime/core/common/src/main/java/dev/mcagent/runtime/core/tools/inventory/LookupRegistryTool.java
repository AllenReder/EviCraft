package dev.mcagent.runtime.core.tools.inventory;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.locale.Language;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** Bounded Registry and Registry-Tag game-knowledge lookup. */
public final class LookupRegistryTool implements RuntimeTool {

    private static final int MAX_RESULTS = 8;
    private static final Gson GSON = new Gson();
    private static final List<String> KINDS = List.of(
            "item", "block", "entity", "biome", "structure",
            "item_tag", "block_tag", "biome_tag", "structure_tag");

    private record Args(String kind, String query) {}

    @Override public String name() { return "lookup_registry"; }

    @Override
    public String description() {
        return "Look up at most eight deterministic item, block, entity type, biome, structure, or supported "
                + "Registry Tag candidates by canonical id/path, English name, "
                + "prefix, or limited fuzzy match. Tag candidates are not expanded and results make "
                + "no claim about current-world presence.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .enumStr("kind", "Registry or Registry Tag kind", KINDS.toArray(String[]::new))
                .string("query", "Canonical id/path or English name query")
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        Args input = GSON.fromJson(args, Args.class);
        if (input == null || !KINDS.contains(input.kind())) {
            reply.accept(TaskResult.fail("kind must be one of " + KINDS, "invalid_arguments").toJson());
            return;
        }
        if (input.query() == null || input.query().isBlank()) {
            reply.accept(TaskResult.fail("query is required", "invalid_arguments").toJson());
            return;
        }
        if (!(self.level() instanceof ServerLevel level)) {
            reply.accept(TaskResult.fail("Registry lookup needs a server level").toJson());
            return;
        }
        RegistryLookupSearch.Result result = RegistryLookupSearch.search(
                candidates(input.kind(), level), input.query(), MAX_RESULTS);
        List<Map<String, Object>> projection = result.matches().stream().map(candidate -> {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("kind", candidate.kind());
            value.put("id", candidate.id());
            value.put("path", candidate.path());
            if (candidate.name() != null && !candidate.name().isBlank()) {
                value.put("name", candidate.name());
            }
            return value;
        }).toList();
        reply.accept(TaskResult.ok("Registry knowledge candidates", Map.of(
                "kind", input.kind(),
                "query", input.query(),
                "candidates", projection,
                "truncated", result.totalMatches() > MAX_RESULTS)).toJson());
    }

    private static List<RegistryLookupSearch.Candidate> candidates(String kind, ServerLevel level) {
        return switch (kind) {
            case "item" -> values(kind, BuiltInRegistries.ITEM, value -> value.getDescriptionId());
            case "block" -> values(kind, BuiltInRegistries.BLOCK, value -> value.getDescriptionId());
            case "entity" -> values(kind, BuiltInRegistries.ENTITY_TYPE, value -> value.getDescriptionId());
            case "biome" -> values(kind, level.registryAccess().registryOrThrow(Registries.BIOME),
                    value -> "biome");
            case "structure" -> values(kind, level.registryAccess().registryOrThrow(Registries.STRUCTURE),
                    value -> "structure");
            case "item_tag" -> tags(kind, BuiltInRegistries.ITEM);
            case "block_tag" -> tags(kind, BuiltInRegistries.BLOCK);
            case "biome_tag" -> tags(kind, level.registryAccess().registryOrThrow(Registries.BIOME));
            case "structure_tag" -> tags(kind, level.registryAccess().registryOrThrow(Registries.STRUCTURE));
            default -> throw new IllegalArgumentException("unsupported Registry kind " + kind);
        };
    }

    private static <T> List<RegistryLookupSearch.Candidate> values(
            String kind, Registry<T> registry, java.util.function.Function<T, String> translationKey) {
        List<RegistryLookupSearch.Candidate> result = new ArrayList<>();
        Language language = Language.getInstance();
        for (ResourceLocation id : registry.keySet()) {
            T value = registry.get(id);
            String key = translationKey.apply(value);
            String english = key.equals("biome")
                    ? language.getOrDefault("biome." + id.getNamespace() + "." + id.getPath(), humanize(id))
                    : key.equals("structure") ? humanize(id) : language.getOrDefault(key, humanize(id));
            result.add(new RegistryLookupSearch.Candidate(kind, id.toString(), english));
        }
        return result;
    }

    private static <T> List<RegistryLookupSearch.Candidate> tags(String kind, Registry<T> registry) {
        return registry.getTagNames().map(tag -> {
            ResourceLocation id = tag.location();
            return new RegistryLookupSearch.Candidate(kind, id.toString(), humanize(id));
        }).toList();
    }

    private static String humanize(ResourceLocation id) {
        String path = id.getPath().replace('_', ' ').replace('/', ' ');
        StringBuilder result = new StringBuilder(path.length());
        boolean upper = true;
        for (int index = 0; index < path.length(); index++) {
            char value = path.charAt(index);
            result.append(upper ? Character.toUpperCase(value) : value);
            upper = value == ' ';
        }
        return result.toString();
    }
}
