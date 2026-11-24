import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runNeoForgeGameTest,
  runRuntimeSdkSmoke,
  runWithNeoForgeSmokeRun,
} from "../src/smoke/neoforge-smoke-run.js";
import { assertNotListening } from "../src/smoke/neoforge-server-process.js";

describe("NeoForge Smoke Run", () => {
  it("creates isolated startup and authenticated servers and removes a successful run", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const runsRoot = join(root, "runs");
    let runDirectory = "";

    await runWithNeoForgeSmokeRun({
      runsRoot,
      execute: async (run) => {
        runDirectory = run.runDirectory;
        expect(run.missingToken.directory).toBe(join(runDirectory, "missing-token-server"));
        expect(run.authenticated.directory).toBe(join(runDirectory, "authenticated-server"));

        const missingProperties = await readFile(
          join(run.missingToken.directory, "server.properties"), "utf8",
        );
        const authenticatedProperties = await readFile(
          join(run.authenticated.directory, "server.properties"), "utf8",
        );
        expect(missingProperties).toContain("allow-flight=false\n");
        expect(missingProperties).toContain("level-seed=302\n");
        expect(missingProperties).toContain("generate-structures=true\n");
        expect(missingProperties).toContain("spawn-monsters=false\n");
        expect(missingProperties).toContain("enable-rcon=false\n");
        expect(authenticatedProperties).toContain("enable-rcon=true\n");
        expect(authenticatedProperties).toContain(`rcon.port=${run.authenticated.rconPort}\n`);
        expect(authenticatedProperties).toContain(`rcon.password=${run.authenticated.rconPassword}\n`);
        await expect(readFile(join(run.missingToken.directory, "eula.txt"), "utf8"))
          .resolves.toBe("eula=true\n");
      },
    });

    await expect(stat(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the complete run and log when execution fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    let retainedRun = "";

    let failure: unknown;
    try {
      await runWithNeoForgeSmokeRun({
        runsRoot: join(root, "runs"),
        execute: async (run) => {
          retainedRun = run.runDirectory;
          await writeFile(run.authenticated.logPath, "authenticated server failed\n");
          throw new Error("collect_blocks conformance failed");
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: expect.stringContaining("collect_blocks conformance failed"),
      retainedRunDirectory: retainedRun,
    });
    await expect(readFile(
      join(retainedRun, "authenticated-server", "server.log"), "utf8",
    )).resolves.toBe("authenticated server failed\n");
  });

  it("retains an inner Runtime server spawn failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const child = pendingGameTestChild();

    await expect(runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => child.process,
        createLog: () => closingSmokeLog(),
      },
      execute: async (run) => {
        const server = await run.startServer(run.missingToken);
        child.process.emit("error", new Error("Runtime server could not spawn"));
        await run.stopServer(server);
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("Runtime server could not spawn"),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
  });

  it("checks all Runtime server ports when spawn throws synchronously", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const checkedPorts: number[] = [];

    await expect(runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => { throw new Error("Runtime server spawn threw"); },
        createLog: () => closingSmokeLog(),
        assertPortReleased: async (port) => { checkedPorts.push(port); },
      },
      execute: async (run) => {
        await run.startServer(run.authenticated);
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("Runtime server spawn threw"),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(checkedPorts).toHaveLength(4);
  });

  it("retains an inner Runtime server non-zero exit after releasing its ports", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const child = pendingGameTestChild();
    const checkedPorts: number[] = [];

    await expect(runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => child.process,
        createLog: () => closingSmokeLog(),
        assertPortReleased: async (port) => { checkedPorts.push(port); },
      },
      execute: async (run) => {
        const server = await run.startServer(run.missingToken);
        child.exit(17, null);
        await run.stopServer(server);
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("NeoForge server exited with 17"),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(checkedPorts).toHaveLength(3);
  });

  it("retains an inner Runtime server signal exit after releasing its ports", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const child = pendingGameTestChild();
    const checkedPorts: number[] = [];

    await expect(runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => child.process,
        createLog: () => closingSmokeLog(),
        assertPortReleased: async (port) => { checkedPorts.push(port); },
      },
      execute: async (run) => {
        const server = await run.startServer(run.missingToken);
        child.exit(null, "SIGTERM");
        await run.stopServer(server);
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("NeoForge server exited with SIGTERM"),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(checkedPorts).toHaveLength(3);
  });

  it("retains an inner Runtime server clean exit before requested stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const child = pendingGameTestChild();
    const checkedPorts: number[] = [];

    await expect(runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => child.process,
        createLog: () => closingSmokeLog(),
        assertPortReleased: async (port) => { checkedPorts.push(port); },
      },
      execute: async (run) => {
        const server = await run.startServer(run.missingToken);
        child.exit(0, null);
        await run.stopServer(server);
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("NeoForge server exited with 0"),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(checkedPorts).toHaveLength(3);
  });

  it("forwards interrupts through inner Runtime server shutdown escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const checkedPorts: number[] = [];
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let releaseExecution!: () => void;
    const execution = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const child = pendingGameTestChild((signal, kills) => {
      if (signal === "SIGINT" && kills.length === 1) releaseExecution();
      return signal === "SIGTERM" && kills.length === 2;
    });
    const running = runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => child.process,
        createLog: () => closingSmokeLog(),
        assertPortReleased: async (port) => { checkedPorts.push(port); },
        stopTimeoutMs: 1,
      },
      execute: async (run) => {
        await run.startServer(run.missingToken);
        resolveStarted();
        await execution;
      },
    });
    await started;
    process.emit("SIGTERM");

    await expect(running).rejects.toMatchObject({
      interruptedSignal: "SIGTERM",
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(child.kills).toEqual(["SIGINT", "SIGTERM"]);
    expect(checkedPorts).toHaveLength(3);
  });

  it("keeps a still-running inner server tracked for a cleanup retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const child = pendingGameTestChild();
    let stopAttempts = 0;

    await expect(runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => child.process,
        createLog: () => closingSmokeLog(),
        stop: async () => {
          stopAttempts += 1;
          if (stopAttempts === 1) throw new Error("first Runtime server stop failed");
          child.exit(0, null);
        },
        assertPortReleased: async () => {},
      },
      execute: async (run) => {
        const server = await run.startServer(run.missingToken);
        await run.stopServer(server);
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("first Runtime server stop failed"),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });

    expect(stopAttempts).toBe(2);
    expect(child.process.exitCode).toBe(0);
  });

  it("retains cleanup failure even when a scenario swallows stopServer", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const child = pendingGameTestChild();
    let stopAttempts = 0;

    await expect(runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => child.process,
        createLog: () => closingSmokeLog(),
        stop: async () => {
          stopAttempts += 1;
          if (stopAttempts === 1) throw new Error("swallowed Runtime server stop failed");
          child.exit(0, null);
        },
        assertPortReleased: async () => {},
      },
      execute: async (run) => {
        const server = await run.startServer(run.missingToken);
        try {
          await run.stopServer(server);
        } catch (error) {
          expect(error).toHaveProperty("message", expect.stringContaining("swallowed Runtime server stop failed"));
        }
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("swallowed Runtime server stop failed"),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(stopAttempts).toBe(2);
  });

  it("aggregates inner Runtime server log and port cleanup failures only once", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const child = pendingGameTestChild();
    const checkedPorts: number[] = [];

    await expect(runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing: {
        spawn: () => child.process,
        createLog: () => failingSmokeLog(new Error("Runtime server log close failed")),
        assertPortReleased: async (port) => {
          checkedPorts.push(port);
          throw new Error(`port ${port} remained bound`);
        },
      },
      execute: async (run) => {
        const server = await run.startServer(run.missingToken);
        await run.stopServer(server);
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("Runtime server log close failed"),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(checkedPorts).toHaveLength(3);
    expect(child.kills).toEqual(["SIGINT"]);
  });

  it("retains an otherwise successful run when the operator interrupts it", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    let retainedRun = "";
    let failure: unknown;
    try {
      await runWithNeoForgeSmokeRun({
        runsRoot: join(root, "runs"),
        execute: async (run) => {
          retainedRun = run.runDirectory;
          process.emit("SIGTERM");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: expect.stringContaining("interrupted by SIGTERM"),
      retainedRunDirectory: retainedRun,
      interruptedSignal: "SIGTERM",
    });
    await expect(stat(retainedRun)).resolves.toBeDefined();
  });

  it("completes a GameTest only after the process exits, closes its log, and releases both ports", async () => {
    let receipt: Readonly<{ minecraftPort: number; runtimePort: number }> | undefined;
    await runNeoForgeGameTest({
      id: "route-mutation",
      namespace: "test",
      assertOutput: (output) => expect(output).toBe("GameTests passed\n"),
      receipt: (ports) => { receipt = ports; },
      testing: {
        spawn: () => settledGameTestChild(0, "GameTests passed\n"),
      },
    });

    expect(receipt).toBeDefined();
    await assertNotListening(receipt!.minecraftPort);
    await assertNotListening(receipt!.runtimePort);
  });

  it("drains output queued just after process exit before asserting the receipt", async () => {
    const child = pendingGameTestChild();
    await runNeoForgeGameTest({
      id: "route-mutation",
      namespace: "test",
      assertOutput: (output) => expect(output).toBe("late GameTests output\n"),
      receipt: () => {},
      testing: {
        spawn: () => {
          queueMicrotask(() => {
            child.exit(0, null);
            queueMicrotask(() => child.stdout.emit("data", Buffer.from("late GameTests output\n")));
          });
          return child.process;
        },
      },
    });
  });

  it("aggregates log and port-release failures while retaining GameTest artifacts", async () => {
    const checkedPorts: number[] = [];
    let receiptCalled = false;
    let failure: unknown;
    try {
      await runNeoForgeGameTest({
        id: "route-mutation",
        namespace: "test",
        assertOutput: () => { throw new Error("output assertion must not run"); },
        receipt: () => { receiptCalled = true; },
        testing: {
          spawn: () => settledGameTestChild(0, "GameTests passed\n"),
          assertPortReleased: async (port) => {
            checkedPorts.push(port);
            throw new Error(`port ${port} remained bound`);
          },
          createLog: () => failingSmokeLog(new Error("GameTest log close failed")),
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      retainedRunDirectory: expect.stringMatching(/^\//u),
      cleanupFailures: expect.arrayContaining([
        expect.stringMatching(/^port \d+ remained bound$/u),
        "GameTest log close failed",
      ]),
    });
    expect(checkedPorts).toHaveLength(2);
    expect(receiptCalled).toBe(false);
  });

  it.each([
    ["spawn failure", () => failedGameTestChild(new Error("Gradle could not spawn")), /Gradle could not spawn/u],
    ["non-zero exit", () => settledGameTestChild(17), /route-mutation GameTests failed \(17\)/u],
  ])("retains absolute artifacts after %s", async (_label, spawn, expected) => {
    let failure: unknown;
    try {
      await runNeoForgeGameTest({
        id: "route-mutation",
        namespace: "test",
        assertOutput: () => { throw new Error("should not assert failed GameTests"); },
        receipt: () => { throw new Error("should not emit failed GameTests"); },
        testing: { spawn },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: expect.stringMatching(expected),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    await expect(readFile(join((failure as { retainedRunDirectory: string }).retainedRunDirectory, "server.log"), "utf8"))
      .resolves.toBeDefined();
  });

  it("escalates an interrupt through the active GameTest shutdown path", async () => {
    const child = pendingGameTestChild((signal, kills) => signal === "SIGTERM" && kills.length === 2);
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });
    const running = runNeoForgeGameTest({
      id: "route-mutation",
      namespace: "test",
      assertOutput: () => {},
      receipt: () => {},
      testing: {
        spawn: () => {
          resolveSpawned();
          return child.process;
        },
        stopTimeoutMs: 1,
      },
    });
    await spawned;
    process.emit("SIGTERM");

    await expect(running).rejects.toMatchObject({
      interruptedSignal: "SIGTERM",
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(child.kills).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("rejects an unknown SDK scope before it creates a run or spawns a child", async () => {
    let spawned = false;

    await expect(runRuntimeSdkSmoke({
      scope: "unknown",
      testing: {
        spawn: () => {
          spawned = true;
          return settledGameTestChild(0);
        },
      },
    })).rejects.toThrow("Unknown Runtime SDK Smoke scope unknown");

    expect(spawned).toBe(false);
  });

  it.each([
    ["spawn failure", () => failedGameTestChild(new Error("SDK smoke could not spawn")), /SDK smoke could not spawn/u],
    ["non-zero exit", () => settledGameTestChild(23), /NeoForge smoke exited with 23/u],
  ])("retains SDK smoke artifacts after %s", async (_label, spawn, expected) => {
    let failure: unknown;
    try {
      await runRuntimeSdkSmoke({ testing: { spawn } });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: expect.stringMatching(expected),
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    await expect(readFile(
      join((failure as { retainedRunDirectory: string }).retainedRunDirectory, "sdk-smoke.log"), "utf8",
    )).resolves.toBeDefined();
  });

  it("escalates an interrupt through the SDK smoke child", async () => {
    const child = pendingGameTestChild((signal, kills) => signal === "SIGTERM" && kills.length === 2);
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });
    const running = runRuntimeSdkSmoke({
      testing: {
        spawn: () => {
          resolveSpawned();
          return child.process;
        },
        stopTimeoutMs: 1,
      },
    });
    await spawned;
    process.emit("SIGTERM");

    await expect(running).rejects.toMatchObject({
      interruptedSignal: "SIGTERM",
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
    expect(child.kills).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("aggregates SDK log cleanup failures and keeps the absolute run directory", async () => {
    let failure: unknown;
    try {
      await runRuntimeSdkSmoke({
        testing: {
          spawn: () => settledGameTestChild(0),
          createLog: () => failingSmokeLog(new Error("SDK smoke log close failed")),
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: expect.stringContaining("SDK smoke log close failed"),
      cleanupFailures: ["SDK smoke log close failed"],
      retainedRunDirectory: expect.stringMatching(/^\//u),
    });
  });

  it("uses the same lifecycle seam for GameTest and Runtime server callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "neoforge-smoke-run-"));
    const launches: Array<"gametest" | "runtime"> = [];
    const logs: string[] = [];
    const checkedPorts: number[] = [];
    const children = [pendingGameTestChild(), pendingGameTestChild()];
    const testing = {
      spawn: () => {
        launches.push(launches.length === 0 ? "gametest" : "runtime");
        const child = children.shift()!;
        queueMicrotask(() => {
          if (launches.length === 1) {
            child.stdout.emit("data", Buffer.from("GameTests passed\n"));
            child.exit(0, null);
          }
        });
        return child.process;
      },
      createLog: (path: string) => {
        logs.push(path);
        return createWriteStream(path, { flags: "a" });
      },
      assertPortReleased: async (port) => { checkedPorts.push(port); },
    };

    await runNeoForgeGameTest({
      id: "route-mutation",
      namespace: "test",
      assertOutput: (output) => expect(output).toBe("GameTests passed\n"),
      receipt: () => {},
      testing,
    });
    await runWithNeoForgeSmokeRun({
      runsRoot: join(root, "runs"),
      testing,
      execute: async (run) => {
        const server = await run.startServer(run.authenticated);
        await run.stopServer(server);
      },
    });

    expect(launches).toEqual(["gametest", "runtime"]);
    expect(logs).toHaveLength(2);
    expect(checkedPorts).toHaveLength(6);
  });
});

function failingSmokeLog(error: Error) {
  const log = new EventEmitter();
  return Object.assign(log, {
    destroyed: false,
    write: () => true,
    end: () => queueMicrotask(() => log.emit("error", error)),
  }) as never;
}

function closingSmokeLog() {
  const log = new EventEmitter();
  return Object.assign(log, {
    destroyed: false,
    write: () => true,
    end: () => queueMicrotask(() => log.emit("close")),
  }) as never;
}

function settledGameTestChild(code: number, output = "") {
  const child = pendingGameTestChild();
  queueMicrotask(() => {
    if (output !== "") child.stdout.emit("data", Buffer.from(output));
    child.exit(code, null);
  });
  return child.process;
}

function failedGameTestChild(error: Error) {
  const child = pendingGameTestChild();
  queueMicrotask(() => child.process.emit("error", error));
  return child.process;
}

function pendingGameTestChild(
  exitOnSignal: (signal: NodeJS.Signals, kills: readonly NodeJS.Signals[]) => boolean = () => true,
) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: (_signal: NodeJS.Signals) => false,
  });
  const kills: NodeJS.Signals[] = [];
  process.kill = (signal: NodeJS.Signals) => {
    kills.push(signal);
    if (exitOnSignal(signal, kills)) {
      process.exitCode = null;
      process.signalCode = signal;
      process.emit("exit", null, signal);
    }
    return true;
  };
  return {
    process: process as never,
    stdout,
    kills,
    exit(code: number | null, signal: NodeJS.Signals | null) {
      process.exitCode = code;
      process.signalCode = signal;
      process.emit("exit", code, signal);
    },
  };
}
