package dev.mcagent.runtime.core.tools.inventory;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

final class RegistryLookupSearchTest {

    private static final List<RegistryLookupSearch.Candidate> CANDIDATES = List.of(
            new RegistryLookupSearch.Candidate("block", "minecraft:oak_log", "Oak Log"),
            new RegistryLookupSearch.Candidate("block", "example:oak_log", "Example Oak Log"),
            new RegistryLookupSearch.Candidate("block", "minecraft:stripped_oak_log", "Stripped Oak Log"),
            new RegistryLookupSearch.Candidate("block", "minecraft:spruce_log", "Spruce Log")
    );

    @Test
    void matchesCanonicalPathEnglishPrefixAndFuzzyDeterministically() {
        assertEquals(List.of("minecraft:oak_log"), ids(RegistryLookupSearch.search(CANDIDATES, "minecraft:oak_log", 8)));
        assertEquals(List.of("example:oak_log", "minecraft:oak_log"),
                ids(RegistryLookupSearch.search(CANDIDATES, "oak_log", 8)));
        assertEquals(List.of("example:oak_log", "minecraft:oak_log"),
                ids(RegistryLookupSearch.search(CANDIDATES, "Oak Log", 8)));
        assertEquals(List.of("example:oak_log", "minecraft:oak_log", "minecraft:stripped_oak_log"),
                ids(RegistryLookupSearch.search(CANDIDATES, "oak", 8)));
        assertEquals(List.of("minecraft:spruce_log"), ids(RegistryLookupSearch.search(CANDIDATES, "sprce log", 8)));
    }

    @Test
    void truncatesWithoutExpandingTagCandidates() {
        List<RegistryLookupSearch.Candidate> tags = List.of(
                new RegistryLookupSearch.Candidate("block_tag", "minecraft:logs", "Logs"),
                new RegistryLookupSearch.Candidate("block_tag", "minecraft:logs_that_burn", "Logs That Burn")
        );
        RegistryLookupSearch.Result result = RegistryLookupSearch.search(tags, "log", 1);
        assertEquals(List.of("minecraft:logs"), ids(result));
        assertEquals(2, result.totalMatches());
        assertFalse(result.matches().getFirst().kind().equals("block"));
    }

    @Test
    void matchesExactEntityPathsAndLeavesUnknownEntitiesEmpty() {
        List<RegistryLookupSearch.Candidate> entities = List.of(
                new RegistryLookupSearch.Candidate("entity", "minecraft:zombie", "Zombie"),
                new RegistryLookupSearch.Candidate("entity", "minecraft:zombie_horse", "Zombie Horse")
        );

        assertEquals(List.of("minecraft:zombie"),
                ids(RegistryLookupSearch.search(entities, "zombie", 8)));
        RegistryLookupSearch.Result unknown = RegistryLookupSearch.search(
                entities, "no_such_entity_type_probe", 8);
        assertEquals(List.of(), ids(unknown));
        assertEquals(0, unknown.totalMatches());
    }

    private static List<String> ids(RegistryLookupSearch.Result result) {
        return result.matches().stream().map(RegistryLookupSearch.Candidate::id).toList();
    }
}
