package dev.mcagent.runtime.core.task.inventory;

import dev.mcagent.runtime.core.WorkProfile;
import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.core.act.Interaction;
import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.core.task.base.Precondition;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.stats.Stats;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Consumes one actual carried stack through Minecraft's native held-use lifecycle. */
public final class EatTask extends AbstractBotTask<EatItemTaskRecord> {
    private Interaction use;
    private ItemStack selectedStack = ItemStack.EMPTY;
    private ItemStack expectedContainer = ItemStack.EMPTY;
    private int selectedSlot = -1;
    private int consumedCount;
    private int returnedContainers;
    private Runnable stopObservingCompletion;

    public EatTask(BotPlayer player, EatItemTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(
                () -> WorkProfile.of(player).hasHunger() ? null
                        : new Precondition.Failure("consumption requires a survival body", FailureType.UNKNOWN),
                this::selectConsumable);
    }

    private Precondition.Failure selectConsumable() {
        var inventory = player.getInventory();
        if (r.slot != null) {
            selectedSlot = r.slot;
        } else {
            ItemStack first = ItemStack.EMPTY;
            for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
                ItemStack candidate = inventory.getItem(slot);
                if (candidate.isEmpty() || (r.item != null && !candidate.is(r.item))) continue;
                if (first.isEmpty()) {
                    first = candidate;
                    selectedSlot = slot;
                } else if (!ItemStack.isSameItemSameComponents(first, candidate)) {
                    return new Precondition.Failure(
                            "multiple variants of " + r.label + " are carried; select an observed Inventory slot",
                            FailureType.UNKNOWN);
                }
            }
        }
        if (selectedSlot < 0 || selectedSlot >= inventory.getContainerSize() || inventory.getItem(selectedSlot).isEmpty()) {
            return new Precondition.Failure("no consumable in " + r.label, FailureType.NO_MATERIAL);
        }
        ItemStack stack = inventory.getItem(selectedSlot);
        if (r.item != null && !stack.is(r.item)) {
            return new Precondition.Failure("selected Inventory slot does not contain " + r.label, FailureType.NO_MATERIAL);
        }
        if (stack.get(DataComponents.FOOD) == null && !stack.is(Items.MILK_BUCKET) && !stack.is(Items.POTION)) {
            return new Precondition.Failure("selected item cannot be eaten or drunk; splash and lingering potions are excluded",
                    FailureType.UNKNOWN);
        }
        var edible = stack.get(DataComponents.FOOD);
        // Native food use refuses a full hunger bar unless the food is always edible; honey is drunk instantly.
        if (edible != null && !edible.canAlwaysEat() && !stack.is(Items.HONEY_BOTTLE) && !player.canEat(false)) {
            return new Precondition.Failure(
                    "not hungry: the food bar is full and " + r.label + " is not always edible",
                    FailureType.UNKNOWN);
        }
        selectedStack = stack.copy();
        var food = selectedStack.get(DataComponents.FOOD);
        expectedContainer = selectedStack.is(Items.MILK_BUCKET) ? new ItemStack(Items.BUCKET)
                : selectedStack.is(Items.POTION) || selectedStack.is(Items.HONEY_BOTTLE) ? new ItemStack(Items.GLASS_BOTTLE)
                : food == null ? ItemStack.EMPTY : food.usingConvertsTo().map(ItemStack::copy).orElse(ItemStack.EMPTY);
        return null;
    }

    @Override
    protected void onStart() {
        player.holdInHand(selectedSlot);
        stopObservingCompletion = player.observeItemUseCompletion(new BotPlayer.ItemUseCompletionObserver() {
            private boolean selectedUse;
            private int usesBeforeFinish;
            private int containersBeforeFinish;

            @Override
            public void beforeFinish(ItemStack usedStack) {
                selectedUse = ItemStack.isSameItemSameComponents(selectedStack, usedStack);
                if (!selectedUse) return;
                usesBeforeFinish = player.getStats().getValue(Stats.ITEM_USED.get(selectedStack.getItem()));
                containersBeforeFinish = countVariant(expectedContainer);
            }

            @Override
            public void afterFinish(ItemStack resultStack) {
                if (!selectedUse) return;
                // Food, milk and drinkable potions award ITEM_USED inside their native finish.
                // Inventory loss on death, dropping or slot replacement awards no such use.
                int uses = player.getStats().getValue(Stats.ITEM_USED.get(selectedStack.getItem())) - usesBeforeFinish;
                if (uses <= 0) return;
                // Honey awards ITEM_USED both in Player.eat and its item finish;
                // the counter witnesses completion, while one finish consumes one item.
                consumedCount++;
                if (!expectedContainer.isEmpty()) {
                    // Prefer the exact native hand result. Stacked foods instead insert their
                    // container into Inventory, observed in this same synchronous finish call.
                    returnedContainers += ItemStack.isSameItemSameComponents(resultStack, expectedContainer)
                            ? resultStack.getCount()
                            : Math.max(0, countVariant(expectedContainer) - containersBeforeFinish);
                }
            }
        });
        use = Interaction.useInAir(player, InteractionHand.MAIN_HAND, Interaction.Timing.hold());
    }

    @Override
    protected TaskState onTick() {
        return switch (use.tick()) {
            case DONE -> {
                if (consumedCount == 0) {
                    fail("native consumption did not consume the selected stack; ordinary food may require hunger",
                            FailureType.UNKNOWN);
                    yield TaskState.FAILED;
                }
                yield TaskState.SUCCESS;
            }
            case FAILED -> {
                fail("native consumption failed: " + use.failReason(), FailureType.UNKNOWN);
                yield TaskState.FAILED;
            }
            case RUNNING -> TaskState.RUNNING;
        };
    }

    private int countVariant(ItemStack variant) {
        if (variant.isEmpty()) return 0;
        int count = 0;
        var inventory = player.getInventory();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (ItemStack.isSameItemSameComponents(stack, variant)) count += stack.getCount();
        }
        return count;
    }

    @Override
    protected void cleanup() {
        try {
            if (use != null) use.stop();
        } finally {
            if (stopObservingCompletion != null) {
                stopObservingCompletion.run();
                stopObservingCompletion = null;
            }
        }
    }

    @Override
    protected Map<String, Object> resultData() {
        if (selectedStack.isEmpty()) return Map.of();
        Map<String, Object> data = new HashMap<>();
        data.put("item", BuiltInRegistries.ITEM.getKey(selectedStack.getItem()).toString());
        data.put("slot", selectedSlot);
        data.put("consumed_count", consumedCount);
        if (returnedContainers > 0) data.put("returned_container", Map.of(
                "item_id", BuiltInRegistries.ITEM.getKey(expectedContainer.getItem()).toString(),
                "count", returnedContainers));
        data.put("hp", player.getHealth());
        data.put("hunger", player.getFoodData().getFoodLevel());
        List<Map<String, Object>> effects = new ArrayList<>();
        for (var effect : player.getActiveEffects()) {
            effects.add(Map.of("effect_id", BuiltInRegistries.MOB_EFFECT.getKey(effect.getEffect().value()).toString(),
                    "amplifier", effect.getAmplifier(), "duration_ticks", effect.getDuration()));
        }
        data.put("active_effects", effects);
        return data;
    }

    @Override
    protected String successMessage() {
        return "consumed " + consumedCount + " " + BuiltInRegistries.ITEM.getKey(selectedStack.getItem());
    }

    @Override
    protected String timeoutMessage() {
        return "could not finish consuming " + r.label + "; verified partial state is retained";
    }

    @Override
    protected String cancelledMessage() {
        return "consumption interrupted; verified partial body and inventory state is retained";
    }
}
