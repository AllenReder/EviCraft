package dev.mcagent.runtime.knowledge;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class CanonicalIdentifierGlobTest {

    @Test
    void fullMatchesCanonicalIdsAcrossNamespaceAndPathSeparators() {
        assertTrue(CanonicalIdentifierGlob.compile("minecraft:*_log")
                .matches("minecraft:oak_log"));
        assertFalse(CanonicalIdentifierGlob.compile("minecraft:*_log")
                .matches("example:oak_log"));
        assertTrue(CanonicalIdentifierGlob.compile("*log")
                .matches("minecraft:wood/oak_log"));
        assertTrue(CanonicalIdentifierGlob.compile("minecraft?oak_log")
                .matches("minecraft:oak_log"));
        assertFalse(CanonicalIdentifierGlob.compile("minecraft?oak_log")
                .matches("minecraft:wood/oak_log"));
    }

    @Test
    void exactGlobsRemainExactAndCanonicalPunctuationIsLiteral() {
        var exact = CanonicalIdentifierGlob.compile("example:tools/iron.hammer-v2");
        assertTrue(exact.matches("example:tools/iron.hammer-v2"));
        assertFalse(exact.matches("example:tools/ironXhammer-v2"));
        assertFalse(exact.matches("prefix/example:tools/iron.hammer-v2"));
    }

    @Test
    void acceptsTheLengthBoundariesAndRejectsUnsupportedSyntax() {
        assertTrue(CanonicalIdentifierGlob.compile("a").matches("a"));
        assertFalse(CanonicalIdentifierGlob.compile("a".repeat(256)).matches("a"));

        for (String invalid : new String[] {
                "", "a".repeat(257), "minecraft:(oak|birch)_log",
                "minecraft:[a-z]_log", "(?=minecraft:)stone", "(stone)\\1"
        }) {
            assertThrows(IllegalArgumentException.class,
                    () -> CanonicalIdentifierGlob.compile(invalid), invalid);
        }
        assertFalse(CanonicalIdentifierGlob.compile("minecraft:.*_log")
                .matches("minecraft:oak_log"));
    }
}
