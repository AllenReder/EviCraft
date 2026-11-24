package dev.mcagent.camera;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.Minecraft;
import net.minecraft.world.phys.Vec3;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Loopback control endpoint used by the Runtime.
 *
 * <ul>
 *   <li>{@code GET /status}: JSON connection and camera pose facts.</li>
 *   <li>{@code POST /capture?barrier=N&timeout_ms=T}: PNG of the next frame ready after barrier ping N, within T ms.</li>
 * </ul>
 */
final class CameraHttpServer {

    private final CaptureCoordinator captures;
    private HttpServer server;

    CameraHttpServer(CaptureCoordinator captures) { this.captures = captures; }

    void start(int port) throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 0);
        server.setExecutor(Executors.newFixedThreadPool(2, runnable -> {
            Thread thread = new Thread(runnable, "mc-agent-camera-http");
            thread.setDaemon(true);
            return thread;
        }));
        server.createContext("/status", this::status);
        server.createContext("/capture", this::capture);
        server.start();
    }

    private void status(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"GET".equals(exchange.getRequestMethod())) { sendJson(exchange, 405, error("method_not_allowed")); return; }
            JsonObject status;
            try {
                status = Minecraft.getInstance().submit(this::statusOnClientThread).get(5, TimeUnit.SECONDS);
            } catch (InterruptedException | ExecutionException | TimeoutException exception) {
                sendJson(exchange, 503, error("client_thread_unavailable"));
                return;
            }
            sendJson(exchange, 200, status);
        }
    }

    private JsonObject statusOnClientThread() {
        Minecraft minecraft = Minecraft.getInstance();
        JsonObject status = new JsonObject();
        boolean inWorld = minecraft.level != null && minecraft.player != null;
        status.addProperty("in_world", inWorld);
        status.addProperty("last_ping", CameraState.lastPing());
        status.addProperty("waiting_for", captures.waitingFor());
        status.addProperty("width", minecraft.getMainRenderTarget().width);
        status.addProperty("height", minecraft.getMainRenderTarget().height);
        if (inWorld) {
            Vec3 eye = minecraft.gameRenderer.getMainCamera().getPosition();
            status.addProperty("dimension", minecraft.level.dimension().location().toString());
            status.addProperty("eye_x", eye.x);
            status.addProperty("eye_y", eye.y);
            status.addProperty("eye_z", eye.z);
            status.addProperty("yaw", minecraft.player.getYRot());
            status.addProperty("pitch", minecraft.player.getXRot());
            status.addProperty("rendered_sections", minecraft.levelRenderer.countRenderedSections());
        }
        return status;
    }

    private void capture(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"POST".equals(exchange.getRequestMethod())) { sendJson(exchange, 405, error("method_not_allowed")); return; }
            Map<String, String> query = query(exchange.getRequestURI().getRawQuery());
            int barrier;
            long timeoutMillis;
            try {
                barrier = Integer.parseInt(query.get("barrier"));
                timeoutMillis = Long.parseLong(query.get("timeout_ms"));
            } catch (NumberFormatException exception) {
                sendJson(exchange, 400, error("invalid_query"));
                return;
            }
            CaptureCoordinator.Capture capture;
            try {
                capture = captures.submit(barrier, timeoutMillis).get(timeoutMillis + 5_000, TimeUnit.MILLISECONDS);
            } catch (ExecutionException exception) {
                boolean timedOut = exception.getCause() instanceof CaptureCoordinator.CaptureTimeout;
                JsonObject body = error(timedOut ? "capture_timeout" : "capture_failed");
                body.addProperty("message", String.valueOf(exception.getCause().getMessage()));
                sendJson(exchange, timedOut ? 504 : 500, body);
                return;
            } catch (InterruptedException | TimeoutException exception) {
                sendJson(exchange, 504, error("capture_timeout"));
                return;
            }
            exchange.getResponseHeaders().set("Content-Type", "image/png");
            exchange.getResponseHeaders().set("X-Image-Width", String.valueOf(capture.width()));
            exchange.getResponseHeaders().set("X-Image-Height", String.valueOf(capture.height()));
            exchange.sendResponseHeaders(200, capture.png().length);
            try (OutputStream body = exchange.getResponseBody()) { body.write(capture.png()); }
        }
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> values = new HashMap<>();
        if (raw == null || raw.isEmpty()) return values;
        for (String pair : raw.split("&")) {
            int equals = pair.indexOf('=');
            String key = URLDecoder.decode(equals < 0 ? pair : pair.substring(0, equals), StandardCharsets.UTF_8);
            String value = equals < 0 ? "" : URLDecoder.decode(pair.substring(equals + 1), StandardCharsets.UTF_8);
            values.put(key, value);
        }
        return values;
    }

    private static JsonObject error(String code) {
        JsonObject body = new JsonObject();
        body.addProperty("error", code);
        return body;
    }

    private static void sendJson(HttpExchange exchange, int status, JsonObject body) throws IOException {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream output = exchange.getResponseBody()) { output.write(bytes); }
    }
}
