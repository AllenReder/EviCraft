package dev.mcagent.runtime.bot;

import org.junit.jupiter.api.Test;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class AttributionJournalTest {
    @Test
    void partialTransfersAccumulateWithoutChangingAnEarlierSnapshot() {
        AttributionJournal journal = new AttributionJournal();
        UUID target = UUID.randomUUID();
        journal.pickup(target, 4, false);
        var before = journal.pickup(target);
        journal.pickup(target, 1, true);
        assertEquals(new RuntimeBotManager.AttributablePickup(4, false), before);
        assertEquals(new RuntimeBotManager.AttributablePickup(5, true), journal.pickup(target));
        assertEquals(1, journal.pickup(target).count() - before.count());
        assertNull(journal.pickup(UUID.randomUUID()));
        assertNull(new AttributionJournal().pickup(target));
    }

    @Test
    void readingDoesNotConsumeAnotherReadersReceipt() {
        AttributionJournal journal = new AttributionJournal();
        UUID target = UUID.randomUUID();
        journal.pickup(target, 3, true);
        assertEquals(journal.pickup(target), journal.pickup(target));
        assertEquals(3, journal.pickup(target).count());
    }

    @Test
    void boundedRetentionEvictsOldestReceipt() {
        AttributionJournal journal = new AttributionJournal();
        UUID first = UUID.randomUUID();
        journal.pickup(first, 1, true);
        UUID latest = null;
        for (int index = 0; index < 256; index++) {
            latest = UUID.randomUUID();
            journal.pickup(latest, 1, true);
        }
        assertNull(journal.pickup(first));
        assertEquals(1, journal.pickup(latest).count());
    }
}
