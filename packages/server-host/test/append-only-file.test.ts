import { chmod, mkdtemp, mkdir, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AppendOnlyFile } from "../src/append-only-file.js";

const files: AppendOnlyFile[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(files.splice(0).map(file => file.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "append-only-"));
  directories.push(path);
  return path;
}
function writer(path: string, mode?: number) { const file = new AppendOnlyFile(path, mode); files.push(file); return file; }

it("acknowledges complete concurrent records in invocation order and preserves file permissions", async () => {
  const path = join(await directory(), "audit.jsonl");
  const file = writer(path, 0o600);
  await Promise.all([file.append("first\n"), file.append(Buffer.from("second\n")), file.append("third\n")]);
  expect(await readFile(path, "utf8")).toBe("first\nsecond\nthird\n");
  expect((await stat(path)).mode & 0o777).toBe(0o600 & ~process.umask());
  await chmod(path, 0o640);
  await file.append("fourth\n");
  expect((await stat(path)).mode & 0o777).toBe(0o640);
});

it("retries a failed open while preserving the original error in drain and close", async () => {
  const root = await directory();
  const file = writer(join(root, "missing", "audit"));
  const error = await file.append("lost").catch(error => error);
  expect(error).toMatchObject({ code: "ENOENT" });
  await mkdir(join(root, "missing"));
  await file.append("retained\n");
  expect(await readFile(join(root, "missing", "audit"), "utf8")).toBe("retained\n");
  await expect(file.drain()).rejects.toBe(error);
  await expect(file.close()).rejects.toBe(error);
});

it("finishes already accepted appends before close and rejects later appends", async () => {
  const path = join(await directory(), "events");
  const file = writer(path);
  const accepted = Array.from({ length: 20 }, () => file.append("accepted\n"));
  const close = file.close();
  expect(file.close()).toBe(close);
  await expect(file.append("late\n")).rejects.toThrow("closing");
  await Promise.all(accepted);
  await close;
  expect(await readFile(path, "utf8")).toBe("accepted\n".repeat(20));
});

it.skipIf(process.platform !== "linux")("releases its file descriptor after both successful and failed writes", async () => {
  const path = join(await directory(), "events");
  const descriptors = async (target: string) => (await Promise.all((await readdir("/proc/self/fd"))
    .map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => "")))).filter(link => link === target).length;
  const file = writer(path);
  await file.append("record\n");
  expect(await descriptors(path)).toBe(1);
  await file.close();
  expect(await descriptors(path)).toBe(0);
  const failing = writer("/dev/full");
  const before = await descriptors("/dev/full");
  await expect(failing.append("record")).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await descriptors("/dev/full")).toBe(before + 1);
  await expect(failing.close()).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await descriptors("/dev/full")).toBe(before);
});

it("does not create an unused log when closing before the first append", async () => {
  const path = join(await directory(), "unused");
  await writer(path).close();
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
