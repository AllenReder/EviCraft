/**
 * Items: equip, drop, eat, take, transfer, recipe lookup, crafting. Bounded short actions that change the
 * Bot's own inventory go through enqueue and wait for the result; recipe lookup and crafting complete in
 * place. See the {@link dev.mcagent.runtime.core.tools} package docs for the four questions.
 */
package dev.mcagent.runtime.core.tools.inventory;
