package dev.mcagent.runtime.sdk;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** First-person capture of the Runtime Bot's view through the camera client. */
public interface RuntimeCameraGateway {

    RuntimeCameraGateway UNAVAILABLE = request ->
            CompletableFuture.failedFuture(new RuntimeCameraUnavailableException("Camera is not configured for this World Run"));

    /** Server thread. Turns the Bot as requested and completes with the next frame rendered after its state was mirrored. */
    CompletionStage<RuntimeCameraCapture> capture(RuntimeCameraRequest request);
}
