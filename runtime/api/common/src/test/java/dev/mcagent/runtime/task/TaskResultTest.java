package dev.mcagent.runtime.task;

import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertTrue;

final class TaskResultTest {

    @Test
    void preservesExplicitNullsInsideStructuredCollectionsAndMaps() {
        Map<String, Object> slot = new LinkedHashMap<>();
        slot.put("index", 1);
        slot.put("item_id", null);
        Map<String, Object> cursor = new LinkedHashMap<>();
        cursor.put("item_id", null);
        cursor.put("count", 0);

        var data = JsonParser.parseString(TaskResult.ok("structured", Map.of(
                "slots", List.of(slot),
                "cursor", cursor)).toJson()).getAsJsonObject().getAsJsonObject("data");

        assertTrue(data.getAsJsonArray("slots").get(0).getAsJsonObject().get("item_id").isJsonNull());
        assertTrue(data.getAsJsonObject("cursor").get("item_id").isJsonNull());
    }
}
