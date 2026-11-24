package dev.mcagent.runtime.entity;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.SocketAddress;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The fake connection must report a remote address <b>other code can understand</b>.
 *
 * <p>An in-memory channel's remote address is netty's own {@code EmbeddedSocketAddress}, while much
 * third-party code casts {@code SocketAddress} straight to {@link InetSocketAddress}. A failed cast throws
 * midway through login, so <b>real players cannot join</b> and see "invalid player data" although the
 * save is intact. Such crashes only appear with other mods installed and no other test here catches them,
 * so this one pins the behavior.
 */
@Tag("mc")
class FakeConnectionAddressTest {

    private static boolean booted;

    @BeforeAll
    static void boot() {
        try {
            net.minecraft.SharedConstants.tryDetectVersion();
            net.minecraft.server.Bootstrap.bootStrap();
            booted = true;
        } catch (Throwable t) {
            booted = false;
        }
    }

    @Test
    void theRemoteAddressIsInetShapedSoThirdPartyCastsSurvive() {
        assumeTrue(booted);
        SocketAddress address = new FakeConnection().getRemoteAddress();
        assertInstanceOf(InetSocketAddress.class, address,
                "third-party mods cast it to InetSocketAddress; if the cast fails, login blows up midway");
        assertTrue(((InetSocketAddress) address).getAddress().isLoopbackAddress());
    }

    @Test
    void everyBotReportsTheSameLoopbackAddress() {
        assumeTrue(booted);
        assertEquals(new FakeConnection().getRemoteAddress(),
                new FakeConnection().getRemoteAddress());
    }

    private static void assertTrue(boolean condition) {
        org.junit.jupiter.api.Assertions.assertTrue(condition, "address should be loopback");
    }
}
