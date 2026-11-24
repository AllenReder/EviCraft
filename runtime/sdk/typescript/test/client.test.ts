import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { RuntimeClient, RuntimeSdkTimeoutError, type RuntimeInfo } from "../src/index.js";

const loadedRuntimeInfo: RuntimeInfo = {
  protocol_version: 4,
  build_version: "0.1.1",
  minecraft_version: "1.21.1",
  neoforge_version: "21.1.233",
  readiness: "ready",
  world_knowledge_profile: "loaded_world_state",
  grounded_block_expiry_ticks: 600,
  grounded_entity_expiry_ticks: 200,
  simulation_suspended: false,
  pause_when_idle: false,
};

describe("RuntimeClient", () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  });

  it("authenticates and calls the two tracer methods", async () => {
    server = new WebSocketServer({ port: 0, path: "/rpc" });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing test port");
    const blockFindParams: Array<Record<string, unknown>> = [];
    let entityListParams: Record<string, unknown> | undefined;

    server.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer sdk-secret");
      expect(request.headers["sec-websocket-protocol"]).toBeUndefined();
      socket.on("message", (wire) => {
        const rpc = JSON.parse(wire.toString()) as { id: number; method: string; params: Record<string, unknown> };
        if (rpc.method === "knowledge.query" && rpc.params.operation === "block.find") {
          blockFindParams.push(rpc.params);
        }
        if (rpc.method === "knowledge.query" && rpc.params.operation === "entity.list") {
          entityListParams = rpc.params;
        }
        const result = rpc.method === "runtime.info"
          ? loadedRuntimeInfo
          : rpc.method === "actor.get"
            ? { uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d", name: "bot", lifecycle_state: "alive", observation_revision: 0 }
            : rpc.method === "observation.observe"
              ? { observation_revision: 1, server_tick: 0, game_time: 400 }
            : rpc.method === "knowledge.query"
              ? rpc.params.operation === "entity.get"
                ? {
                    operation: "entity.get",
                    track: {
                      uuid: "00000000-0000-0000-0000-000000000243",
                      dimension: "minecraft:overworld",
                      entity_id: "minecraft:zombie",
                      position: { x: 2.5, y: 64, z: 3.5 },
                      state: "KNOWN",
                      source: "vision",
                      observed_tick: 100,
                      observation_revision: 7,
                    },
                  }
                : rpc.params.operation === "entity.list"
                  ? {
                      operation: "entity.list",
                      tracks: [{
                        uuid: "00000000-0000-0000-0000-000000000244",
                        dimension: "minecraft:overworld",
                        entity_id: "minecraft:item",
                        item_id: "minecraft:diamond",
                        item_count: 2,
                        position: { x: 4, y: 65, z: 6 },
                        state: "VISIBLE",
                        source: "vision",
                        observed_tick: 120,
                        observation_revision: 9,
                      }],
                      has_more: false,
                    }
                  : rpc.params.operation === "block.find"
                ? {
                    operation: "block.find",
                    matches: [{
                      dimension: "minecraft:overworld",
                      position: { x: 11, y: 12, z: -3 },
                      state: "KNOWN_BLOCK",
                      block_state: "minecraft:diamond_ore",
                      fluid: "minecraft:empty",
                      source: "vision",
                      observed_tick: 120,
                      observation_revision: 9,
                    }],
                    has_more: false,
                    complete: false,
                  }
                : rpc.params.operation === "block.region"
                  ? {
                      operation: "block.region",
                      dimension: "minecraft:overworld",
                      min: { x: 10, y: 64, z: -3 },
                      size: { x: 2, y: 1, z: 1 },
                      palette: [
                        { state: "UNKNOWN" },
                        {
                          state: "KNOWN_BLOCK",
                          block_state: "minecraft:stone",
                          fluid: "minecraft:empty",
                          source: "vision",
                          observed_tick: 120,
                          observation_revision: 9,
                        },
                      ],
                      indices: [1, 0],
                      complete: false,
                    }
                  : {
                  operation: "block.get",
                  cells: [
                    { dimension: "minecraft:overworld", position: { x: 10, y: 64, z: -3 }, state: "UNKNOWN" },
                    {
                      dimension: "minecraft:overworld",
                      position: { x: 11, y: 64, z: -3 },
                      state: "KNOWN_BLOCK",
                      block_state: "minecraft:stone",
                      fluid: "minecraft:empty",
                      source: "vision",
                      observed_tick: 120,
                      observation_revision: 9,
                    },
                  ],
                    }
            : rpc.method === "tool.list"
              ? { tools: [{ name: "get_world_info", description: "Read world status", parameters: { type: "object" } }] }
              : rpc.method === "runtime.time.await_tick"
                ? { server_tick: 40 }
                : { success: true, message: "world status", data: { dimension: "minecraft:overworld" } };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      });
    });

    const client = await RuntimeClient.connect({
      url: `ws://127.0.0.1:${address.port}/rpc`,
      bearerToken: "sdk-secret",
    });

    await expect(client.runtimeInfo()).resolves.toMatchObject({
      protocol_version: 4,
      readiness: "ready",
      world_knowledge_profile: "loaded_world_state",
      grounded_block_expiry_ticks: 600,
      grounded_entity_expiry_ticks: 200,
    });
    await expect(client.actorGet()).resolves.toMatchObject({ name: "bot", lifecycle_state: "alive" });
    await expect(client.afterTicks(20)).resolves.toEqual({ server_tick: 40 });
    await expect(client.observe()).resolves.toEqual({ observation_revision: 1, server_tick: 0, game_time: 400 });
    await expect(client.blockGet("minecraft:overworld", [
      { x: 10, y: 64, z: -3 },
      { x: 11, y: 64, z: -3 },
    ])).resolves.toMatchObject({
      operation: "block.get",
      cells: [
        { state: "UNKNOWN" },
        { state: "KNOWN_BLOCK", block_state: "minecraft:stone", observation_revision: 9 },
      ],
    });
    await expect(client.blockFind("minecraft:overworld", "minecraft:*_ore", {
      origin: { x: 124, y: 79, z: 153 },
      limit: 32,
    }))
      .resolves.toMatchObject({
        operation: "block.find",
        matches: [{ state: "KNOWN_BLOCK", block_state: "minecraft:diamond_ore" }],
        has_more: false,
        complete: false,
      });
    expect(blockFindParams).toEqual([{
      operation: "block.find",
      dimension: "minecraft:overworld",
      block_id_glob: "minecraft:*_ore",
      origin: { x: 124, y: 79, z: 153 },
      limit: 32,
    }]);
    await expect(client.blockRegion("minecraft:overworld",
      { x: 10, y: 64, z: -3 }, { x: 11, y: 64, z: -3 })).resolves.toMatchObject({
      operation: "block.region",
      size: { x: 2, y: 1, z: 1 },
      indices: [1, 0],
      complete: false,
    });
    await expect(client.entityGet("00000000-0000-0000-0000-000000000243"))
      .resolves.toMatchObject({
        operation: "entity.get",
        track: { entity_id: "minecraft:zombie", state: "KNOWN" },
      });
    await expect(client.entityList({
      dimension: "minecraft:overworld",
      entityIdGlob: "minecraft:item",
      itemIdGlob: "minecraft:diamond",
    })).resolves.toMatchObject({
      operation: "entity.list",
      tracks: [{ entity_id: "minecraft:item", item_id: "minecraft:diamond", state: "VISIBLE" }],
      has_more: false,
    });
    expect(entityListParams).toEqual({
      operation: "entity.list",
      dimension: "minecraft:overworld",
      entity_id_glob: "minecraft:item",
      item_id_glob: "minecraft:diamond",
    });
    await expect(client.toolList()).resolves.toEqual({
      tools: [{ name: "get_world_info", description: "Read world status", parameters: { type: "object" } }],
    });
    await expect(client.toolCall("get_world_info", {})).resolves.toMatchObject({
      success: true,
      data: { dimension: "minecraft:overworld" },
    });
    client.close();
  });

  it("reports an authenticated handshake rejection", async () => {
    server = new WebSocketServer({
      port: 0,
      path: "/rpc",
      verifyClient: (_info, done) => done(false, 401, "Unauthorized"),
    });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing test port");

    await expect(RuntimeClient.connect({
      url: `ws://127.0.0.1:${address.port}/rpc`,
      bearerToken: "wrong",
    })).rejects.toThrow("HTTP 401");
  });

  it("exposes the JSON-RPC request id as a cancellable task id", async () => {
    server = new WebSocketServer({ port: 0, path: "/rpc" });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing test port");

    let gotoId: number | undefined;
    server.on("connection", (socket) => {
      socket.on("message", (wire) => {
        const rpc = JSON.parse(wire.toString()) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        if (rpc.method === "tool.call") {
          gotoId = rpc.id;
          return;
        }
        expect(rpc.method).toBe("task.cancel");
        expect(rpc.params.task_id).toBe(gotoId);
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { task_id: gotoId, cancelled: true },
        }));
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: gotoId,
          result: { success: false, message: "cancelled", interrupted: true },
        }));
      });
    });

    const client = await RuntimeClient.connect({
      url: `ws://127.0.0.1:${address.port}/rpc`,
      bearerToken: "sdk-secret",
    });
    const task = client.startToolCall("goto", { x: 4, z: 9 });

    await expect(client.taskCancel(task.taskId)).resolves.toEqual({
      task_id: task.taskId,
      cancelled: true,
    });
    await expect(task.result).resolves.toMatchObject({ interrupted: true });
    client.close();
  });

  it("creates or connects the singleton Bot through ensureBot", async () => {
    server = new WebSocketServer({ port: 0, path: "/rpc" });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing test port");

    let actor: { uuid: string; name: string; lifecycle_state: "alive"; observation_revision: number } | null = null;
    const methods: string[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (wire) => {
        const rpc = JSON.parse(wire.toString()) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        methods.push(rpc.method);
        if (rpc.method === "actor.create") {
          actor = {
            uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d",
            name: String(rpc.params.username),
            lifecycle_state: "alive",
            observation_revision: 1,
          };
        }
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: actor }));
      });
    });

    const client = await RuntimeClient.connect({
      url: `ws://127.0.0.1:${address.port}/rpc`,
      bearerToken: "sdk-secret",
    });

    await expect(client.ensureBot("HarnessBot")).resolves.toMatchObject({
      name: "HarnessBot",
      lifecycle_state: "alive",
    });
    await expect(client.ensureBot("harnessbot")).resolves.toMatchObject({ name: "HarnessBot" });
    await expect(client.ensureBot("OtherBot")).rejects.toThrow(/already exists.*HarnessBot/i);
    expect(methods).toEqual(["actor.get", "actor.create", "actor.get", "actor.get"]);
    client.close();
  });

  it("validates exact break occlusion data from the Runtime Tool wire", async () => {
    server = new WebSocketServer({ port: 0, path: "/rpc" });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing test port");

    let calls = 0;
    server.on("connection", (socket) => {
      socket.on("message", (wire) => {
        const rpc = JSON.parse(wire.toString()) as { id: number; method: string };
        calls += 1;
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: rpc.id,
          result: calls === 1
            ? {
                success: false,
                message: "native first hit is a blocker",
                data: {
                  position: { x: 4, y: 64, z: -2 },
                  failure_type: "occluded",
                  occluding_block: {
                    position: { x: 3, y: 64, z: -2 },
                    block_state: "minecraft:oak_leaves[persistent=true]",
                  },
                },
              }
            : {
                success: false,
                message: "native first hit is a blocker",
                data: {
                  position: { x: 4, y: 64, z: -2 },
                  failure_type: "occluded",
                  occluding_block: { position: { x: 3, y: 64, z: -2 }, block_state: 7 },
                },
              },
        }));
      });
    });

    const client = await RuntimeClient.connect({
      url: `ws://127.0.0.1:${address.port}/rpc`, bearerToken: "sdk-secret",
    });
    const args = { position: { x: 4, y: 64, z: -2 } };
    await expect(client.toolCall("break_block", args)).resolves.toMatchObject({
      success: false,
      data: {
        failure_type: "occluded",
        occluding_block: {
          position: { x: 3, y: 64, z: -2 },
          block_state: "minecraft:oak_leaves[persistent=true]",
        },
      },
    });
    await expect(client.toolCall("break_block", args)).rejects.toThrow(/exact break result/i);
    client.close();
  });

  it("parses complete body changes and damage in wire order beside ordinary RPC responses", async () => {
    server = new WebSocketServer({ port: 0, path: "/rpc" });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing test port");

    server.on("connection", (socket) => {
      socket.on("message", (wire) => {
        const rpc = JSON.parse(wire.toString()) as { id: number; method: string };
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "runtime.occurrence",
          params: {
            type: "body_state_changed",
            sequence: 7,
            server_tick: 120,
            data: {
              health: 18,
              max_health: 20,
              air: 80,
              max_air: 300,
              underwater: true,
              in_lava: false,
              on_fire: false,
              suffocating: true,
              intersecting_blocks: [{ x: 4, y: 65, z: -2 }],
            },
          },
        }));
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "runtime.occurrence",
          params: {
            type: "damage_received",
            sequence: 8,
            server_tick: 120,
            data: {
              amount: 1,
              health: 18,
              max_health: 20,
              damage_type: "minecraft:in_wall",
            },
          },
        }));
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "runtime.occurrence",
          params: {
            type: "actor_lifecycle_changed",
            sequence: 9,
            server_tick: 121,
            data: {
              uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d",
              name: "bot",
              lifecycle_state: "alive",
            },
          },
        }));
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocol_version: 4,
            build_version: "test",
            minecraft_version: "1.21.1",
            neoforge_version: "21.1.233",
            readiness: "ready",
            grounded_block_expiry_ticks: 600,
            grounded_entity_expiry_ticks: 200,
          },
        }));
      });
    });

    const client = await RuntimeClient.connect({
      url: `ws://127.0.0.1:${address.port}/rpc`,
      bearerToken: "sdk-secret",
    });
    const occurrences: unknown[] = [];
    const received = new Promise<void>((resolve) => client.onOccurrence((occurrence) => {
      occurrences.push(occurrence);
      if (occurrences.length === 3) resolve();
    }));
    const disconnected = new Promise<Error>((resolve) => client.onDisconnect(resolve));

    await expect(client.runtimeInfo()).resolves.toMatchObject({ readiness: "ready" });
    await received;
    expect(occurrences).toEqual([{
      type: "body_state_changed",
      sequence: 7,
      server_tick: 120,
      data: {
        health: 18,
        max_health: 20,
        air: 80,
        max_air: 300,
        underwater: true,
        in_lava: false,
        on_fire: false,
        suffocating: true,
        intersecting_blocks: [{ x: 4, y: 65, z: -2 }],
      },
    }, {
      type: "damage_received",
      sequence: 8,
      server_tick: 120,
      data: {
        amount: 1,
        health: 18,
        max_health: 20,
        damage_type: "minecraft:in_wall",
      },
    }, {
      type: "actor_lifecycle_changed",
      sequence: 9,
      server_tick: 121,
      data: {
        uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d",
        name: "bot",
        lifecycle_state: "alive",
      },
    }]);
    client.close();
    await expect(disconnected).resolves.toMatchObject({ message: "Runtime SDK connection closed" });
  });

  for (const [label, params] of [
    ["unknown occurrence type", {
      type: "body_status", sequence: 9, server_tick: 121, data: {},
    }],
    ["invalid occurrence fields", {
      type: "damage_received", sequence: 9, server_tick: 121,
      data: { amount: 1, health: 17, max_health: 20 },
    }],
    ["policy-bearing body field", {
      type: "body_state_changed", sequence: 9, server_tick: 121,
      data: {
        health: 17, max_health: 20, air: 80, max_air: 300,
        underwater: true, in_lava: false, on_fire: false, suffocating: false,
        intersecting_blocks: [], low_air: true,
      },
    }],
    ["attacker identity damage field", {
      type: "damage_received", sequence: 9, server_tick: 121,
      data: {
        amount: 1, health: 17, max_health: 20,
        damage_type: "minecraft:mob_attack", attacker_uuid: "not-allowed",
      },
    }],
    ["empty lifecycle state", {
      type: "actor_lifecycle_changed", sequence: 9, server_tick: 121,
      data: { uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d", name: "bot", lifecycle_state: "" },
    }],
    ["extra lifecycle field", {
      type: "actor_lifecycle_changed", sequence: 9, server_tick: 121,
      data: {
        uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d", name: "bot",
        lifecycle_state: "alive", low_air: true,
      },
    }],
  ] as const) {
    it(`ends the SDK connection on ${label}`, async () => {
      server = new WebSocketServer({ port: 0, path: "/rpc" });
      const address = server.address();
      if (typeof address === "string" || address === null) throw new Error("missing test port");
      server.on("connection", (socket) => {
        socket.on("message", (wire) => {
          const rpc = JSON.parse(wire.toString()) as { id: number };
          socket.send(JSON.stringify({
            jsonrpc: "2.0", method: "runtime.occurrence", params,
          }));
          socket.send(JSON.stringify({
            jsonrpc: "2.0", id: rpc.id, result: {
              protocol_version: 4,
              build_version: "test",
              minecraft_version: "1.21.1",
              neoforge_version: "21.1.233",
              readiness: "ready",
              grounded_block_expiry_ticks: 600,
              grounded_entity_expiry_ticks: 200,
            },
          }));
        });
      });

      const client = await RuntimeClient.connect({
        url: `ws://127.0.0.1:${address.port}/rpc`, bearerToken: "sdk-secret",
      });
      const disconnected = new Promise<Error>((resolve) => client.onDisconnect(resolve));
      await expect(client.runtimeInfo()).rejects.toThrow(/invalid Runtime Occurrence/i);
      await expect(disconnected).resolves.toMatchObject({ message: expect.stringMatching(/invalid Runtime Occurrence/i) });
      client.close();
    });
  }
});


describe("RuntimeClient deadlines", () => {
  it("bounds a peer that accepts TCP but never completes the handshake", async () => {
    const { createServer } = await import("node:net");
    const peers = new Set<import("node:net").Socket>();
    const server = createServer(socket => { peers.add(socket); socket.on("close", () => peers.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("missing port");
    try {
      await expect(RuntimeClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", connectTimeoutMs: 25 }))
        .rejects.toThrow(/timed out/i);
    } finally {
      for (const peer of peers) peer.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("times out one unanswered request and keeps the connection usable", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("missing port");
    let requests = 0;
    server.on("connection", socket => socket.on("message", wire => {
      const request = JSON.parse(String(wire));
      if (++requests > 1) socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null }));
    }));
    const client = await RuntimeClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", requestTimeoutMs: 25 });
    try {
      await expect(client.actorGet()).rejects.toBeInstanceOf(RuntimeSdkTimeoutError);
      await expect(client.actorGet()).resolves.toBeNull();
    } finally {
      client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("cancels a tool call that passes its limit and returns the task's own interrupted result", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("missing port");
    const methods: string[] = [];
    server.on("connection", socket => {
      let taskId: number | undefined;
      socket.on("message", wire => {
        const request = JSON.parse(String(wire));
        methods.push(request.method);
        if (request.method === "tool.call") { taskId = request.id; return; }
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { task_id: request.params.task_id, cancelled: true } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: taskId, result: { success: false, message: "cancelled", interrupted: true } }));
      });
    });
    const client = await RuntimeClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", toolTimeoutMs: 25 });
    try {
      await expect(client.toolCall("goto", {})).resolves.toEqual({ success: false, message: "cancelled", interrupted: true });
      expect(methods).toEqual(["tool.call", "task.cancel"]);
    } finally {
      client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("rejects a tool call whose cancellation the Runtime never confirms, without disconnecting", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("missing port");
    server.on("connection", socket => socket.on("message", wire => {
      const request = JSON.parse(String(wire));
      if (request.method === "actor.get") socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null }));
    }));
    const client = await RuntimeClient.connect({
      url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", toolTimeoutMs: 25, requestTimeoutMs: 25,
    });
    try {
      await expect(client.toolCall("goto", {})).rejects.toThrow(/did not confirm cancellation/);
      await expect(client.actorGet()).resolves.toBeNull();
    } finally {
      client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("puts no client-side limit on a tool call by default", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("missing port");
    server.on("connection", socket => socket.on("message", wire => {
      const request = JSON.parse(String(wire));
      setTimeout(() => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { success: true, message: "done" } })), 80);
    }));
    const client = await RuntimeClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", requestTimeoutMs: 25 });
    try {
      await expect(client.toolCall("goto", {})).resolves.toEqual({ success: true, message: "done" });
    } finally {
      client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("clears a serialization failure deadline without disconnecting later valid calls", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("missing port");
    server.on("connection", socket => socket.on("message", wire => {
      const request = JSON.parse(String(wire));
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null }));
    }));
    const client = await RuntimeClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test", toolTimeoutMs: 25 });
    try {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(client.toolCall("goto", circular)).rejects.toThrow(/circular/i);
      await new Promise(resolve => setTimeout(resolve, 60));
      await expect(client.actorGet()).resolves.toBeNull();
    } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("rejects invalid task envelopes for every tool", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("missing port");
    server.on("connection", socket => socket.on("message", wire => {
      const request = JSON.parse(String(wire));
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { success: "yes", message: "invalid" } }));
    }));
    const client = await RuntimeClient.connect({ url: `ws://127.0.0.1:${address.port}`, bearerToken: "test" });
    try { await expect(client.toolCall("goto", {})).rejects.toThrow("invalid task result"); }
    finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
