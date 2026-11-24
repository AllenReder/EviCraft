import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertScenarioOracle, assertPausedScenarioOracle } from "../src/smoke/scenarios/shared.js";
import { rconPacket, runtimeCommand } from "../src/smoke/rcon.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function setup(passes: boolean) {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "scenario-oracle-")); directories.push(artifactsDirectory);
  const oracle = { executeMinecraftCommand: vi.fn(async (command: string) => passes ? (command.includes(" run say ") ? "" : "Test passed") : "Test failed") };
  return { artifactsDirectory, oracle };
}
describe("test-owned Scenario Oracle", () => {
  it("keeps a Bot-free fixture Oracle paused with equal game-time receipts", async () => {
    const context = await setup(true);
    const commands: string[] = [];
    context.oracle.executeMinecraftCommand.mockImplementation(async command => {
      commands.push(command);
      return command === "time query gametime" ? "The time is 137" : "Test passed";
    });
    const client = {
      runtimeInfo: vi.fn(async () => ({ simulation_suspended: true })) };
    const receipt = await assertPausedScenarioOracle({ ...context, client }, "fixture", "execute if block 1 2 3 minecraft:emerald_block");
    expect(receipt).toEqual({ before: { simulation_suspended: true, game_time: 137 }, after: { simulation_suspended: true, game_time: 137 } });
    expect(commands[0]).toBe("time query gametime"); expect(commands.at(-1)).toBe("time query gametime");
    expect(JSON.parse(await readFile(join(context.artifactsDirectory, "oracle-pause-receipts.jsonl"), "utf8"))).toMatchObject({ label: "fixture", ...receipt });
  });
  it("rejects an Oracle that advanced game time even when the predicate succeeded", async () => {
    const context = await setup(true);
    let reads = 0;
    context.oracle.executeMinecraftCommand.mockImplementation(async command => command === "time query gametime"
      ? `The time is ${137 + reads++}` : "Test passed");
    const client = {
      runtimeInfo: vi.fn(async () => ({ simulation_suspended: true })) };
    await expect(assertPausedScenarioOracle({ ...context, client }, "fixture", "execute if block 1 2 3 minecraft:emerald_block")).rejects.toThrow("advanced game time or resumed simulation");
  });
  it("evaluates a paused-world predicate with an executed-command receipt and no simulation resume", async () => {
    const context = await setup(true);
    const predicate = "execute if block 1 2 3 minecraft:emerald_block";
    await assertScenarioOracle(context, "marker intact", predicate);
    expect(context.oracle.executeMinecraftCommand).toHaveBeenCalledExactlyOnceWith(predicate);
    const receipt = JSON.parse(await readFile(join(context.artifactsDirectory, "oracle-receipts.jsonl"), "utf8"));
    expect(receipt).toMatchObject({ label: "marker intact", predicate, verdict: "pass" });
    expect(receipt.response).toBe("Test passed");
  });
  it("reports a false world predicate immediately and preserves its actual response", async () => {
    const context = await setup(false);
    await expect(assertScenarioOracle(context, "target absent", "execute unless entity @e[type=minecraft:zombie]")).rejects.toThrow("Scenario Oracle predicate failed: target absent");
    expect(JSON.parse(await readFile(join(context.artifactsDirectory, "oracle-receipts.jsonl"), "utf8"))).toMatchObject({ verdict: "fail", response: "Test failed" });
  });
  it.each(["", "That position is not loaded", "Test failed", "Test passed, count: 0"])("rejects a non-successful actual RCON response: %j", async response => {
    const context = await setup(true);
    context.oracle.executeMinecraftCommand.mockResolvedValue(response);
    await expect(assertScenarioOracle(context, "fixture", "execute if block 1 2 3 minecraft:stone")).rejects.toThrow("Scenario Oracle predicate failed");
  });
  it("accepts vanilla positive entity count feedback", async () => {
    const context = await setup(true);
    context.oracle.executeMinecraftCommand.mockResolvedValue("Test passed, count: 1\n");
    await expect(assertScenarioOracle(context, "distractor", "execute if entity @e[type=minecraft:zombie]")).resolves.toBeUndefined();
  });
  it("does not turn a transport failure into a false-predicate or success result", async () => {
    const context = await setup(true);
    const failure = new Error("RCON disconnected");
    context.oracle.executeMinecraftCommand.mockRejectedValue(failure);
    await expect(assertScenarioOracle(context, "marker", "execute if block 0 0 0 stone")).rejects.toBe(failure);
  });
  it("reuses the existing authenticated RCON protocol and waits for a fragmented response", async () => {
    const received: string[] = [];
    const server = createServer(socket => {
      let buffered = Buffer.alloc(0);
      socket.on("data", bytes => {
        buffered = Buffer.concat([buffered, bytes]);
        while (buffered.length >= 4 && buffered.length >= buffered.readInt32LE(0) + 4) {
          const length = buffered.readInt32LE(0);
          const id = buffered.readInt32LE(4), type = buffered.readInt32LE(8);
          const body = buffered.subarray(12, length + 2).toString();
          buffered = buffered.subarray(length + 4);
          received.push(body);
          const response = rconPacket(id, type === 3 ? 2 : 0, type === 3 ? "" : "Test passed\n");
          socket.write(response.subarray(0, 6));
          setTimeout(() => socket.write(response.subarray(6)), 5);
        }
      });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test listener");
    try {
      await expect(runtimeCommand({ rconPort: address.port, rconPassword: "test-password" }, "execute if block 1 2 3 minecraft:stone")).resolves.toBe("Test passed\n");
      expect(received).toEqual(["test-password", "execute if block 1 2 3 minecraft:stone"]);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
