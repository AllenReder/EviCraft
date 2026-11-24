package dev.mcagent.camera;

import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.core.BlockPos;

import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Serializes capture requests onto the render thread. A request is captured from the main render
 * target at the end of a frame once its barrier ping was applied, the section build queue is empty,
 * the camera's own section is compiled, and a few further frames settled.
 */
final class CaptureCoordinator {

    /** Frames rendered after the world became ready, so lighting and newly compiled sections show. */
    private static final int SETTLE_FRAMES = 3;

    record Request(int barrier, long deadlineNanos, CompletableFuture<Capture> result) {}

    record Capture(byte[] png, int width, int height) {}

    static final class CaptureTimeout extends RuntimeException {
        CaptureTimeout(String message) { super(message); }
    }

    private final ConcurrentLinkedQueue<Request> incoming = new ConcurrentLinkedQueue<>();
    private Request active;
    private int settledFrames;
    private String waitingFor = "idle";

    CompletableFuture<Capture> submit(int barrier, long timeoutMillis) {
        CompletableFuture<Capture> result = new CompletableFuture<>();
        incoming.add(new Request(barrier, System.nanoTime() + timeoutMillis * 1_000_000L, result));
        return result;
    }

    String waitingFor() { return waitingFor; }

    /** Render thread. True while a capture is being taken or waits to be. */
    boolean pending() { return active != null || !incoming.isEmpty(); }

    /** Render thread, after the frame including its GUI was drawn into the main render target. */
    void onFrameRendered(Minecraft minecraft) {
        if (active == null) {
            active = incoming.poll();
            if (active == null) { waitingFor = "idle"; return; }
            settledFrames = 0;
        }
        if (System.nanoTime() > active.deadlineNanos()) {
            finish(null, new CaptureTimeout("capture timed out waiting for " + waitingFor));
            return;
        }
        // Toasts (for example the offline server's chat verification notice) are client chrome, not the Bot's view.
        minecraft.getToasts().clear();
        if (minecraft.level == null || minecraft.player == null) { hold("world"); return; }
        if (CameraState.lastPing() < active.barrier()) { hold("barrier"); return; }
        if (!minecraft.levelRenderer.hasRenderedAllSections()
                || !minecraft.levelRenderer.isSectionCompiled(BlockPos.containing(minecraft.gameRenderer.getMainCamera().getPosition()))) {
            hold("sections");
            return;
        }
        if (++settledFrames < SETTLE_FRAMES) { waitingFor = "settle"; return; }
        try (NativeImage image = Screenshot.takeScreenshot(minecraft.getMainRenderTarget())) {
            finish(new Capture(image.asByteArray(), image.getWidth(), image.getHeight()), null);
        } catch (IOException | RuntimeException exception) {
            finish(null, exception);
        }
    }

    private void hold(String reason) {
        waitingFor = reason;
        settledFrames = 0;
    }

    private void finish(Capture capture, Throwable failure) {
        Request request = active;
        active = null;
        if (failure == null) request.result().complete(capture);
        else request.result().completeExceptionally(failure);
    }
}
