/**
 * <strong>Public API:</strong> {@link BotPlayer} — the server-side bot
 * body a tool acts on (query its state, drive it, read its inventory) — and
 * {@link InputDriver}, its input surface (look at, press keys, halt): together
 * they are how a tool pack moves the body without touching engine internals.
 *
 * <p>The rest of this package is {@link dev.mcagent.runtime.api.Internal @Internal}:
 * bot lifecycle, fresh body creation ({@link BotFactory}) and the
 * fake network connection ({@link FakeConnection}).
 */
package dev.mcagent.runtime.entity;
