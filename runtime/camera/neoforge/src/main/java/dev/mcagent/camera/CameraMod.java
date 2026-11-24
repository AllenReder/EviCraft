package dev.mcagent.camera;

import com.mojang.logging.LogUtils;
import net.minecraft.client.Minecraft;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.RenderFrameEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;

import java.io.IOException;
import java.io.UncheckedIOException;

/**
 * Entry point of the camera client. {@code -Dmcagent.camera.port} selects the loopback control port.
 *
 * <p>The client renders in software, so every frame costs CPU whether or not anyone looks at it. Between
 * captures it drops to {@link #IDLE_FRAME_RATE}; a pending capture restores the configured frame rate.
 */
@Mod(value = "mc_agent_camera", dist = Dist.CLIENT)
public final class CameraMod {

    private static final Logger LOG = LogUtils.getLogger();

    /**
     * Frames per second with no capture pending. Packets, light updates and section meshes are all applied
     * per frame, so the idle client keeps rendering slowly rather than stopping: its world stays current.
     * Two frames a second still run all 20 client ticks.
     */
    private static final int IDLE_FRAME_RATE = 2;

    private final CaptureCoordinator captures = new CaptureCoordinator();

    public CameraMod() {
        int port = Integer.getInteger("mcagent.camera.port", -1);
        if (port < 0) throw new IllegalStateException("mcagent.camera.port must be set for the camera client");
        try {
            new CameraHttpServer(captures).start(port);
        } catch (IOException exception) {
            throw new UncheckedIOException("camera control port " + port + " unavailable", exception);
        }
        LOG.info("[mc_agent_camera] control endpoint on 127.0.0.1:{}", port);
        NeoForge.EVENT_BUS.addListener(RenderFrameEvent.Post.class, this::frameRendered);
        NeoForge.EVENT_BUS.addListener(ClientPlayerNetworkEvent.LoggingIn.class, this::loggedIn);
    }

    private void frameRendered(RenderFrameEvent.Post event) {
        Minecraft minecraft = Minecraft.getInstance();
        captures.onFrameRendered(minecraft);
        minecraft.getWindow().setFramerateLimit(
                captures.pending() ? minecraft.options.framerateLimit().get() : IDLE_FRAME_RATE);
    }

    /**
     * World Simulation Suspension stops every server tick, so the server sends nothing while it waits
     * for a model decision. The camera must survive arbitrarily long silences without a read timeout.
     */
    private void loggedIn(ClientPlayerNetworkEvent.LoggingIn event) {
        CameraState.reset();
        var pipeline = event.getConnection().channel().pipeline();
        if (pipeline.get("timeout") != null) pipeline.remove("timeout");
        LOG.info("[mc_agent_camera] joined; read timeout removed");
    }
}
