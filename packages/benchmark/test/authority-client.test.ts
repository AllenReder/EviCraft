import { once } from "node:events";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { BenchmarkAuthorityClient } from "../src/internal/authority/client.js";

describe("BenchmarkAuthorityClient", () => {
  it("requests evaluation facts and static advancement definitions without exposing them to ordinary snapshots", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const seen: unknown[] = [];
    server.on("connection", socket => socket.on("message", wire => {
      const request = JSON.parse(String(wire)) as { id: number; method: string; params: unknown };
      seen.push([request.method, request.params]);
      const receipt = { fence_sequence: seen.length, server_tick: 20, game_time: 20 };
      const result = request.method === "benchmark.advancement_definitions.get"
        ? { ...receipt, definitions: [{ id: "minecraft:story/root", criteria_names: ["crafted"], requirements: [["crafted"]] }] }
        : { ...receipt, actor: { present: false }, inventory: null, blocks: [], evaluation: {
          location: { status: "unavailable", reason: "actor_absent" },
          advancements: { status: "ok", value: [] },
          nearby_portals: { status: "unavailable", reason: "actor_absent" },
        } };
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    }));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing address");
    const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test" });
    try {
      await expect(client.getSnapshot({ actor: true, inventory: true, blocks: [], evaluation: true })).resolves.toMatchObject({
        evaluation: { location: { status: "unavailable", reason: "actor_absent" }, advancements: { status: "ok", value: [] } },
      });
      await expect(client.getAdvancementDefinitions()).resolves.toMatchObject({ definitions: [{ id: "minecraft:story/root", criteriaNames: ["crafted"], requirements: [["crafted"]] }] });
      expect(seen).toEqual([
        ["benchmark.snapshot.get", { actor: true, inventory: true, blocks: [], evaluation: true }],
        ["benchmark.advancement_definitions.get", {}],
      ]);
    } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("ignores malformed RPC envelopes without throwing from the websocket listener", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    server.on("connection", (socket) => socket.on("message", (wire) => {
      const { id } = JSON.parse(String(wire));
      for (const malformed of ["null", "[]", "false", "{", JSON.stringify({ id, result: null })]) socket.send(malformed);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: { present: false, fence_sequence: 1, server_tick: 2, game_time: 3 } }));
    }));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing address");
    const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", timeoutMs: 100 });
    try { await expect(client.getActor()).resolves.toMatchObject({ present: false }); }
    finally { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("times out unanswered RPCs and immediately rejects pending calls on close", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing address");
    const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", timeoutMs: 20 });
    try {
      await expect(client.info()).rejects.toThrow("timed out");
      const pending = client.info();
      await Promise.resolve();
      client.close();
      await expect(pending).rejects.toThrow("closed");
    } finally { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("accepts numeric dispatcher receipts and retains the absent actor receipt", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    server.on("connection", (socket) => {
      socket.on("message", (wire) => {
        const request = JSON.parse(String(wire)) as { id: number; method: string };
        const result = request.method === "benchmark.info"
          ? {
              protocol_version: 1,
              build_version: "probe",
              minecraft_version: "1.21.1",
              neoforge_version: "21.1.0",
              readiness: "ready",
              world_knowledge_profile: "grounded_evidence",
              grounded_block_expiry_ticks: 20,
              grounded_entity_expiry_ticks: 40,
              capabilities: ["actor.get@1"],
              fence_sequence: 7,
              server_tick: 11,
              game_time: 13,
            }
          : { present: false, fence_sequence: 8, server_tick: 12, game_time: 14 };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Authority test server has no TCP address");
    const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}/rpc`, bearerToken: "test-token" });
    try {
      await expect(client.info()).resolves.toMatchObject({ protocolVersion: 1, fenceSequence: 7, serverTick: 11, gameTime: 13 });
      await expect(client.getActor()).resolves.toEqual({ present: false, fenceSequence: 8, serverTick: 12, gameTime: 14 });
    } finally {
      client.close();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
    }
  });

  it("returns one receipt-bound actor, inventory, and block snapshot", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const wireSlots = Array.from({ length: 36 }, (_unused, slot) => slot === 0
      ? { slot, item: { item_id: "minecraft:iron_pickaxe", count: 1, durability: { remaining: 249, maximum: 250 }, components: "{minecraft:custom_name:'\"pick\"'}" } }
      : { slot, item: null });
    const expectedSlots = Array.from({ length: 36 }, (_unused, slot) => slot === 0
      ? { slot, item: { itemId: "minecraft:iron_pickaxe", count: 1, durability: { remaining: 249, maximum: 250 }, components: "{minecraft:custom_name:'\"pick\"'}" } }
      : { slot, item: null });
    server.on("connection", (socket) => {
      socket.on("message", (wire) => {
        const request = JSON.parse(String(wire)) as { id: number; method: string; params: unknown };
        expect(request.method).toBe("benchmark.snapshot.get");
        expect(request.params).toEqual({ actor: true, inventory: true, blocks: [{ dimension: "minecraft:overworld", x: 4, y: 65, z: -2 }] });
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            actor: {
              present: true,
              uuid: "bot-uuid",
              name: "bot",
              lifecycle: "alive",
              dimension: "minecraft:overworld",
              position: { x: 4.5, y: 65, z: -1.5 },
              yaw: 0,
              pitch: 0,
              health: 20,
              food: 20,
            },
            inventory: {
              selected_hotbar_slot: 0,
              slots: wireSlots,
              mainhand: { item_id: "minecraft:iron_pickaxe", count: 1, durability: { remaining: 249, maximum: 250 }, components: "{minecraft:custom_name:'\"pick\"'}" },
              offhand: null,
              armor: { head: null, chest: null, legs: null, feet: null },
            },
            blocks: [{ dimension: "minecraft:overworld", x: 4, y: 65, z: -2, block_state: "minecraft:chest[facing=north]" }],
            fence_sequence: 19,
            server_tick: 43,
            game_time: 81,
          },
        }));
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Authority test server has no TCP address");
    const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}/rpc`, bearerToken: "test-token" });
    try {
      await expect(client.getSnapshot({ actor: true, inventory: true, blocks: [{ dimension: "minecraft:overworld", x: 4, y: 65, z: -2 }] })).resolves.toEqual({
        actor: {
          present: true,
          uuid: "bot-uuid",
          name: "bot",
          lifecycle: "alive",
          dimension: "minecraft:overworld",
          position: { x: 4.5, y: 65, z: -1.5 },
          yaw: 0,
          pitch: 0,
          health: 20,
          food: 20,
        },
        inventory: {
          selectedHotbarSlot: 0,
          slots: expectedSlots,
          mainhand: { itemId: "minecraft:iron_pickaxe", count: 1, durability: { remaining: 249, maximum: 250 }, components: "{minecraft:custom_name:'\"pick\"'}" },
          offhand: null,
          armor: { head: null, chest: null, legs: null, feet: null },
        },
        blocks: [{ dimension: "minecraft:overworld", x: 4, y: 65, z: -2, blockState: "minecraft:chest[facing=north]" }],
        fenceSequence: 19,
        serverTick: 43,
        gameTime: 81,
      });
    } finally {
      client.close();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
    }
  });

  it("rejects malformed complete inventory slot projections", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const malformedSlots = [
      Array.from({ length: 35 }, (_unused, slot) => ({ slot, item: null })),
      Array.from({ length: 36 }, (_unused, slot) => ({ slot: slot === 7 ? 8 : slot, item: null })),
      Array.from({ length: 36 }, (_unused, slot) => slot === 7 ? { slot } : { slot, item: null }),
    ];
    let call = 0;
    server.on("connection", (socket) => {
      socket.on("message", (wire) => {
        const request = JSON.parse(String(wire)) as { id: number };
        const slots = malformedSlots[call++];
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            actor: { present: false },
            inventory: {
              selected_hotbar_slot: 0,
              slots,
              mainhand: null,
              offhand: null,
              armor: { head: null, chest: null, legs: null, feet: null },
            },
            blocks: [],
            fence_sequence: call,
            server_tick: 2,
            game_time: 3,
          },
        }));
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Authority test server has no TCP address");
    const client = await BenchmarkAuthorityClient.connect({ url: `ws://127.0.0.1:${address.port}/rpc`, bearerToken: "test-token" });
    try {
      await expect(client.getSnapshot({ actor: true, inventory: true, blocks: [] })).rejects.toThrow("inventory has invalid slots");
      await expect(client.getSnapshot({ actor: true, inventory: true, blocks: [] })).rejects.toThrow("inventory slot is invalid");
      await expect(client.getSnapshot({ actor: true, inventory: true, blocks: [] })).rejects.toThrow("inventory slot is invalid");
    } finally {
      client.close();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
    }
  });
});
