package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;
import dev.mcagent.runtime.platform.Services;
import dev.mcagent.runtime.task.TaskResult;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.AbstractCookingRecipe;
import net.minecraft.world.item.crafting.CraftingInput;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.item.crafting.SingleRecipeInput;
import net.minecraft.world.item.crafting.SmithingRecipe;
import net.minecraft.world.item.crafting.SmithingRecipeInput;
import net.minecraft.world.item.crafting.StonecutterRecipe;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Implementation of {@code LookupRecipeTool}.
 */
public final class QueryExtraOps {

    /** Cap recipes per lookup — enough variants to choose from without a token bomb. */
    private static final int MAX_RECIPES = 4;

    private record RecipeMatch(String recipeId, String outputId, String description) {}

    public String lookupRecipe(
String recipeOrOutputIdGlob,
            BotPlayer self) {
        if (recipeOrOutputIdGlob == null) {
            throw new IllegalArgumentException(
                    "recipe_or_output_id_glob is required");
        }
        CanonicalIdentifierMatcher pattern = CanonicalIdentifierGlob.compile(recipeOrOutputIdGlob);
        String selector = recipeOrOutputIdGlob;
        String selectorField = "recipe_or_output_id_glob";
        if (!(self.level() instanceof ServerLevel level)) {
            return TaskResult.fail("recipe lookup needs a server level.").toJson();
        }

        List<RecipeMatch> matches = new ArrayList<>();
        for (RecipeHolder<?> holder : level.getRecipeManager().getRecipes()) {
            Recipe<?> r = holder.value();
            ItemStack result;
            String description;
            if (r instanceof CraftingRecipe cr) {
                // 1.21.1 has no PlacementInfo; a special recipe (firework, map-clone, …) has no
                // static ingredient list — an empty list, or all-empty cells.
                if (cr.getIngredients().isEmpty() || cr.getIngredients().stream().allMatch(Ingredient::isEmpty)) {
                    continue;
                }
                try {
                    result = cr.assemble(CraftingInput.EMPTY, level.registryAccess());   // shaped/shapeless ignore input
                } catch (RuntimeException inputDependent) {
                    continue;
                }
                description = "[crafting] " + format(cr, result);
            } else if (r instanceof AbstractCookingRecipe cook) {
                try {
                    result = cook.assemble(new SingleRecipeInput(ItemStack.EMPTY), level.registryAccess());   // ignores input
                } catch (RuntimeException inputDependent) {
                    continue;
                }
                description = formatCooking(cook, result);
            } else if (r instanceof StonecutterRecipe sc) {
                try {
                    result = sc.assemble(new SingleRecipeInput(ItemStack.EMPTY), level.registryAccess());     // ignores input
                } catch (RuntimeException inputDependent) {
                    continue;
                }
                description = "[stonecutter] " + describeIngredient(sc.getIngredients().get(0))
                        + " -> makes " + result.getCount();
            } else if (r instanceof SmithingRecipe sm) {
                try {
                    // Empty input: a transform recipe (netherite upgrade etc.) still yields its result
                    // item; a cosmetic trim recipe yields the (empty) base, so it self-excludes.
                    result = sm.assemble(new SmithingRecipeInput(
                            ItemStack.EMPTY, ItemStack.EMPTY, ItemStack.EMPTY), level.registryAccess());
                } catch (RuntimeException inputDependent) {
                    continue;
                }
                description = formatSmithing(sm, result);
            } else {
                continue;
            }
            if (result.isEmpty()) {
                continue;
            }
            String recipeId = holder.id().toString();
            String outputId = BuiltInRegistries.ITEM.getKey(result.getItem()).toString();
            if (pattern.matches(recipeId) || pattern.matches(outputId)) {
                matches.add(new RecipeMatch(recipeId, outputId, description));
            }
        }

        matches.sort(Comparator.comparing(RecipeMatch::recipeId));
        if (matches.isEmpty()) {
            return TaskResult.ok("no canonical recipe or output item id matches "
                    + selectorField + " " + selector + ".").toJson();
        }
        boolean hasMore = matches.size() > MAX_RECIPES;
        List<String> recipes = matches.stream().limit(MAX_RECIPES)
                .map(match -> "recipe " + match.recipeId() + " -> " + match.outputId() + "\n"
                        + match.description())
                .toList();
        return TaskResult.ok("recipe/output id matches for " + selector + ":\n\n"
                + String.join("\n\n", recipes)
                + (hasMore ? "\n\n(more matches omitted; narrow " + selectorField + ")" : "")).toJson();
    }

    private static String format(CraftingRecipe recipe, ItemStack result) {
        int count = result.getCount();
        if (recipe instanceof ShapedRecipe shaped) {
            int w = shaped.getWidth();
            int h = shaped.getHeight();
            var cells = shaped.getIngredients();   // 1.21.1: NonNullList<Ingredient>, gaps = Ingredient.EMPTY
            StringBuilder sb = new StringBuilder("shaped " + w + "x" + h + ", makes " + count + ":");
            for (int r = 0; r < h; r++) {
                sb.append("\n  ");
                for (int c = 0; c < w; c++) {
                    Ingredient ing = cells.get(r * w + c);
                    sb.append(ing.isEmpty() ? "." : describeIngredient(ing));
                    if (c < w - 1) {
                        sb.append(" | ");
                    }
                }
            }
            return sb.toString();
        }
        // Shapeless: order doesn't matter, place anywhere.
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Ingredient ing : recipe.getIngredients()) {
            if (ing.isEmpty()) continue;
            counts.merge(describeIngredient(ing), 1, Integer::sum);
        }
        String list = counts.entrySet().stream()
                .map(e -> e.getValue() + "x " + e.getKey())
                .collect(Collectors.joining(", "));
        return "shapeless, makes " + count + ": " + list + " (place anywhere in the grid)";
    }

    /** A cooking recipe (one input → one output) labelled by its station. */
    private static String formatCooking(AbstractCookingRecipe recipe, ItemStack result) {
        RecipeType<?> type = recipe.getType();
        String station = type == RecipeType.BLASTING ? "blasting (blast furnace)"
                : type == RecipeType.SMOKING ? "smoking (smoker)"
                : type == RecipeType.CAMPFIRE_COOKING ? "campfire"
                : "smelting (furnace)";
        return "[" + station + "] " + describeIngredient(recipe.getIngredients().get(0)) + " -> makes "
                + result.getCount() + " (" + recipe.getCookingTime() + " ticks)";
    }

    /** A smithing recipe (smithing table). 1.21.1's SmithingRecipe exposes only is*Ingredient(stack)
     *  tests — no ingredient getters — so we can't enumerate the inputs; describe the station + result. */
    private static String formatSmithing(SmithingRecipe recipe, ItemStack result) {
        return "[smithing] (smithing table: template + base + addition) -> makes " + result.getCount();
    }

    /** Name an ingredient: a single item directly, a shared-suffix tag as "planks (any)", else a few
     *  members — so a category ingredient doesn't mislead the model into one specific item.
     *  Package-visible: the craft tool names its material shortfalls with the same vocabulary. */
    static String describeIngredient(Ingredient ing) {
        List<String> paths = java.util.Arrays.stream(ing.getItems())   // 1.21.1: getItems() -> ItemStack[]
                .map(s -> BuiltInRegistries.ITEM.getKey(s.getItem()).getPath())
                .distinct()
                .toList();
        if (paths.isEmpty()) {
            return "?";
        }
        if (paths.size() == 1) {
            return paths.get(0);
        }
        String suffix = commonSuffixToken(paths);
        if (suffix != null) {
            return suffix + "(any)";
        }
        return "any[" + paths.stream().limit(3).collect(Collectors.joining("/"))
                + (paths.size() > 3 ? "/…" : "") + "]";
    }

    private static String commonSuffixToken(List<String> paths) {
        String token = null;
        for (String p : paths) {
            int u = p.lastIndexOf('_');
            String t = u < 0 ? p : p.substring(u + 1);
            if (token == null) {
                token = t;
            } else if (!token.equals(t)) {
                return null;
            }
        }
        return token;
    }
}
