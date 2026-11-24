package dev.mcagent.runtime.core.pathing.execute;

import java.util.Collection;
import java.util.EnumSet;
import java.util.Objects;
import java.util.Set;

/** Immutable Route Mutation permission carried by one Navigation Intent. */
public final class RouteMutationPolicy {

    private static final RouteMutationPolicy FULL_TRAVERSAL =
            new RouteMutationPolicy(EnumSet.allOf(RouteMutation.Kind.class));

    private final Set<RouteMutation.Kind> permitted;

    private RouteMutationPolicy(Collection<RouteMutation.Kind> permitted) {
        Objects.requireNonNull(permitted, "permitted");
        this.permitted = Set.copyOf(permitted);
    }

    public static RouteMutationPolicy fullTraversal() {
        return FULL_TRAVERSAL;
    }

    public static RouteMutationPolicy of(Collection<RouteMutation.Kind> permitted) {
        return new RouteMutationPolicy(permitted);
    }

    public boolean permits(RouteMutation mutation) {
        return permits(Objects.requireNonNull(mutation, "mutation").kind());
    }

    public boolean permits(RouteMutation.Kind kind) {
        return permitted.contains(Objects.requireNonNull(kind, "kind"));
    }
}
