package dev.mcagent.runtime.diagnostics;

import jdk.jfr.Category;
import jdk.jfr.Event;
import jdk.jfr.Label;
import jdk.jfr.Name;

/** Operator-only JFR timings; never serialized into Agent observation or tool output. */
@Name("mcagent.KnowledgePublication")
@Label("Runtime knowledge publication")
@Category("EviCraft Runtime")
@jdk.jfr.StackTrace(false)
public final class KnowledgePublicationEvent extends Event {
    public String profile;
    public long allocatedBytes;
}
