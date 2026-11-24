package dev.mcagent.runtime.core.pathing.execute;

import java.util.Objects;
import java.util.function.Supplier;

import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;

/** Immutable task-scoped navigation contract used for planning and execution. */
public record NavigationIntent(
        Supplier<GoalCompiler.Compiled> compiled,
        RouteMutationPolicy routeMutations) {

    public NavigationIntent {
        compiled = Objects.requireNonNull(compiled, "compiled");
        routeMutations = Objects.requireNonNull(routeMutations, "routeMutations");
    }

    public static NavigationIntent fullTraversal(Supplier<GoalCompiler.Compiled> compiled) {
        return new NavigationIntent(compiled, RouteMutationPolicy.fullTraversal());
    }
}
