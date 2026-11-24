package dev.mcagent.runtime.bot;

import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;

/** Process-local identity for the single Runtime Bot in one World Run. */
public final class RuntimeBotRun {

    public record Identity(UUID uuid, String name) {
        public Identity {
            Objects.requireNonNull(uuid, "uuid");
            Objects.requireNonNull(name, "name");
        }
    }

    private final Identity identity;

    private RuntimeBotRun(Identity identity) {
        this.identity = identity;
    }

    public static RuntimeBotRun start(Supplier<UUID> uuidSource, String username) {
        Objects.requireNonNull(uuidSource, "uuidSource");
        Objects.requireNonNull(username, "username");
        if (!username.matches("[A-Za-z0-9_]{1,16}")) {
            throw new IllegalArgumentException("username must be a Minecraft username");
        }
        return new RuntimeBotRun(new Identity(
                Objects.requireNonNull(uuidSource.get(), "uuidSource result"), username));
    }

    public Identity identity() {
        return identity;
    }
}
