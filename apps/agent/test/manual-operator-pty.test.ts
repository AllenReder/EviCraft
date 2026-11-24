import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Manual Operator PTY", () => {
  it("accepts arrow-key navigation through the real terminal prompts", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/manual-operator-pty-smoke.mjs", import.meta.url));
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
    const child = spawn("script", ["-qfec", command, "/dev/null"], {
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    await waitFor(() => output.includes("❯ face"), child);
    child.stdin.write("\r");
    await waitFor(() => output.includes("❯ north"), child);
    child.stdin.write("\u001b[B\r");
    await waitFor(() => output.includes("❯ Execute"), child);
    child.stdin.write("\r");

    const exitCode = await completed;
    expect(exitCode).toBe(0);
    expect(output).toContain('RESULT {"toolName":"face","input":{"direction":"south"}}');
  }, 10_000);
});

async function waitFor(predicate: () => boolean, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (child.exitCode !== null) throw new Error(`PTY fixture exited early with ${child.exitCode}`);
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      throw new Error("Timed out waiting for PTY prompt");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
