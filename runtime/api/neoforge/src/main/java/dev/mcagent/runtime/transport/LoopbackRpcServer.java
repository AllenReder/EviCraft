package dev.mcagent.runtime.transport;

import dev.mcagent.runtime.Constants;
import com.google.gson.JsonObject;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.ChannelOption;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpHeaderValues;
import io.netty.handler.codec.http.HttpObjectAggregator;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.HttpServerCodec;
import io.netty.handler.codec.http.HttpVersion;
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame;
import io.netty.handler.codec.http.websocketx.WebSocketFrame;
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler;
import io.netty.util.AttributeKey;
import net.minecraft.server.MinecraftServer;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Objects;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** Shared loopback-only, bearer-authenticated single-controller WebSocket RPC transport. */
public final class LoopbackRpcServer implements AutoCloseable {

    private static final String RPC_PATH = "/rpc";
    private static final AttributeKey<Long> CONTROL_SESSION =
            AttributeKey.valueOf("mc_agent.loopback_rpc_session");

    @FunctionalInterface
    public interface RequestHandler {
        CompletionStage<String> handle(String authenticatedTextFrame, long receivedNanos);
    }

    public interface SessionListener {
        void opened(long sessionId);
        void closed(long sessionId);
    }

    private final MinecraftServer minecraftServer;
    private final String host;
    private final int port;
    private final String bearerToken;
    private final String logLabel;
    private final RequestHandler handler;
    private final SessionListener sessions;
    private final NioEventLoopGroup acceptGroup = new NioEventLoopGroup(1);
    private final NioEventLoopGroup workerGroup = new NioEventLoopGroup(1);
    private final AtomicReference<Channel> controller = new AtomicReference<>();
    private final AtomicLong sessionSequence = new AtomicLong();
    private Channel listeningChannel;

    public LoopbackRpcServer(MinecraftServer minecraftServer, String host, int port, String bearerToken,
                             String logLabel, RequestHandler handler, SessionListener sessions) {
        this.minecraftServer = Objects.requireNonNull(minecraftServer, "minecraftServer");
        this.host = Objects.requireNonNull(host, "host");
        this.port = port;
        this.bearerToken = Objects.requireNonNull(bearerToken, "bearerToken");
        this.logLabel = Objects.requireNonNull(logLabel, "logLabel");
        this.handler = Objects.requireNonNull(handler, "handler");
        this.sessions = Objects.requireNonNull(sessions, "sessions");
    }

    public void start() throws InterruptedException {
        ServerBootstrap bootstrap = new ServerBootstrap()
                .group(acceptGroup, workerGroup)
                .channel(NioServerSocketChannel.class)
                .childOption(ChannelOption.TCP_NODELAY, true)
                .childHandler(new ChannelInitializer<SocketChannel>() {
                    @Override protected void initChannel(SocketChannel channel) {
                        channel.pipeline().addLast(new HttpServerCodec())
                                .addLast(new HttpObjectAggregator(64 * 1024))
                                .addLast(new HandshakeGate())
                                .addLast(new WebSocketServerProtocolHandler(RPC_PATH, null, false))
                                .addLast(new RpcFrameHandler());
                    }
                });
        listeningChannel = bootstrap.bind(new InetSocketAddress(host, port)).sync().channel();
        Constants.LOG.info("[mc_agent-runtime] {} listening at ws://{}:{}{}", logLabel, host, port,
                RPC_PATH);
    }

    /** Sends an authenticated-server notification to the current controller, if one is connected. */
    public boolean send(JsonObject notification) {
        Channel active = controller.get();
        if (active == null || !active.isActive()) return false;
        active.writeAndFlush(new TextWebSocketFrame(notification.toString()));
        return true;
    }

    @Override public void close() {
        Channel listening = listeningChannel;
        listeningChannel = null;
        if (listening != null) listening.close().awaitUninterruptibly();
        Channel active = controller.getAndSet(null);
        if (active != null) active.close().awaitUninterruptibly();
        workerGroup.shutdownGracefully().awaitUninterruptibly();
        acceptGroup.shutdownGracefully().awaitUninterruptibly();
    }

    private final class HandshakeGate extends SimpleChannelInboundHandler<FullHttpRequest> {
        @Override protected void channelRead0(ChannelHandlerContext context, FullHttpRequest request) {
            if (!RPC_PATH.equals(request.uri())) { reject(context, HttpResponseStatus.NOT_FOUND); return; }
            String authorization = request.headers().get(HttpHeaderNames.AUTHORIZATION);
            if (authorization == null || !constantTimeEquals(authorization, "Bearer " + bearerToken)) {
                reject(context, HttpResponseStatus.UNAUTHORIZED); return;
            }
            if (!controller.compareAndSet(null, context.channel())) {
                reject(context, HttpResponseStatus.CONFLICT); return;
            }
            long sessionId = sessionSequence.incrementAndGet();
            context.channel().attr(CONTROL_SESSION).set(sessionId);
            Constants.LOG.info("[mc_agent-runtime] {} authenticated controller handshake", logLabel);
            minecraftServer.execute(() -> sessions.opened(sessionId));
            context.fireChannelRead(request.retain());
        }

        @Override public void exceptionCaught(ChannelHandlerContext context, Throwable cause) {
            Constants.LOG.warn("[mc_agent-runtime] {} handshake failed", logLabel, cause);
            context.close();
        }

        @Override public void channelInactive(ChannelHandlerContext context) throws Exception {
            releaseSession(context);
            super.channelInactive(context);
        }
    }

    private final class RpcFrameHandler extends SimpleChannelInboundHandler<WebSocketFrame> {
        @Override protected void channelRead0(ChannelHandlerContext context, WebSocketFrame frame) {
            if (!(frame instanceof TextWebSocketFrame textFrame)) { context.close(); return; }
            String request = textFrame.text();
            long receivedNanos = System.nanoTime();
            minecraftServer.execute(() -> {
                if (!context.channel().isActive()) return;
                handler.handle(request, receivedNanos).whenComplete((response, error) -> {
                    if (!context.channel().isActive()) return;
                    String wire = error == null ? response
                            : "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"Internal error\"}}";
                    context.writeAndFlush(new TextWebSocketFrame(wire));
                });
            });
        }

        @Override public void exceptionCaught(ChannelHandlerContext context, Throwable cause) {
            Constants.LOG.warn("[mc_agent-runtime] {} connection failed", logLabel, cause);
            context.close();
        }

        @Override public void channelInactive(ChannelHandlerContext context) throws Exception {
            releaseSession(context);
            super.channelInactive(context);
        }
    }

    private void releaseSession(ChannelHandlerContext context) {
        Long sessionId = context.channel().attr(CONTROL_SESSION).getAndSet(null);
        if (sessionId == null) return;
        controller.compareAndSet(context.channel(), null);
        minecraftServer.execute(() -> sessions.closed(sessionId));
    }

    private static void reject(ChannelHandlerContext context, HttpResponseStatus status) {
        DefaultFullHttpResponse response = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status);
        response.headers().setInt(HttpHeaderNames.CONTENT_LENGTH, 0);
        response.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.CLOSE);
        context.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
    }

    private static boolean constantTimeEquals(String actual, String expected) {
        return MessageDigest.isEqual(actual.getBytes(StandardCharsets.UTF_8),
                expected.getBytes(StandardCharsets.UTF_8));
    }
}
