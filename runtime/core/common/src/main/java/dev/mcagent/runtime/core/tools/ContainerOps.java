package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskResult;
import com.google.gson.annotations.SerializedName;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.ResultSlot;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

import java.util.List;
import java.util.ArrayList;
import java.util.Map;

/**
 * Container-GUI tool implementation — the business half of {@code TransferTool}:
 * {@code transfer} moves stacks between the open container menu and the backpack,
 * one {@link Move} per slot-to-slot step.
 */
public final class ContainerOps {

    /** One transfer; its @Arg components become the {@code moves} array item schema. */
    public record Move(
int from,
Integer to,
Integer count) {}

    public record MoveReceipt(
            int from,
            int to,
            String item_id,
            Integer requested_count,
            int moved_count,
            MoveOutcome outcome) {}

    public enum MoveOutcome {
        @SerializedName("moved") MOVED,
        @SerializedName("partial") PARTIAL,
        @SerializedName("rejected") REJECTED,
        @SerializedName("no_op") NO_OP
    }

    private record StepResult(String message, MoveReceipt receipt) {}

    public String transfer(
            Integer expectedMenuId,
            Integer expectedMenuRevision,
            List<Move> moves,
            BotPlayer self) {
        AbstractContainerMenu menu = self.containerMenu;
        if (menu == null || menu == self.inventoryMenu) {
            return TaskResult.fail("no block menu is open", "menu_not_open").toJson();
        }
        if (expectedMenuId == null || expectedMenuRevision == null
                || menu.containerId != expectedMenuId || menu.getStateId() != expectedMenuRevision) {
            return TaskResult.fail("the open menu changed since inspect_gui", "menu_changed", Map.of(
                    "menu_id", menu.containerId,
                    "menu_revision", menu.getStateId())).toJson();
        }
        if (moves == null || moves.isEmpty()) {
            throw new IllegalArgumentException("moves must contain at least one transfer");
        }
        for (Move move : moves) {
            if (move == null) {
                throw new IllegalArgumentException("moves must not contain null entries");
            }
            if (move.count() != null && move.count() < 1) {
                throw new IllegalArgumentException("count must be at least 1 when provided");
            }
        }

        int max = menu.slots.size() - 1;
        StringBuilder out = new StringBuilder();
        List<MoveReceipt> receipts = new ArrayList<>();
        int beforeRevision = menu.getStateId();
        int step = 0;
        for (Move m : moves) {
            step++;
            int from = m.from();
            Integer to = m.to();
            Integer count = m.count();

            out.append(step).append(". ");
            if (from < 0 || from > max) {
                out.append("from slot ").append(from).append(" OUT OF RANGE (0..").append(max)
                        .append(") — skipped; inspect_gui for indices.\n");
                continue;
            }
            if (to != null && (to < 0 || to > max)) {
                out.append("to slot ").append(to).append(" OUT OF RANGE (0..").append(max)
                        .append(") — skipped; inspect_gui for indices.\n");
                continue;
            }
            try {
                StepResult result = to == null ? route(menu, self, from, count)
                                               : place(menu, self, from, to, count);
                out.append(result.message());
                if (result.receipt() != null) receipts.add(result.receipt());
            } catch (RuntimeException ex) {
                out.append("slot ").append(from).append(" — ERROR: ").append(ex.getMessage())
                        .append(" (earlier transfers already applied).");
            }
            out.append("\n");
        }
        if (receipts.stream().anyMatch(receipt -> receipt.moved_count() > 0)) {
            menu.incrementStateId();
        }
        return TaskResult.ok(out.toString().stripTrailing(), Map.of(
                "menu_id", menu.containerId,
                "before_revision", beforeRevision,
                "after_revision", menu.getStateId(),
                "moves", receipts)).toJson();
    }

    /** No destination: shift the whole stack to the other section, menu-routed (deposit/take/feed). */
    private static StepResult route(AbstractContainerMenu menu, BotPlayer entity, int from, Integer count) {
        ItemStack before = menu.slots.get(from).getItem().copy();
        if (before.isEmpty()) {
            if (menu.slots.get(from) instanceof ResultSlot) {
                // Empty crafting result = the grid doesn't form a valid recipe (usually a mis-placed
                // 2x2 layout). Point the model back at the recipe so it self-corrects.
                return new StepResult("slot " + from + " (crafting result) is empty — the grid doesn't form a valid "
                        + "recipe yet. Call lookup_recipe for the exact layout, then inspect_gui and match "
                        + "it onto the grid cell-for-cell (a smaller recipe goes top-left; 2x2 slot "
                        + "indices are easy to guess wrong).", null);
            }
            return new StepResult("slot " + from + " is empty — nothing to move.", null);
        }
        menu.clicked(from, 0, ClickType.QUICK_MOVE, entity);
        ItemStack after = menu.slots.get(from).getItem();
        int moved = before.getCount() - (sameItem(before, after) ? after.getCount() : 0);
        String note = (count != null) ? " (count ignored — routing moves the whole stack; give `to` "
                + "for an exact amount)" : "";
        if (moved <= 0) {
            return new StepResult("slot " + from + " (" + name(before)
                    + ") didn't move — the other section is full or won't accept it." + note, null);
        }
        return new StepResult("routed " + moved + " " + name(before) + " from slot " + from
                + " to the other section (deposit/take/feed)."
                + (after.isEmpty() ? "" : " " + after.getCount() + " left in slot " + from + ".")
                + note, null);
    }

    /** A destination slot: place exactly there — empty→move, same item→merge, different item→swap. */
    private static StepResult place(AbstractContainerMenu menu, BotPlayer entity, int from, int to, Integer count) {
        if (from == to) {
            ItemStack item = menu.slots.get(from).getItem();
            return step("slot " + from + " → itself — nothing to do.", from, to, item, count, 0,
                    MoveOutcome.NO_OP);
        }
        ItemStack fromBefore = menu.slots.get(from).getItem().copy();
        ItemStack toBefore = menu.slots.get(to).getItem().copy();
        if (fromBefore.isEmpty()) {
            return step("slot " + from + " is empty — nothing to move.", from, to,
                    fromBefore, count, 0, MoveOutcome.NO_OP);
        }

        boolean exact = count != null && count > 0;
        boolean differentItem = !toBefore.isEmpty() && !sameItem(toBefore, fromBefore);

        if (exact && differentItem) {
            return step("can't move " + count + " from slot " + from + " — slot " + to + " holds "
                    + name(toBefore) + ". Omit count to swap the whole stacks instead.",
                    from, to, fromBefore, count, 0, MoveOutcome.REJECTED);
        }

        if (exact) {
            int want = count;
            if (fromBefore.getCount() < want) {
                return step("can't move " + want + " from slot " + from + " — source holds only "
                        + fromBefore.getCount() + ".", from, to, fromBefore, count, 0,
                        MoveOutcome.REJECTED);
            }
            Slot source = menu.slots.get(from);
            Slot target = menu.slots.get(to);
            int room = target.getMaxStackSize(fromBefore) - toBefore.getCount();
            if (!source.mayPickup(entity)) {
                return step("can't move " + want + " from slot " + from + " — source refused pickup.",
                        from, to, fromBefore, count, 0, MoveOutcome.REJECTED);
            }
            if (!target.mayPlace(fromBefore)) {
                return step("slot " + from + " → " + to + ": nothing moved — slot " + to
                        + " refused it (output-only slot?).", from, to, fromBefore, count, 0,
                        MoveOutcome.REJECTED);
            }
            if (room < want) {
                return step("slot " + from + " → " + to + ": nothing moved — slot " + to
                        + " has room for only " + Math.max(0, room) + ".",
                        from, to, fromBefore, count, 0, MoveOutcome.REJECTED);
            }
            ItemStack taken = source.safeTake(want, Integer.MAX_VALUE, entity);
            int takenCount = taken.getCount();
            ItemStack remainder = target.safeInsert(taken, want);
            int accepted = takenCount - remainder.getCount();
            if (!remainder.isEmpty()) source.safeInsert(remainder);
            MoveOutcome outcome = accepted == want ? MoveOutcome.MOVED
                    : accepted == 0 ? MoveOutcome.REJECTED : MoveOutcome.PARTIAL;
            ItemStack fromAfter = menu.slots.get(from).getItem();
            ItemStack toAfter = menu.slots.get(to).getItem();
            String message = accepted == want
                    ? (toBefore.isEmpty() ? "moved " : "merged ") + accepted + " " + name(fromBefore)
                        + " from slot " + from + " to slot " + to + " (slot " + to + " now "
                        + toAfter.getCount() + (fromAfter.isEmpty() ? "; slot " + from + " emptied)."
                        : "; " + fromAfter.getCount() + " left in slot " + from + ").")
                    : "slot " + from + " → " + to + ": " + accepted + " of " + want + " moved.";
            return step(message, from, to, fromBefore, count, accepted, outcome);
        } else {
            menu.clicked(from, 0, ClickType.PICKUP, entity);          // grab the stack
            menu.clicked(to, 0, ClickType.PICKUP, entity);            // place / merge / swap
            if (!menu.getCarried().isEmpty()) {
                menu.clicked(from, 0, ClickType.PICKUP, entity);      // settle leftover / swapped item back
            }
        }

        ItemStack fromAfter = menu.slots.get(from).getItem();
        ItemStack toAfter = menu.slots.get(to).getItem();
        int moved = fromBefore.getCount() - (sameItem(fromBefore, fromAfter) ? fromAfter.getCount() : 0);

        if (differentItem) {     // whole-stack onto a different item = swap
            if (sameItem(toAfter, fromBefore) && sameItem(fromAfter, toBefore)) {
                return new StepResult("swapped slot " + from + " (" + name(fromBefore)
                        + ") ⇄ slot " + to + " (" + name(toBefore) + ").", null);
            }
            return new StepResult("slot " + from + " → " + to + ": nothing moved — slot " + to
                    + " refused it (output-only slot?).", null);
        }
        if (moved <= 0) {
            return new StepResult("slot " + from + " → " + to + ": nothing moved — slot " + to
                    + (toBefore.isEmpty() ? " refused it (output-only slot?)." : " is already full."), null);
        }
        String verb = toBefore.isEmpty() ? "moved " : "merged ";
        return new StepResult(verb + moved + " " + name(fromBefore) + " from slot " + from + " to slot " + to
                + " (slot " + to + " now " + toAfter.getCount()
                + (fromAfter.isEmpty() ? "; slot " + from + " emptied)." : "; " + fromAfter.getCount()
                + " left in slot " + from + ")."), null);
    }

    private static StepResult step(String message, int from, int to, ItemStack item,
                                   Integer requested, int moved, MoveOutcome outcome) {
        return new StepResult(message, new MoveReceipt(from, to,
                item.isEmpty() ? "minecraft:air" : BuiltInRegistries.ITEM.getKey(item.getItem()).toString(),
                requested, moved, outcome));
    }

    private static boolean sameItem(ItemStack a, ItemStack b) {
        return ItemStack.isSameItemSameComponents(a, b);
    }

    private static String name(ItemStack stack) {
        return stack.isEmpty() ? "nothing" : BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
    }
}
