package dev.mcagent.runtime.core.pathing.bridge;

import dev.mcagent.runtime.core.pathing.moves.ToolSet;

import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Thread-safety smoke test for the frozen context. ToolSet snapshots the hotbar at construction. Afterwards
 * (1) another thread reads the same results as the main thread without failing, and (2) mutating the
 * passed-in array does not affect the constructed instance (defensive copy). Requires the MC registries
 * (ItemStack/Block); if the environment cannot bootstrap, the test is skipped by assumption, not failed.
 */
@Tag("mc")
class FrozenToolSetThreadingTest {

    private static boolean booted;

    @BeforeAll
    static void bootMinecraft() {
        try {
            net.minecraft.SharedConstants.tryDetectVersion();
            net.minecraft.server.Bootstrap.bootStrap();
            booted = true;
        } catch (Throwable t) {
            booted = false;   // Environment cannot bootstrap: skip, do not fail
        }
    }

    /**
     * The probe is shears on cobweb. The shears' mining-speed rule references the block directly (not a
     * tag). Under a headless bootstrap tags are unbound and every pickaxe-type speed degrades to 1, so only
     * such direct-reference tools can tell slots apart in the test environment.
     */
    private static ItemStack[] hotbarWithShears() {
        ItemStack[] hotbar = new ItemStack[9];
        for (int i = 0; i < 9; i++) {
            hotbar[i] = ItemStack.EMPTY;
        }
        hotbar[3] = new ItemStack(Items.SHEARS);
        return hotbar;
    }

    @Test
    void workerThreadReadsMatchMainThread() throws Exception {
        assumeTrue(booted, "MC failed to bootstrap, skipping");
        ItemStack[] hotbar = hotbarWithShears();
        ToolSet frozen = new ToolSet(hotbar, 0, false, 1.0);

        // Main-thread baseline (separate instance, so no per-block cache is shared with the worker)
        ToolSet reference = new ToolSet(hotbarWithShears(), 0, false, 1.0);
        double mainStr = reference.getStrVsBlock(Blocks.COBWEB.defaultBlockState());
        int mainSlot = reference.getBestSlot(Blocks.COBWEB, false);

        // Then another thread consumes it exclusively (real usage: built on the main thread, used by a worker)
        CompletableFuture<double[]> off = CompletableFuture.supplyAsync(() -> new double[]{
                frozen.getStrVsBlock(Blocks.COBWEB.defaultBlockState()),
                frozen.getBestSlot(Blocks.COBWEB, false),
                frozen.getStrVsBlock(Blocks.DIRT.defaultBlockState()),
        });
        double[] results = off.get(10, TimeUnit.SECONDS);

        assertEquals(mainStr, results[0], 1e-12, "worker thread reads the same dig speed as the main thread");
        assertEquals(mainSlot, (int) results[1], "worker thread picks the same slot as the main thread");
        assertTrue(results[2] > 0, "dirt can be broken by hand, speed is positive");
        assertEquals(3, mainSlot, "best tool for cobweb is the shears in slot 3");
    }

    @Test
    void mutatingSourceArrayAfterConstructionHasNoEffect() {
        assumeTrue(booted, "MC failed to bootstrap, skipping");
        ItemStack[] hotbar = hotbarWithShears();
        ToolSet frozen = new ToolSet(hotbar, 0, false, 1.0);
        int before = frozen.getBestSlot(Blocks.COBWEB, false);
        assertEquals(3, before, "shears are in slot 3 at construction");

        // Move the shears to another slot in the source array after construction; the snapshot must not follow
        hotbar[3] = ItemStack.EMPTY;
        hotbar[7] = new ItemStack(Items.SHEARS);
        int after = frozen.getBestSlot(Blocks.COBWEB, false);
        assertEquals(before, after, "external changes after construction do not affect the snapshot");

        // The probe itself discriminates: a new instance built from the mutated array picks the new slot
        ToolSet rebuilt = new ToolSet(hotbar, 0, false, 1.0);
        assertEquals(7, rebuilt.getBestSlot(Blocks.COBWEB, false), "a new instance sees the moved shears");
    }
}
