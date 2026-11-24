import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { assertNotListening, copyWorldTemplate, forwardSignalsToServer, serverProcessDiagnostics, spawnServerProcess, stopServerProcess } from "../src/index.js";

describe("owned server processes", () => {
  it.skipIf(process.platform !== "linux").each(["running", "exited", "timeout"])("stops a detached descendant listener (launcher: %s)", async scenario => {
    const descendant = `
      process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
      const server = require('node:net').createServer();
      server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({pid: process.pid, port: server.address().port}) + '\\n'));
    `;
    const child = spawnServerProcess(process.execPath, ["-e", `
      const worker = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {detached: true, stdio: ['ignore','pipe','ignore']});
      worker.stdout.on('data', chunk => process.stdout.write(chunk));
      process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const [chunk] = await once(child.stdout!, "data");
    const { pid, port } = JSON.parse(String(chunk));
    const nativeKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      // Simulate an owned listener that cannot exit before the cleanup deadline.
      if (scenario === "timeout" && target === pid && signal === "SIGKILL") return true;
      return nativeKill(target, signal);
    });
    try {
      if (scenario === "exited") {
        child.kill("SIGINT");
        await once(child, "exit");
      }
      const started = performance.now();
      const stopping = stopServerProcess(child, 100, started + 500);
      if (scenario === "timeout") {
        await expect(stopping).rejects.toThrow("cleanup deadline");
        expect(performance.now() - started).toBeLessThan(1500);
        expect(serverProcessDiagnostics(child).events).toContainEqual(expect.objectContaining({ event: "stop_timed_out", members: expect.arrayContaining([expect.objectContaining({ pid })]) }));
        await expect(assertNotListening(port, 0)).rejects.toMatchObject({ port });
      } else {
        await stopping;
        await expect(assertNotListening(port, 0)).resolves.toBeUndefined();
      }
    } finally {
      kill.mockRestore();
      try { process.kill(pid, "SIGKILL"); } catch {}
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      await assertNotListening(port, 1000);
    }
  });

  it.skipIf(process.platform !== "linux")("waits for an owned descendant after the launcher exits", async () => {
    const descendant = `
      process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
      const server = require('node:net').createServer();
      server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    `;
    const child = spawnServerProcess(process.execPath, ["-e", `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore','inherit','inherit']});
      process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const [chunk] = await once(child.stdout!, "data");
    const port = Number(String(chunk).trim());
    const nativeKill = process.kill.bind(process);
    const pending: Array<Promise<void>> = [];
    // Delay group termination to expose a launcher-exit versus descendant-exit race.
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal === "SIGKILL") {
        pending.push(delay(150).then(() => { try { nativeKill(pid, signal); } catch {} }));
        return true;
      }
      return nativeKill(pid, signal);
    });
    try {
      await stopServerProcess(child, 1_000);
      await expect(assertNotListening(port, 0)).resolves.toBeUndefined();
    } finally {
      kill.mockRestore();
      await Promise.all(pending);
      try { nativeKill(-child.pid!, "SIGKILL"); } catch {}
      await assertNotListening(port, 1_000);
    }
  });

  it.skipIf(!canInspectListeners())("records the listener identity on a port timeout without stopping it", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
    try {
      await expect(assertNotListening(address.port, 0)).rejects.toMatchObject({
        port: address.port,
        ownership: { status: "identified", pids: expect.arrayContaining([process.pid]) },
      });
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("serializes concurrent stop requests and escalates an ignored interrupt", async () => {
    const child = spawnServerProcess(process.execPath, ["-e", `
      process.on('SIGINT', () => process.stdout.write('interrupt\\n'));
      process.on('SIGTERM', () => process.exit(0));
      process.stdout.write('ready\\n'); setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", chunk => { output += String(chunk); });
    await once(child.stdout!, "data");
    try {
      await Promise.all([stopServerProcess(child, 25), stopServerProcess(child, 25)]);
      expect(output.match(/interrupt/g)).toHaveLength(1);
      expect(child.exitCode).toBe(0);
    } finally { await stopServerProcess(child); }
  });

  it.skipIf(process.platform === "win32")("terminates a shell descendant after its parent exits", async () => {
    const descendant = `
      process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
      const server = require('node:net').createServer();
      server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    `;
    const child = spawnServerProcess(process.execPath, ["-e", `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore','inherit','inherit']});
      process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const [chunk] = await once(child.stdout!, "data");
      const port = Number(String(chunk).trim());
      expect(port).toBeGreaterThan(0);
      await stopServerProcess(child, 1000);
      await assertNotListening(port, 1000);
    } finally { await stopServerProcess(child); }
  });

  it.skipIf(process.platform === "win32")("forwards termination to the owned process group", async () => {
    const child = spawnServerProcess(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "pipe"] });
    await once(child.stdout!, "data");
    const stopForwarding = forwardSignalsToServer(child);
    const kill = vi.spyOn(process, "kill");
    try {
      const listener = process.listeners("SIGTERM").at(-1);
      listener?.();
      expect(kill).toHaveBeenCalledWith(-child.pid!, "SIGTERM");
    } finally { kill.mockRestore(); stopForwarding(); await stopServerProcess(child); }
  });

  it("copies exclusively without overwriting a previous world", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-template-"));
    try {
      const source = join(root, "source"); const target = join(root, "target");
      await mkdir(source); await writeFile(join(source, "world.dat"), "original");
      await copyWorldTemplate(source, target);
      await writeFile(join(source, "world.dat"), "replacement");
      await expect(copyWorldTemplate(source, target)).rejects.toThrow();
      expect(await readFile(join(target, "world.dat"), "utf8")).toBe("original");
      const unrelated = join(root, "unrelated");
      await mkdir(unrelated);
      await writeFile(join(unrelated, "old-region.dat"), "must not merge");
      await expect(copyWorldTemplate(source, unrelated)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function canInspectListeners(): boolean {
  if (process.platform !== "linux") return false;
  try { execFileSync("ss", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
