package dev.mcagent.runtime.core.tools.inventory;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/** Deterministic bounded matching for Registry game-knowledge candidates. */
public final class RegistryLookupSearch {

    private RegistryLookupSearch() {}

    public record Candidate(String kind, String id, String name) {
        public Candidate {
            Objects.requireNonNull(kind, "kind");
            Objects.requireNonNull(id, "id");
        }

        public String path() {
            int separator = id.indexOf(':');
            return separator < 0 ? id : id.substring(separator + 1);
        }
    }

    public record Result(List<Candidate> matches, int totalMatches) {
        public Result {
            matches = List.copyOf(matches);
        }
    }

    public static Result search(List<Candidate> candidates, String query, int limit) {
        Objects.requireNonNull(candidates, "candidates");
        if (query == null || query.isBlank()) throw new IllegalArgumentException("query is required");
        if (limit < 1) throw new IllegalArgumentException("limit must be positive");
        String needle = normalize(query);
        List<Scored> scored = new ArrayList<>();
        for (Candidate candidate : candidates) {
            int score = score(candidate, needle);
            if (score != Integer.MAX_VALUE) scored.add(new Scored(candidate, score));
        }
        scored.sort(Comparator.comparingInt(Scored::score)
                .thenComparing(value -> value.candidate().id()));
        if (!scored.isEmpty() && scored.getFirst().score() <= 2) {
            int best = scored.getFirst().score();
            scored.removeIf(value -> value.score() != best);
        }
        return new Result(scored.stream().limit(limit).map(Scored::candidate).toList(), scored.size());
    }

    private static int score(Candidate candidate, String needle) {
        String id = normalize(candidate.id());
        String path = normalize(candidate.path());
        String name = normalize(candidate.name());
        if (id.equals(needle)) return 0;
        if (path.equals(needle)) return 1;
        if (name.equals(needle)) return 2;
        if (id.startsWith(needle) || path.startsWith(needle) || name.startsWith(needle)) return 3;
        if (id.contains(needle) || path.contains(needle) || name.contains(needle)) return 4;
        int threshold = Math.max(2, needle.length() / 5);
        int distance = Math.min(distance(needle, path), distance(needle, name));
        return distance <= threshold ? 5 + distance : Integer.MAX_VALUE;
    }

    private static String normalize(String value) {
        if (value == null) return "";
        return value.strip().toLowerCase(Locale.ROOT).replace('_', ' ').replace('-', ' ')
                .replaceAll("\\s+", " ");
    }

    private static int distance(String left, String right) {
        if (right.isEmpty()) return Integer.MAX_VALUE;
        int[] previous = new int[right.length() + 1];
        int[] current = new int[right.length() + 1];
        for (int column = 0; column <= right.length(); column++) previous[column] = column;
        for (int row = 1; row <= left.length(); row++) {
            current[0] = row;
            for (int column = 1; column <= right.length(); column++) {
                int substitution = left.charAt(row - 1) == right.charAt(column - 1) ? 0 : 1;
                current[column] = Math.min(
                        Math.min(current[column - 1] + 1, previous[column] + 1),
                        previous[column - 1] + substitution);
            }
            int[] swap = previous;
            previous = current;
            current = swap;
        }
        return previous[right.length()];
    }

    private record Scored(Candidate candidate, int score) {}
}
