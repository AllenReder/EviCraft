package dev.mcagent.runtime.core.pathing.moves;

/**
 * Input keys a movement primitive can request. The execution layer maps these abstract keys onto the
 * entity's input fields (zza/xxa/jump/sneak/sprint) and left/right click actions.
 */
public enum Input {
    MOVE_FORWARD,
    MOVE_BACK,
    MOVE_LEFT,
    MOVE_RIGHT,
    JUMP,
    SNEAK,
    SPRINT,
    CLICK_LEFT,
    CLICK_RIGHT
}
