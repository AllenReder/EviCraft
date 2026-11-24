import { expect, it, vi } from "vitest";

const reservePorts = vi.hoisted(() => vi.fn<(count: number) => Promise<readonly number[]>>());
vi.mock("@evicraft/server-host", async importOriginal => ({ ...await importOriginal<object>(), reservePorts }));

const { assignPorts } = await import("../src/local-task-platform.js");

it("never gives a port to two unfinished World Runs, even when the kernel offers it again", async () => {
  reservePorts
    .mockResolvedValueOnce([41001, 41002])
    .mockResolvedValueOnce([41003, 41002])
    .mockResolvedValueOnce([41004, 41005]);
  await expect(assignPorts(2)).resolves.toEqual([41001, 41002]);
  await expect(assignPorts(2)).resolves.toEqual([41004, 41005]);
  expect(reservePorts).toHaveBeenCalledTimes(3);
});
