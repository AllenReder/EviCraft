import net, { type Socket } from "node:net";

export interface RconConnection { readonly rconPort: number; readonly rconPassword: string; }
interface RconPacket { readonly id: number; readonly type: number; readonly body: string; }

/** Shared smoke-only RCON transport; executes through the dedicated server task queue while gameplay is paused. */
export function rconPacket(id: number, type: number, body: string) {
  const payload = Buffer.from(body, "utf8");
  const packet = Buffer.alloc(payload.length + 14);
  packet.writeInt32LE(payload.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  return packet;
}

export async function readRconPacket(socket: Socket, timeoutMs = 10_000): Promise<RconPacket> {
  return await new Promise<RconPacket>((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timeout = setTimeout(() => finish(new Error("RCON response timed out")), timeoutMs);
    const finish = (error?: Error, packet?: RconPacket) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(packet!);
    };
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) return;
      const length = received.readInt32LE(0);
      if (received.length < length + 4) return;
      finish(undefined, {
        id: received.readInt32LE(4),
        type: received.readInt32LE(8),
        body: received.subarray(12, length + 2).toString("utf8"),
      });
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

export async function runtimeCommand(runtime: RconConnection, command: string, timeoutMs = 10_000): Promise<string> {
  const socket = net.createConnection(runtime.rconPort, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(rconPacket(1, 3, runtime.rconPassword));
    const authenticated = await readRconPacket(socket, timeoutMs);
    if (authenticated.id !== 1) throw new Error("RCON authentication failed");
    socket.write(rconPacket(2, 2, command));
    const response = await readRconPacket(socket, timeoutMs);
    if (response.id !== 2) throw new Error(`unexpected RCON response id ${response.id}`);
    return response.body;
  } finally {
    socket.destroy();
  }
}

