package dev.mcagent.runtime.evidence;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.BambooSaplingBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.BushBlock;
import net.minecraft.world.level.block.GrowingPlantBlock;
import net.minecraft.world.level.block.HangingRootsBlock;
import net.minecraft.world.level.block.MultifaceBlock;
import net.minecraft.world.level.block.SporeBlossomBlock;
import net.minecraft.world.level.block.SugarCaneBlock;
import net.minecraft.world.level.block.VineBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;

import java.util.Set;

/**
 * Vanilla surfaces that are seen without ending a sight ray: an explicit list of glass and ice,
 * water, and plants that can be walked through (grass, flowers, crops, vines, kelp), which are
 * drawn as cut-out crosses or sheets. Everything else ends the ray where its outline shape is
 * hit: leaves, lava, packed ice, and blue ice render opaque and hide what is behind them.
 */
final class VanillaVisibilityTransparency {

    private static final Set<Block> BLOCKS = Set.of(
            Blocks.GLASS, Blocks.TINTED_GLASS,
            Blocks.WHITE_STAINED_GLASS, Blocks.ORANGE_STAINED_GLASS,
            Blocks.MAGENTA_STAINED_GLASS, Blocks.LIGHT_BLUE_STAINED_GLASS,
            Blocks.YELLOW_STAINED_GLASS, Blocks.LIME_STAINED_GLASS,
            Blocks.PINK_STAINED_GLASS, Blocks.GRAY_STAINED_GLASS,
            Blocks.LIGHT_GRAY_STAINED_GLASS, Blocks.CYAN_STAINED_GLASS,
            Blocks.PURPLE_STAINED_GLASS, Blocks.BLUE_STAINED_GLASS,
            Blocks.BROWN_STAINED_GLASS, Blocks.GREEN_STAINED_GLASS,
            Blocks.RED_STAINED_GLASS, Blocks.BLACK_STAINED_GLASS,
            Blocks.GLASS_PANE,
            Blocks.WHITE_STAINED_GLASS_PANE, Blocks.ORANGE_STAINED_GLASS_PANE,
            Blocks.MAGENTA_STAINED_GLASS_PANE, Blocks.LIGHT_BLUE_STAINED_GLASS_PANE,
            Blocks.YELLOW_STAINED_GLASS_PANE, Blocks.LIME_STAINED_GLASS_PANE,
            Blocks.PINK_STAINED_GLASS_PANE, Blocks.GRAY_STAINED_GLASS_PANE,
            Blocks.LIGHT_GRAY_STAINED_GLASS_PANE, Blocks.CYAN_STAINED_GLASS_PANE,
            Blocks.PURPLE_STAINED_GLASS_PANE, Blocks.BLUE_STAINED_GLASS_PANE,
            Blocks.BROWN_STAINED_GLASS_PANE, Blocks.GREEN_STAINED_GLASS_PANE,
            Blocks.RED_STAINED_GLASS_PANE, Blocks.BLACK_STAINED_GLASS_PANE,
            Blocks.ICE, Blocks.FROSTED_ICE
    );
    private static final Set<Fluid> FLUIDS = Set.of(Fluids.WATER, Fluids.FLOWING_WATER);

    private VanillaVisibilityTransparency() {}

    static boolean block(BlockState state) {
        return BLOCKS.contains(state.getBlock()) || walkThroughPlant(state);
    }

    private static boolean walkThroughPlant(BlockState state) {
        Block block = state.getBlock();
        return (block instanceof BushBlock || block instanceof GrowingPlantBlock
                || block instanceof SugarCaneBlock || block instanceof VineBlock
                || block instanceof MultifaceBlock || block instanceof HangingRootsBlock
                || block instanceof SporeBlossomBlock || block instanceof BambooSaplingBlock)
                && state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).isEmpty();
    }

    static boolean fluid(FluidState state) {
        return !state.isEmpty() && FLUIDS.contains(state.getType());
    }
}
