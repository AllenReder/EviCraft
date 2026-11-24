import { afterEach, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { BenchmarkAuthorityClient } from "../src/internal/authority/client.js";

const servers: WebSocketServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }))); });

function sample(elapsedTick: number) {
  return { elapsed_tick: elapsedTick, fence_sequence: elapsedTick + 1, server_tick: 500 + elapsedTick, game_time: elapsedTick,
    actor: { present: false }, inventory: null, blocks: [], actor_death_count: 0, portal_activation_count: 0 };
}

async function authority(onStart: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  const requests: unknown[] = [];
  server.on("connection", socket => socket.on("message", wire => {
    const request = JSON.parse(String(wire));
    requests.push(request);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { start_tick: 500, sample: sample(0), fence_sequence: 1, server_tick: 500, game_time: 0 } }));
    onStart(socket);
  }));
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");
  const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test" });
  return { client, requests };
}
const notify = (socket: WebSocket, method: string, params: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));

it("starts the run and yields the Runtime's samples in order until the run finishes", async () => {
  const { client, requests } = await authority(socket => {
    notify(socket, "benchmark.sample", sample(20));
    notify(socket, "benchmark.sample", sample(40));
    notify(socket, "benchmark.run.finished", { reason: "tick_budget", elapsed_tick: 40 });
  });
  const run = await client.startRun({ tickBudget: 40, sampleIntervalTicks: 20 });
  expect(requests).toEqual([expect.objectContaining({ method: "benchmark.run.start", params: { tick_budget: 40, sample_interval_ticks: 20 } })]);
  expect(run).toMatchObject({ startTick: 500, initial: { elapsedTick: 0, serverTick: 500 } });
  const received: number[] = [];
  for await (const next of run.samples()) received.push(next.elapsedTick);
  expect(received).toEqual([20, 40]);
  await expect(client.startRun({ tickBudget: 40, sampleIntervalTicks: 20 })).rejects.toThrow("already started");
  client.close();
});

it("ends the sample stream with an error when the connection is lost before the budget", async () => {
  const { client } = await authority(socket => { notify(socket, "benchmark.sample", sample(20)); setTimeout(() => socket.terminate(), 20); });
  const run = await client.startRun({ tickBudget: 400, sampleIntervalTicks: 20 });
  const received: number[] = [];
  await expect((async () => { for await (const next of run.samples()) received.push(next.elapsedTick); })()).rejects.toThrow(/closed/u);
  expect(received).toEqual([20]);
});

it("rejects a malformed sample instead of recording it", async () => {
  const { client } = await authority(socket => notify(socket, "benchmark.sample", { ...sample(20), elapsed_tick: -1 }));
  const run = await client.startRun({ tickBudget: 400, sampleIntervalTicks: 20 });
  await expect(run.samples()[Symbol.asyncIterator]().next()).rejects.toThrow("invalid elapsed tick");
  client.close();
});
