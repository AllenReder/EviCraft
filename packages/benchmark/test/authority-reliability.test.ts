import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { BenchmarkAuthorityClient } from "../src/internal/authority/client.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function authority(timeoutMs = 40, responseDelay?: number) {
  const events: Array<Readonly<Record<string, string | number>>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing address");
  server.on("connection", socket => socket.on("message", wire => {
    const request = JSON.parse(String(wire));
    if (responseDelay !== undefined) setTimeout(() => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { paused: true } })), responseDelay);
  }));
  const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "fixture-token", timeoutMs, handshakeTimeoutMs: 20, mirror: async event => { events.push(event); } });
  cleanups.push(async () => { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { client, server, events };
}

it("uses a distinct steady RPC deadline after a short handshake budget", async () => {
  const { client } = await authority(300, 70);
  await expect(client.isTimePaused()).resolves.toBe(true);
});

it("does not return success before a delayed sent audit failure is known", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", socket => socket.on("message", wire => socket.send(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(wire)).id, result: { paused: true } }))));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing address");
  const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", timeoutMs: 1000,
    mirror: async event => { if (event.type === "authority_sent") { await new Promise(resolve => setTimeout(resolve, 30)); throw new Error("sent audit failed"); } } });
  cleanups.push(async () => { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await expect(client.isTimePaused()).rejects.toThrow("sent audit failed");
});

it("cancels a response whose sent audit is still pending", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let responded!: () => void;
  const responseSent = new Promise<void>(resolve => { responded = resolve; });
  server.on("connection", socket => socket.on("message", wire => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(wire)).id, result: { paused: true } }), responded);
  }));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing address");
  const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", timeoutMs: 1000,
    mirror: async event => { if (event.type === "authority_sent") await gate; } });
  cleanups.push(async () => { release(); client.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const pending = client.isTimePaused();
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await responseSent;
  await new Promise(resolve => setTimeout(resolve, 20));
  client.close("cancelled");
  await rejected;
  release();
});

it("correlates timeout, late response and the next call without leaving pending requests", async () => {
  const { client, server, events } = await authority();
  const socket = [...server.clients][0]!;
  await expect(client.isTimePaused()).rejects.toThrow("timed out");
  const pending = client.isTimePaused();
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { paused: false } }));
  socket.on("message", wire => {
    const request = JSON.parse(String(wire));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { paused: true } }));
  });
  await expect(pending).resolves.toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ type: "authority_failure", request_id: 1, category: "timeout", pending: 0, timeout_ms: 40 }));
  expect(events).toContainEqual(expect.objectContaining({ type: "authority_receipt", request_id: 2, pending: 0 }));
  expect(new Set(events.map(event => event.connection_id)).size).toBe(1);
  expect(JSON.stringify(events)).not.toContain("fixture-token");
});

it("converges pending calls on Attempt cancellation and records the cancellation", async () => {
  const { client, events } = await authority(1000);
  const pending = client.isTimePaused();
  await Promise.resolve();
  client.close("cancelled");
  await expect(pending).rejects.toThrow("cancelled");
  expect(events).toContainEqual(expect.objectContaining({ type: "authority_failure", category: "cancelled", pending: 0 }));
});

it("aborts a connection that has not completed the WebSocket handshake", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing address");
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const controller = new AbortController();
  const pending = BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", signal: controller.signal, handshakeTimeoutMs: 2000 });
  const rejected = expect(pending).rejects.toThrow("cancel handshake");
  await once(server, "connection"); controller.abort(new Error("cancel handshake"));
  await rejected;
}, 1000);
