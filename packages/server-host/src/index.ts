import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export { AppendOnlyFile } from "./append-only-file.js";

const ownershipTags = new WeakMap<ChildProcess, string>();
const stopping = new WeakMap<ChildProcess, Promise<void>>();
const processGroups = new WeakSet<ChildProcess>();
const failedStarts = new WeakSet<ChildProcess>();
const closedProcesses = new WeakSet<ChildProcess>();
const lifecycle = new WeakMap<ChildProcess, Array<Readonly<Record<string, unknown>>>>();
const execFileAsync = promisify(execFile);

interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly state: string;
  readonly executable: string;
}

function recordProcessEvent(child: ChildProcess, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  lifecycle.get(child)?.push({ event, timestamp: new Date().toISOString(), monotonicMs: performance.now(), ...fields });
}

/** Owned-process metadata only: never command arguments or environment variables. */
export function serverProcessDiagnostics(child: ChildProcess): Readonly<Record<string, unknown>> {
  return { pid: child.pid ?? null, processGroupId: processGroups.has(child) ? child.pid ?? null : null,
    exitCode: child.exitCode, signalCode: child.signalCode, events: [...lifecycle.get(child) ?? []] };
}

/** Spawn an owned POSIX group; an inherited tag also identifies reparented Linux descendants. */
export function spawnServerProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const grouped = process.platform !== "win32";
  const ownershipTag = randomUUID();
  const child = spawn(command, [...args], { ...options, detached: grouped,
    env: { ...(options.env ?? process.env), EVICRAFT_SERVER_HOST_OWNER: ownershipTag } });
  ownershipTags.set(child, ownershipTag);
  lifecycle.set(child, []);
  if (grouped) processGroups.add(child);
  recordProcessEvent(child, "spawned", { pid: child.pid ?? null, processGroupId: grouped ? child.pid ?? null : null });
  child.once("error", () => { if (child.pid === undefined) failedStarts.add(child); });
  child.once("exit", (code, signal) => recordProcessEvent(child, "launcher_exited", { code, signal }));
  child.once("close", () => { closedProcesses.add(child); recordProcessEvent(child, "streams_closed"); });
  return child;
}

export async function copyWorldTemplate(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  recordProcessEvent(child, "signal", { signal });
  if (processGroups.has(child) && child.pid !== undefined) {
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } else if (!hasExited(child)) child.kill(signal);
}

/** timeoutMs is the interrupt grace period; deadline is an absolute performance.now() deadline. */
export function stopServerProcess(child: ChildProcess, timeoutMs = 30_000, deadline = performance.now() + timeoutMs + 15_000): Promise<void> {
  const prior = stopping.get(child);
  if (prior !== undefined) return prior;
  const result = stop(child, timeoutMs, deadline);
  stopping.set(child, result);
  return result;
}

export const stopServer = stopServerProcess;

async function stop(child: ChildProcess, timeoutMs: number, deadline: number): Promise<void> {
  // A process scan can take hundreds of milliseconds on a busy host, so each signal reuses the
  // members the previous wait last observed instead of scanning again; the deadline then holds
  // to within one scan.
  let members = await ownedMembers(child);
  recordProcessEvent(child, "stop_requested", { members });
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
    signalProcess(child, signal);
    // Linux ownership tags survive setsid(), launcher exit and reparenting. Never
    // infer ownership from a reserved port: it may now belong to another Attempt.
    for (const member of members ?? []) {
      if (member.pid === child.pid || member.processGroupId === child.pid || member.state.startsWith("Z")) continue;
      recordProcessEvent(child, "descendant_signal", { signal, member });
      try { process.kill(member.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const remaining = Math.max(0, deadline - performance.now());
    const waitMs = signal === "SIGINT" ? timeoutMs : signal === "SIGTERM" ? Math.min(10_000, remaining / 2) : remaining;
    const observed = await waitForOwnedExit(child, Math.min(deadline, performance.now() + waitMs));
    if (observed.exited) return;
    members = observed.members === undefined ? await ownedMembers(child) : observed.members;
  }
  recordProcessEvent(child, "stop_timed_out", { members });
  throw new Error("Server process, descendants or inherited streams did not exit after SIGKILL before cleanup deadline");
}

async function processIdentities(): Promise<readonly ProcessIdentity[] | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,pgid=,stat=,comm="], { timeout: 1_000, maxBuffer: 2_000_000 });
    return stdout.trim().split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
      return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), processGroupId: Number(match[3]), state: match[4]!, executable: match[5]! }] : [];
    });
  } catch { return null; }
}

async function ownedMembers(child: ChildProcess): Promise<readonly ProcessIdentity[] | null> {
  if (!processGroups.has(child) || child.pid === undefined) return null;
  const identities = await processIdentities();
  if (identities === null) return null;
  const owned = new Set([child.pid]);
  // The process tree also supports POSIX hosts without /proc.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of identities) {
      if (!owned.has(item.pid) && (owned.has(item.parentPid) || item.processGroupId === child.pid)) {
        owned.add(item.pid); changed = true;
      }
    }
  }
  const tag = ownershipTags.get(child);
  if (process.platform === "linux" && tag !== undefined) {
    await Promise.all(identities.filter(item => !owned.has(item.pid) && !item.state.startsWith("Z")).map(async item => {
      const environment = await readFile(`/proc/${item.pid}/environ`).catch(() => undefined);
      if (environment?.toString().split("\0").includes(`EVICRAFT_SERVER_HOST_OWNER=${tag}`)) owned.add(item.pid);
    }));
  }
  return identities.filter(item => owned.has(item.pid));
}

/** members is the last observation of the owned group, or undefined when none was taken. */
async function waitForOwnedExit(child: ChildProcess, deadline: number): Promise<{ exited: boolean; members?: readonly ProcessIdentity[] | null }> {
  if (!lifecycle.has(child)) return { exited: await waitForExit(child, Math.max(0, deadline - performance.now())) };
  let previous = "";
  let members: readonly ProcessIdentity[] | null;
  do {
    members = await ownedMembers(child);
    const signature = JSON.stringify(members);
    if (signature !== previous) { recordProcessEvent(child, "group_observed", { members }); previous = signature; }
    // Zombies have exited and released sockets; reaping belongs to their parent.
    const groupExited = members === null ? !ownedGroupExists(child) : members.every(member => member.state.startsWith("Z"));
    const streamsClosed = lifecycle.has(child) ? closedProcesses.has(child) : hasExited(child);
    if (groupExited && (streamsClosed || failedStarts.has(child))) {
      recordProcessEvent(child, "stop_completed", { groupObservationAvailable: members !== null });
      return { exited: true, members };
    }
    await delay(Math.min(25, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  return { exited: false, members };
}

function ownedGroupExists(child: ChildProcess): boolean {
  if (!processGroups.has(child) || child.pid === undefined) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

export async function sendServerCommand(child: ChildProcess, command: string): Promise<void> {
  if (command.trim() === "" || /[\r\n]/u.test(command)) {
    throw new Error("NeoForge server command must be one non-empty line");
  }
  const input = child.stdin;
  if (input === null || input.destroyed || !input.writable) {
    throw new Error("NeoForge server console is unavailable");
  }
  await new Promise<void>((resolvePromise, reject) => {
    input.write(`${command}\n`, (error) => {
      if (error === null || error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

export function forwardSignalsToServer(child: ChildProcess): () => void {
  const forward = (signal: NodeJS.Signals) => {
    signalProcess(child, signal);
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return () => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  };
}

export async function assertNotListening(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await canBindLocalPort(port)) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw new PortReleaseError(port, await listenerOwnership(port));
}

export interface ListenerOwnership {
  readonly status: "identified" | "unknown";
  readonly observedAt: string;
  readonly pids: readonly number[];
  readonly processes: readonly ProcessIdentity[] | null;
}

export class PortReleaseError extends Error {
  override readonly name = "PortReleaseError";
  constructor(readonly port: number, readonly ownership: ListenerOwnership) {
    super(`Timed out waiting for local port ${port} to stop listening`);
  }
}

async function listenerOwnership(port: number): Promise<ListenerOwnership> {
  const observedAt = new Date().toISOString();
  try {
    const { stdout } = await execFileAsync("ss", ["-ltnpH", `sport = :${port}`], { timeout: 1_000, maxBuffer: 100_000 });
    const pids = [...new Set([...stdout.matchAll(/pid=(\d+)/gu)].map(match => Number(match[1])))];
    const identities = pids.length ? await processIdentities() : null;
    return { status: pids.length ? "identified" : "unknown", observedAt, pids,
      processes: identities?.filter(item => pids.includes(item.pid)) ?? null };
  } catch { return { status: "unknown", observedAt, pids: [], processes: null }; }
}

export async function reservePorts(count: number): Promise<readonly number[]> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Port reservation count must be positive");
  }
  const servers = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(servers.map(async (server) => await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    })));
    return servers.map((server) => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("Could not reserve a local port");
      }
      return address.port;
    });
  } finally {
    await Promise.all(servers.map(async (server) => await new Promise<void>((resolvePromise) => {
      if (!server.listening) {
        resolvePromise();
        return;
      }
      server.close(() => resolvePromise());
    })));
  }
}

export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", exited);
      resolvePromise(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once("exit", exited);
  });
}

export function hasExited(child: ChildProcess): boolean {
  return failedStarts.has(child) || child.exitCode !== null || child.signalCode != null;
}

async function canBindLocalPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise, reject) => {
    const socket = createServer();
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolvePromise(false);
      else reject(error);
    });
    socket.listen(port, "127.0.0.1", () => {
      socket.close(() => resolvePromise(true));
    });
  });
}
