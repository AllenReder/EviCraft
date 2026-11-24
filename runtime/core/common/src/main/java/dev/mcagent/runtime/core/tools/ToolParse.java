package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.core.init.InitTag;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Argument parsing shared by tool entry points. Item ids are parsed by {@code ToolArgs.parseItem}.
 */
public final class ToolParse {

    private ToolParse() {}

    /**
     * Lenient block id set: entries that fail to parse, are unknown, or are air are skipped; input order
     * is preserved (the "first target" label in messages depends on it).
     *
     * <p><b>Entries starting with {@code #} are tags</b> and expand to all their current members:
     * {@code #minecraft:beds} means "any bed", not one color of bed. This is vanilla's own syntax (tag
     * files use it in {@code values} to reference other tags), so what the model writes matches what it
     * has seen in datapacks.
     *
     * <p>Tag contents come from datapacks and exist only after the world loads, so they are <b>resolved
     * on every call</b>: a tag changed by {@code /reload} takes effect on the next call.
     */
    public static Set<Block> parseBlocks(List<String> ids) {
        Set<Block> out = new LinkedHashSet<>();
        if (ids == null) return out;
        for (String raw : ids) {
            if (raw == null) continue;
            TagKey<Block> tag = InitTag.parseRef(Registries.BLOCK, raw);
            if (tag != null) {
                for (Holder<Block> holder : BuiltInRegistries.BLOCK.getTagOrEmpty(tag)) {
                    Block b = holder.value();
                    if (b != Blocks.AIR) out.add(b);
                }
                continue;
            }
            ResourceLocation id = ResourceLocation.tryParse(raw);
            if (id == null) continue;
            Block b = BuiltInRegistries.BLOCK.get(id);
            if (b != null && b != Blocks.AIR) out.add(b);
        }
        return out;
    }

    /** A required object member; anything else is an argument error. */
    public static JsonObject object(JsonObject parent, String name) {
        if (parent == null || !parent.has(name) || !parent.get(name).isJsonObject()) {
            throw new IllegalArgumentException(name + " must be an object");
        }
        return parent.getAsJsonObject(name);
    }

    public static String string(JsonObject parent, String name) {
        if (!parent.has(name) || !parent.get(name).isJsonPrimitive()
                || !parent.getAsJsonPrimitive(name).isString()) {
            throw new IllegalArgumentException(name + " must be a string");
        }
        return parent.get(name).getAsString();
    }

    public static int integer(JsonObject parent, String name) {
        if (!parent.has(name) || !parent.get(name).isJsonPrimitive()
                || !parent.getAsJsonPrimitive(name).isNumber()) {
            throw new IllegalArgumentException(name + " must be an integer");
        }
        try {
            return parent.getAsJsonPrimitive(name).getAsBigDecimal().intValueExact();
        } catch (ArithmeticException invalid) {
            throw new IllegalArgumentException(name + " must be a 32-bit integer");
        }
    }

    public static List<String> strings(JsonArray values) {
        List<String> out = new java.util.ArrayList<>();
        for (JsonElement value : values) out.add(value.getAsString());
        return out;
    }

    /** A block position written as {@code {x, y, z}} with integer members and nothing else. */
    public static BlockPos position(JsonObject position) {
        if (position.size() != 3) {
            throw new IllegalArgumentException("position requires exactly integer x, y, and z");
        }
        return new BlockPos(integer(position, "x"), integer(position, "y"), integer(position, "z"));
    }
}
