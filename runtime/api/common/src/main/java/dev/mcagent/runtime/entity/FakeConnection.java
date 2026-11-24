package dev.mcagent.runtime.entity;

import net.minecraft.network.PacketSendListener;
import io.netty.channel.embedded.EmbeddedChannel;
import net.minecraft.network.Connection;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.PacketFlow;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.util.function.Consumer;

/**
 * A channel-less {@link Connection} for a bot fake {@code ServerPlayer}.
 * The server pushes a steady stream of clientbound packets at any list-resident
 * player (position, chunks, entity updates, keep-alives); a real connection
 * writes them to a netty channel, but our bot has no client on the other
 * end. A bare {@code new Connection(...)} is NOT safe: its {@code send} queues
 * every packet into an unbounded {@code pendingActions} list when no channel is
 * attached — a slow leak. So we subclass and DISCARD all outbound I/O.
 *
 * <p>{@code Connection} is non-final with a public {@code PacketFlow} ctor, so
 * this is pure common code — no reflection, access-wideners or mixins. Two
 * details make {@code placeNewPlayer} accept it:
 * <ul>
 *   <li><b>SERVERBOUND</b> receiving flow — a server-side player connection
 *       receives serverbound packets (the client sends them), so its listener
 *       is serverbound; {@code validateListener} rejects a CLIENTBOUND mismatch.</li>
 *   <li>a real (in-memory) {@link EmbeddedChannel} — {@code placeNewPlayer ->
 *       setupInboundProtocol} configures the channel's pipeline, which NPEs on a
 *       channel-less connection. Registering this Connection as the embedded
 *       channel's handler fires {@code channelActive}, setting the channel.</li>
 * </ul>
 * Outbound packets are still discarded by the {@code send} override (the
 * embedded channel is never written to, so it never buffers/leaks), and the
 * keep-alive timeout is neutralised via the no-op {@code disconnect} (a fake
 * player never answers keep-alive). Lifecycle is governed by
 * {@code BotLifecycle}, not by connection state.
 */
@dev.mcagent.runtime.api.Internal
public final class FakeConnection extends Connection {

    public FakeConnection() {
        super(PacketFlow.SERVERBOUND);
        // Registering this Connection (a netty inbound handler) as the embedded
        // channel's handler fires channelActive → sets this.channel, so the
        // pipeline setup inside placeNewPlayer has a channel to work on.
        new EmbeddedChannel(this);
    }

    /** The address the Bot's connection reports. See {@link #getRemoteAddress}. */
    private static final InetSocketAddress LOOPBACK =
            new InetSocketAddress(InetAddress.getLoopbackAddress(), 0);

    /**
     * The loopback address. <b>A compatibility requirement, not decoration.</b>
     *
     * <p>An in-memory channel's remote address is a netty-specific type, while much third-party code
     * <b>casts</b> {@code SocketAddress} straight to {@link InetSocketAddress} (IP allowlists, login
     * protection, chat bridges). A failed cast throws inside the player-join event and aborts the whole
     * login, so <b>real players cannot join either</b>; the client shows "invalid player data" even though
     * the save is intact. Such crashes only appear with other mods installed, so this repository's own
     * tests cannot catch them.
     *
     * <p>Vanilla shares the problem: single-player and "Open to LAN" also use an in-memory channel
     * ({@code ServerConnectionListener.startMemoryChannel}, address netty's {@code LocalAddress}), and those
     * casts fail there too. Only this side can be fixed here.
     *
     * <p>Loopback is the <b>honest</b> answer: the body really is on this machine, with no remote end. Real
     * players report a public IP, so server operators can tell them apart in the logs at a glance.
     */
    @Override
    public SocketAddress getRemoteAddress() {
        return LOOPBACK;
    }

    /** Discard every outbound packet — there is no client to receive it.
     *  The 1-arg and 2-arg {@code send} overloads route through this one. */
    @Override
    public void send(Packet<?> packet, PacketSendListener listener, boolean flush) {
        // no-op: drop it on the floor (no channel, no pendingActions growth)
    }

    /** Vanilla queues these until "connected"; we never connect, so run nothing. */
    @Override
    public void runOnceConnected(Consumer<Connection> action) {
        // no-op
    }

    /**
     * Report live so player ticking / chunk tracking proceed as for a real
     * player. Safe because every channel-dereferencing path (send, tick,
     * flushChannel) is overridden to no-op below, so the null channel is never
     * touched.
     */
    @Override
    public boolean isConnected() {
        return true;
    }

    /** Headless Runtime Bots use vanilla's memory-connection chunk batching semantics. */
    @Override
    public boolean isMemoryConnection() {
        return true;
    }

    /** Don't drive the packet listener's tick (that's what runs the keep-alive). */
    @Override
    public void tick() {
        // no-op
    }

    /** Neutralise the keep-alive timeout (and any other) disconnect — both overloads. */
    @Override
    public void disconnect(Component message) {
        // no-op: the bot is removed via BotLifecycle, never by the wire
    }

    @Override
    public void disconnect(DisconnectionDetails details) {
        // no-op
    }

    @Override
    public void handleDisconnection() {
        // no-op
    }

    @Override
    public void flushChannel() {
        // no-op
    }

    @Override
    public void setReadOnly() {
        // no-op
    }
}
