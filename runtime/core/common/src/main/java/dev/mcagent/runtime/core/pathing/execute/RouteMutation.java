package dev.mcagent.runtime.core.pathing.execute;

import java.util.Objects;

import net.minecraft.core.BlockPos;

/** A typed world mutation requested by one planned navigation movement. */
public sealed interface RouteMutation permits RouteMutation.Open, RouteMutation.Break, RouteMutation.Place {

    enum Kind { OPEN, BREAK, PLACE }

    BlockPos target();

    Kind kind();

    record Open(BlockPos target) implements RouteMutation {
        public Open {
            target = Objects.requireNonNull(target, "target").immutable();
        }

        @Override
        public Kind kind() {
            return Kind.OPEN;
        }
    }

    record Break(BlockPos target) implements RouteMutation {
        public Break {
            target = Objects.requireNonNull(target, "target").immutable();
        }

        @Override
        public Kind kind() {
            return Kind.BREAK;
        }
    }

    record Place(BlockPos target) implements RouteMutation {
        public Place {
            target = Objects.requireNonNull(target, "target").immutable();
        }

        @Override
        public Kind kind() {
            return Kind.PLACE;
        }
    }
}
