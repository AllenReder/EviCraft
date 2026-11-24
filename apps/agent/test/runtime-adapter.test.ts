import { describe, expect, it, vi } from "vitest";

import {
  RuntimeAdapter,
  normalizeTaskResult,
  type RuntimeSdkClient,
} from "../src/harness/runtime-adapter.js";

describe("RuntimeAdapter", () => {
  it("does not silently select a default when Runtime reports an unsupported World Knowledge Profile", async () => {
    const client = fakeClient();
    client.runtimeInfo = vi.fn(async () => JSON.parse('{"world_knowledge_profile":"future-profile"}'));
    await expect(new RuntimeAdapter(client).worldKnowledgeProfile()).rejects.toThrow("unsupported World Knowledge Profile");
  });

  it.each(["success", "failure", "cancel"] as const)("releases the profile read abort listener after %s", async (outcome) => {
    const client = fakeClient();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let resolve!: (value: { world_knowledge_profile: "loaded_world_state" }) => void;
    let reject!: (error: Error) => void;
    client.runtimeInfo = vi.fn(() => new Promise((resolveInfo, rejectInfo) => { resolve = resolveInfo; reject = rejectInfo; }));
    const result = new RuntimeAdapter(client).worldKnowledgeProfile(controller.signal).then(value => value, error => error);
    if (outcome === "success") resolve({ world_knowledge_profile: "loaded_world_state" });
    if (outcome === "failure") reject(new Error("profile failed"));
    if (outcome === "cancel") controller.abort(new Error("profile cancelled"));
    expect(await result).toEqual(outcome === "success" ? "loaded_world_state" : expect.objectContaining({ message: `profile ${outcome === "failure" ? "failed" : "cancelled"}` }));
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
    expect(client.close).not.toHaveBeenCalled();
    // A late failed read is still observed after only the caller's wait was cancelled.
    if (outcome === "cancel") reject(new Error("late RPC failure"));
  });

  it.each(["cancelled", "timed_out", "failed"])("invalidates the connection after an internal %s settlement failure", async (state) => {
    const client = fakeClient();
    client.startToolCall = vi.fn(() => ({ taskId: 1, result: Promise.resolve({
      success: false, message: "task terminal result failed",
      interrupted: state === "cancelled", timed_out: state === "timed_out",
      data: { failure_type: "internal" },
    }) })) as RuntimeSdkClient["startToolCall"];
    const adapter = new RuntimeAdapter(client);
    const disconnected = vi.fn();
    adapter.onDisconnect(disconnected);
    await expect(adapter.call("goto", { x: 1, z: 1 })).rejects.toThrow("Runtime task cleanup failed");
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    await expect(adapter.call("goto", { x: 2, z: 2 })).rejects.toThrow("Runtime task cleanup failed");
    expect(client.startToolCall).toHaveBeenCalledTimes(1);
  });

  it("resolves the configured username through the SDK and accepts only an alive Actor", async () => {
    const client = fakeClient();
    client.ensureBot = vi.fn(async () => ({
      uuid: "1060d6bd-3af2-42ae-92dc-ecab4536f00d",
      name: "HarnessBot",
      lifecycle_state: "alive",
      observation_revision: 7,
    }));

    await expect(new RuntimeAdapter(client).resolveBot("HarnessBot")).resolves.toEqual({
      actorId: "1060d6bd-3af2-42ae-92dc-ecab4536f00d",
      username: "HarnessBot",
      lifecycle: "alive",
      observationRevision: 7,
    });
    expect(client.ensureBot).toHaveBeenCalledWith("HarnessBot");
  });

  it("maps ordinary Runtime failure and timeout/cancellation to canonical Harness results", () => {
    expect(normalizeTaskResult({
      success: false,
      message: "target moved",
      data: { target_uuid: "missing" },
    })).toEqual({
      ok: false,
      error: "RUNTIME_FAILED",
      message: "target moved",
      data: { target_uuid: "missing" },
    });
    expect(normalizeTaskResult({ success: false, message: "deadline", timed_out: true }))
      .toMatchObject({ ok: false, error: "INTERRUPTED", message: "deadline" });
    expect(normalizeTaskResult({ success: false, message: "cancelled", interrupted: true }))
      .toMatchObject({ ok: false, error: "INTERRUPTED", message: "cancelled" });
  });

  it("bounds cancellation when the cancel request fails and no task terminal arrives", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      client.startToolCall = vi.fn(() => ({ taskId: 42, result: new Promise(() => {}) }));
      client.taskCancel = vi.fn(async () => { throw new Error("cancel transport failed"); });
      const controller = new AbortController();
      const adapter = new RuntimeAdapter(client);
      const result = adapter.call("goto", {}, controller.signal);
      const assertion = expect(result).rejects.toMatchObject({
        message: expect.stringContaining("cancellation unconfirmed"),
        cause: expect.objectContaining({ message: "cancel transport failed" }),
      });
      controller.abort("stop");
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(client.close).toHaveBeenCalledTimes(1);
      await expect(adapter.call("goto", {})).rejects.toThrow("cancellation unconfirmed");
      expect(client.startToolCall).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("cancels the exact SDK task and waits for its cleanup terminal", async () => {
    const client = fakeClient();
    let settle!: (value: {
      success: false;
      message: string;
      interrupted: true;
    }) => void;
    client.startToolCall = vi.fn(() => ({
      taskId: 17,
      result: new Promise((resolve) => { settle = resolve; }),
    }));
    client.taskCancel = vi.fn(async () => {
      settle({ success: false, message: "cancelled after neutral input", interrupted: true });
      return { task_id: 17, cancelled: true };
    });
    const controller = new AbortController();
    const result = new RuntimeAdapter(client).call("goto", { x: 1, z: 2 }, controller.signal);

    controller.abort("instinct");

    await expect(result).resolves.toMatchObject({ ok: false, error: "INTERRUPTED" });
    expect(client.taskCancel).toHaveBeenCalledWith(17);
  });

  it("exposes the Semantic Menu Translation over its own raw Menu primitives", async () => {
    const client = fakeClient();
    const snapshot = {
      menu_type: null, menu_id: 0, menu_revision: 3,
      own_inventory: true, slots: [], cursor: { item_id: null, count: 0 }, data_values: [],
    };
    client.startToolCall = vi.fn(() => ({
      taskId: 1,
      result: Promise.resolve({ success: true, message: "raw gui", data: snapshot }),
    }));

    await expect(new RuntimeAdapter(client).semantic.observeMenu()).resolves.toMatchObject({
      ok: true,
      data: { menu_type: "none" },
    });
    expect(client.startToolCall).toHaveBeenCalledWith("inspect_gui", {});
  });

  it("routes the Semantic Menu Translation transfer primitive to the raw Runtime transfer Tool", async () => {
    const client = fakeClient();
    const before = {
      menu_type: "minecraft:generic_9x3", menu_id: 0, menu_revision: 1,
      own_inventory: false, data_values: [], cursor: { item_id: null, count: 0 },
      slots: [
        { index: 0, owner: "menu", container_slot: 0, item_id: null, count: 0, output: false, max_stack_size: 64 },
        { index: 36, owner: "player", container_slot: 0, item_id: "minecraft:coal", count: 1, output: false, max_stack_size: 64 },
      ],
    };
    const after = {
      ...before,
      menu_revision: 2,
      slots: [
        { index: 0, owner: "menu", container_slot: 0, item_id: "minecraft:coal", count: 1, output: false, max_stack_size: 64 },
        { index: 36, owner: "player", container_slot: 0, item_id: null, count: 0, output: false, max_stack_size: 64 },
      ],
    };
    const receipt = {
      menu_id: 0, before_revision: 1, after_revision: 2,
      moves: [{ from: 36, to: 0, item_id: "minecraft:coal", requested_count: 1, moved_count: 1, outcome: "moved" }],
    };
    const results = [
      { success: true, message: "before", data: before },
      { success: true, message: "moved", data: receipt },
      { success: true, message: "after", data: after },
    ];
    client.startToolCall = vi.fn(() => ({ taskId: 9, result: Promise.resolve(results.shift()!) }));

    const result = new RuntimeAdapter(client).semantic.transferItem({
      item_id: "minecraft:coal", count: 1, source: "player_inventory", target: "menu_storage",
    });

    await expect(result).resolves.toMatchObject({ ok: true, data: { count: 1 } });
    expect(client.startToolCall).toHaveBeenNthCalledWith(1, "inspect_gui", {});
    expect(client.startToolCall).toHaveBeenNthCalledWith(2, "transfer", {
      menu_id: 0,
      menu_revision: 1,
      moves: [{ from: 36, to: 0, count: 1 }],
    });
  });
  it("retains Runtime disconnect state and releases its sole SDK listener on close", () => {
    const listeners = new Set<(error: Error) => void>();
    const client = fakeClient();
    client.onDisconnect = vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const adapter = new RuntimeAdapter(client);
    const received = vi.fn();
    const unsubscribe = adapter.onDisconnect(received);
    const failure = new Error("Runtime socket closed");

    for (const listener of listeners) listener(failure);

    expect(adapter.disconnectFailure).toBe(failure);
    expect(received).toHaveBeenCalledWith(failure);
    unsubscribe();
    adapter.close();
    expect(listeners).toHaveLength(0);
  });
});

function fakeClient(): RuntimeSdkClient {
  return {
    runtimeInfo: vi.fn(async () => ({ world_knowledge_profile: "grounded_evidence" })),
    ensureBot: vi.fn(), actorGet: vi.fn(), startToolCall: vi.fn(), taskCancel: vi.fn(),
    observe: vi.fn(async () => ({ observation_revision: 8, server_tick: 0, game_time: 0 })),
    afterTicks: vi.fn(() => new Promise<{ server_tick: number }>(() => {})),
    blockGet: vi.fn(), blockFind: vi.fn(), blockRegion: vi.fn(), entityList: vi.fn(),
    onOccurrence: vi.fn(() => () => {}), onDisconnect: vi.fn(() => () => {}), close: vi.fn(),
  };
}
