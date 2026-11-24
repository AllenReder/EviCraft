import { setTimeout as delay } from "node:timers/promises";

const WAIT_TICKS = 40;

/** A pause-when-idle World Run stands still until a wait or an action asks for game time, then stops again. */
export async function runSimulationSuspensionSmoke({ command, client }) {
  const gameTime = async (stage) => {
    const response = await command("time query gametime");
    const match = /(\d+)\D*$/u.exec(response);
    if (match === null) throw new Error(`${stage} game-time query was not numeric: ${response}`);
    return Number(match[1]);
  };
  const paused = async (stage) => {
    // The Runtime decides before each tick, so an idle World Run needs one tick interval to report it.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const info = await Promise.race([
        client.runtimeInfo(),
        delay(2_000).then(() => { throw new Error(`${stage} runtime.info timed out while paused`); }),
      ]);
      if (info.pause_when_idle !== true) throw new Error(`Runtime does not pause when idle: ${JSON.stringify(info)}`);
      if (info.simulation_suspended === true) return;
      await delay(50);
    }
    throw new Error(`${stage}: idle World Run did not pause`);
  };

  console.log("smoke: pause when idle");
  await paused("idle");
  const idleGameTime = await gameTime("idle");
  await delay(600);
  const frozenGameTime = await gameTime("idle window");
  if (frozenGameTime !== idleGameTime) {
    throw new Error(`game time advanced while the World Run was idle: ${JSON.stringify({ idleGameTime, frozenGameTime })}`);
  }

  const waited = await client.toolCall("wait", { ticks: WAIT_TICKS });
  if (waited.success !== true) throw new Error(`wait did not complete: ${JSON.stringify(waited)}`);
  await paused("after wait");
  const afterWait = await gameTime("after wait");
  if (afterWait - frozenGameTime !== WAIT_TICKS) {
    throw new Error(`wait advanced ${afterWait - frozenGameTime} ticks instead of ${WAIT_TICKS}`);
  }
  await delay(600);
  const pausedAgain = await gameTime("second idle window");
  if (pausedAgain !== afterWait) {
    throw new Error(`game time advanced after the wait ended: ${JSON.stringify({ afterWait, pausedAgain })}`);
  }
  return { idleGameTime, frozenGameTime, afterWait, pausedAgain };
}
