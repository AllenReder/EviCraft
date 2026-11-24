package dev.mcagent.runtime.knowledge;

import java.util.Objects;

/** Bounded full-match Glob over complete Canonical Registry IDs. */
public final class CanonicalIdentifierGlob implements CanonicalIdentifierMatcher {

    private static final int MAX_LENGTH = 256;
    private final String glob;

    private CanonicalIdentifierGlob(String glob) {
        this.glob = glob;
    }

    public static CanonicalIdentifierGlob compile(String expression) {
        if (expression == null || expression.isEmpty() || expression.length() > MAX_LENGTH) {
            throw new IllegalArgumentException(
                    "canonical identifier glob must contain 1 to 256 characters");
        }
        for (int index = 0; index < expression.length(); index++) {
            char character = expression.charAt(index);
            if (!isCanonicalGlobCharacter(character)) {
                throw new IllegalArgumentException("unsupported canonical identifier glob");
            }
        }
        return new CanonicalIdentifierGlob(expression);
    }

    private static boolean isCanonicalGlobCharacter(char character) {
        return character >= 'a' && character <= 'z'
                || character >= '0' && character <= '9'
                || character == '_' || character == '-' || character == '.'
                || character == ':' || character == '/'
                || character == '*' || character == '?';
    }

    @Override
    public boolean matches(String canonicalId) {
        Objects.requireNonNull(canonicalId, "canonicalId");
        int globIndex = 0;
        int idIndex = 0;
        int lastStar = -1;
        int retryIdIndex = -1;

        while (idIndex < canonicalId.length()) {
            if (globIndex < glob.length()
                    && (glob.charAt(globIndex) == '?'
                    || glob.charAt(globIndex) == canonicalId.charAt(idIndex))) {
                globIndex++;
                idIndex++;
            } else if (globIndex < glob.length() && glob.charAt(globIndex) == '*') {
                lastStar = globIndex++;
                retryIdIndex = idIndex;
            } else if (lastStar >= 0) {
                globIndex = lastStar + 1;
                idIndex = ++retryIdIndex;
            } else {
                return false;
            }
        }
        while (globIndex < glob.length() && glob.charAt(globIndex) == '*') {
            globIndex++;
        }
        return globIndex == glob.length();
    }
}
