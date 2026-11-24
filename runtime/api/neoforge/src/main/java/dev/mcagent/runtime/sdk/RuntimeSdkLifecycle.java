package dev.mcagent.runtime.sdk;

import dev.mcagent.runtime.Constants;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.camera.RuntimeCamera;
import net.minecraft.SharedConstants;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.entity.LivingEntity;
import net.neoforged.fml.ModList;
import net.neoforged.neoforge.event.entity.living.LivingDamageEvent;

import java.util.IdentityHashMap;
import java.util.Map;

/** Starts and stops one SDK endpoint with each in-process Minecraft server. */
public final class RuntimeSdkLifecycle {

    private static final Map<MinecraftServer, RuntimeSdkServer> SERVERS = new IdentityHashMap<>();

    private RuntimeSdkLifecycle() {}

    public static void start(MinecraftServer minecraftServer) {
        RuntimeBotManager.start(minecraftServer, System.getenv());
        RuntimeCamera.start(minecraftServer, System.getenv());
        RuntimeSdkConfig.from(System.getenv()).ifPresentOrElse(config -> {
            RuntimeSimulationControl simulation = RuntimeSimulationControl.forServer(minecraftServer);
            RuntimeRpcDispatcher dispatcher = new RuntimeRpcDispatcher(buildInfo(),
                    RuntimeBotManager.worldKnowledgeProfile(minecraftServer),
                    RuntimeBotManager.groundedEvidencePolicy(minecraftServer),
                    new RuntimeActorGateway() {
                        @Override public RuntimeActorView get() {
                            return RuntimeBotManager.view(minecraftServer);
                        }

                        @Override public RuntimeActorView create(String username) {
                            return RuntimeBotManager.create(minecraftServer, username);
                        }
                    },
                    new DefaultRuntimeToolGateway(() -> RuntimeBotManager.current(minecraftServer).orElse(null)),
                    new DefaultRuntimeEvidenceGateway(minecraftServer), simulation,
                    request -> RuntimeCamera.of(minecraftServer)
                            .map(camera -> camera.capture(request))
                            .orElseGet(() -> RuntimeCameraGateway.UNAVAILABLE.capture(request)));
            RuntimeSdkServer endpoint = new RuntimeSdkServer(minecraftServer, config, dispatcher);
            try {
                endpoint.start();
                SERVERS.put(minecraftServer, endpoint);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                endpoint.close();
                throw new IllegalStateException("Interrupted while starting Runtime SDK", exception);
            } catch (RuntimeException exception) {
                endpoint.close();
                throw exception;
            }
        }, () -> Constants.LOG.info(
                "[mc_agent-runtime] SDK disabled: EVICRAFT_RUNTIME_BEARER_TOKEN is missing"));
    }

    public static void stop(MinecraftServer minecraftServer) {
        RuntimeSdkServer endpoint = SERVERS.remove(minecraftServer);
        if (endpoint != null) {
            endpoint.close();
        }
        RuntimeSimulationControl.stop(minecraftServer);
        RuntimeCamera.stop(minecraftServer);
    }

    public static void tick(MinecraftServer minecraftServer) {
        RuntimeSdkServer endpoint = SERVERS.get(minecraftServer);
        if (endpoint != null) endpoint.tick();
    }

    /** True when the SDK has frozen this World Run's simulation. */
    public static boolean simulationSuspended(MinecraftServer minecraftServer) {
        return RuntimeSimulationControl.suspended(minecraftServer);
    }

    public static void onLivingDamage(LivingDamageEvent.Post event) {
        LivingEntity entity = event.getEntity();
        if (!(entity instanceof BotPlayer body)) return;
        RuntimeSdkServer endpoint = SERVERS.get(entity.level().getServer());
        if (endpoint != null) endpoint.recordDamage(
                event.getNewDamage(), event.getSource(), body.getHealth(), body.getMaxHealth(),
                body.getServer().getTickCount());
    }

    private static RuntimeBuildInfo buildInfo() {
        String build = modVersion("mc_agent");
        String neoForge = modVersion("neoforge");
        return new RuntimeBuildInfo(
                build,
                SharedConstants.getCurrentVersion().getName(),
                neoForge
        );
    }

    private static String modVersion(String modId) {
        return ModList.get().getModContainerById(modId)
                .map(container -> container.getModInfo().getVersion().toString())
                .orElse("unknown");
    }
}
