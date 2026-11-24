import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocket } from "ws";

async function authorityRequest(url, token, method, params) {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Authority request timed out: ${method}`)), 15_000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    socket.once("message", (wire) => { clearTimeout(timer); resolve(JSON.parse(String(wire))); });
  });
  await new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
  return response;
}

function assertAuthorityReceipt(result, method) {
  if (!Number.isInteger(result?.fence_sequence) || !Number.isInteger(result?.server_tick)
      || !Number.isInteger(result?.game_time)) {
    throw new Error(`${method} omitted Authority fence receipt: ${JSON.stringify(result)}`);
  }
}

/** Benchmark Authority checks before the Runtime Bot is provisioned. */
export async function runAuthorityStartupSmoke({ authorityUrl, authorityToken, runtimeToken, runtimeUrl }) {
  const info = await authorityRequest(authorityUrl, authorityToken, "benchmark.info", {});
  if (info.error || info.result?.protocol_version !== 1
      || !Array.isArray(info.result?.capabilities)
      || !info.result.capabilities.includes("actor.teleport@1")
      || !info.result.capabilities.includes("benchmark.snapshot.get@1")) {
    throw new Error(`unexpected benchmark.info: ${JSON.stringify(info)}`);
  }
  assertAuthorityReceipt(info.result, "benchmark.info");
  const before = await authorityRequest(authorityUrl, authorityToken, "actor.get", {});
  if (before.error || before.result?.present !== false) {
    throw new Error(`Authority actor.get expected absent Runtime Bot: ${JSON.stringify(before)}`);
  }
  assertAuthorityReceipt(before.result, "actor.get");
  const snapshot = await authorityRequest(authorityUrl, authorityToken, "benchmark.snapshot.get", {
    actor: true,
    inventory: true,
    blocks: [{ dimension: "minecraft:overworld", x: 0, y: 64, z: 0 }],
  });
  if (snapshot.error || snapshot.result?.actor?.present !== false || snapshot.result?.inventory !== null
      || snapshot.result?.blocks?.length !== 1 || snapshot.result.blocks[0]?.dimension !== "minecraft:overworld") {
    throw new Error(`unexpected benchmark.snapshot.get: ${JSON.stringify(snapshot)}`);
  }
  assertAuthorityReceipt(snapshot.result, "benchmark.snapshot.get");
  const wrongRuntime = await rejectedStatus(authorityUrl, runtimeToken);
  if (wrongRuntime !== 401) throw new Error(`Runtime token authenticated Authority: ${wrongRuntime}`);
  const wrongAuthority = await rejectedStatus(runtimeUrl, authorityToken);
  if (wrongAuthority !== 401) throw new Error(`Authority token authenticated Runtime SDK: ${wrongAuthority}`);
}

/** Benchmark Authority checks after Runtime SDK provisioning has established the Bot. */
export async function runAuthorityProvisionedSmoke({ authorityUrl, authorityToken, actor, command }) {
  const authorityActor = await authorityRequest(authorityUrl, authorityToken, "actor.get", {});
  if (authorityActor.error || authorityActor.result?.present !== true
      || authorityActor.result.uuid !== actor.uuid) {
    throw new Error(`Authority did not observe Runtime-provisioned Bot: ${JSON.stringify(authorityActor)}`);
  }
  assertAuthorityReceipt(authorityActor.result, "actor.get");
  await command("give bot minecraft:iron_pickaxe 1");
  const populatedSnapshot = await authorityRequest(authorityUrl, authorityToken, "benchmark.snapshot.get", {
    actor: true,
    inventory: true,
    blocks: [{ dimension: "minecraft:overworld", x: 24, y: 70, z: 24 }],
  });
  if (populatedSnapshot.error || populatedSnapshot.result?.actor?.uuid !== actor.uuid
      || !Array.isArray(populatedSnapshot.result?.inventory?.slots)
      || populatedSnapshot.result.inventory.slots.length !== 36
      || !populatedSnapshot.result.inventory.slots.every((slot, index) => slot.slot === index && "item" in slot)
      || populatedSnapshot.result.inventory.slots[0]?.item?.item_id !== "minecraft:iron_pickaxe"
      || populatedSnapshot.result?.blocks?.[0]?.block_state !== "minecraft:stone") {
    throw new Error(`Authority populated snapshot was inconsistent: ${JSON.stringify(populatedSnapshot)}`);
  }
  assertAuthorityReceipt(populatedSnapshot.result, "benchmark.snapshot.get");
  const authorityBlock = await authorityRequest(authorityUrl, authorityToken, "world.block.set", {
    dimension: "minecraft:overworld", x: 24, y: 70, z: 24, block_id: "minecraft:gold_block",
  });
  if (authorityBlock.error || authorityBlock.result?.current_block_state !== "minecraft:gold_block") {
    throw new Error(`Authority block set failed: ${JSON.stringify(authorityBlock)}`);
  }
  assertAuthorityReceipt(authorityBlock.result, "world.block.set");
  const readBack = await authorityRequest(authorityUrl, authorityToken, "world.block.get", {
    dimension: "minecraft:overworld", x: 24, y: 70, z: 24,
  });
  if (readBack.error || readBack.result?.block_state !== "minecraft:gold_block") {
    throw new Error(`Authority block get did not round-trip: ${JSON.stringify(readBack)}`);
  }
  assertAuthorityReceipt(readBack.result, "world.block.get");
  const teleported = await authorityRequest(authorityUrl, authorityToken, "actor.teleport", {
    dimension: "minecraft:overworld", x: 25.5, y: 71, z: 25.5, yaw: 0, pitch: 0,
  });
  if (teleported.error || teleported.result?.present !== true
      || Math.abs(teleported.result.position?.x - 25.5) > 0.1) {
    throw new Error(`Authority teleport failed: ${JSON.stringify(teleported)}`);
  }
  assertAuthorityReceipt(teleported.result, "actor.teleport");
}

/** Requests a WebSocket endpoint with a token expected to be rejected. */
export async function rejectedStatus(url, token) {
  return await new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const headers = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const request = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      headers,
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("connection unexpectedly accepted"));
    });
    request.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve("reset");
      else reject(error);
    });
    request.end();
  });
}
