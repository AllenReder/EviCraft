import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { RuntimeClient } from "@evicraft/runtime-sdk";
import { afterEach, expect, test, vi } from "vitest";
import { intervene } from "../src/smoke/scenarios/shared.js";

const send = vi.hoisted(() => vi.fn());
vi.mock("../src/smoke/neoforge-server-process.js", () => ({ sendServerCommand: send }));
const directories: string[] = [];
afterEach(async () => {
  send.mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "scenario-intervention-"));
  directories.push(artifactsDirectory);
  const client = { toolCall: vi.fn(async () => ({ success: true, message: "waited" })) };
  return { context: { artifactsDirectory, client: client as unknown as RuntimeClient, server: {} as ChildProcess }, client };
}

test("lets ticks pass until the server has executed the intervention", async () => {
  const { context, client } = await fixture();
  let receipt = "";
  send.mockImplementation(async (_server, command: string) => { if (command.startsWith("say ")) receipt = command.slice(4); });
  // Console commands run inside a tick: the receipt appears only after the second tick.
  client.toolCall.mockImplementation(async () => {
    if (client.toolCall.mock.calls.length === 2) await appendFile(join(context.artifactsDirectory, "server.log"), receipt);
    return { success: true, message: "waited" };
  });
  await intervene(context, "prepare inventory", "item replace entity bot hotbar.0 with minecraft:cobblestone 8");
  expect(client.toolCall).toHaveBeenCalledTimes(2);
  expect(client.toolCall).toHaveBeenCalledWith("wait", { ticks: 1 });
  expect(await readFile(join(context.artifactsDirectory, "smoke-interventions.jsonl"), "utf8"))
    .toContain("prepare inventory");
});

test("reports a console that cannot take the intervention", async () => {
  const { context, client } = await fixture();
  send.mockRejectedValue(new Error("console closed"));
  await expect(intervene(context, "failed", "say fixture")).rejects.toThrow("console closed");
  expect(client.toolCall).not.toHaveBeenCalled();
});
