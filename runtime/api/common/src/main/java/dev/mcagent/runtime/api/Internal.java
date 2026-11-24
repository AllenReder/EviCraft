package dev.mcagent.runtime.api;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a type, member, or whole package as <strong>not</strong> part of the
 * public api module surface that tool packs build against. Internal code may
 * change or disappear in any release without notice — depend on it at your own
 * risk.
 *
 * <p>Inspired by Applied Energistics 2's convention of a clearly-delineated API
 * package: here the public API is the set of packages whose {@code package-info}
 * declares them so — the annotation-based authoring surface
 * ({@code dev.mcagent.runtime.agent.tool.api}), the tool contract / registration
 * ({@code dev.mcagent.runtime.agent.tool}), the world-action task contract
 * ({@code dev.mcagent.runtime.task}), and {@code BotPlayer} in
 * {@code dev.mcagent.runtime.entity}. Anything outside those packages — or marked
 * with this annotation inside them — is internal.
 */
@Documented
@Retention(RetentionPolicy.CLASS)
@Target({ElementType.TYPE, ElementType.METHOD, ElementType.CONSTRUCTOR,
        ElementType.FIELD, ElementType.PACKAGE})
public @interface Internal {
}
