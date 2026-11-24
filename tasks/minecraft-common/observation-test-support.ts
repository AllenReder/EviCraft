import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const decoder = fileURLToPath(new URL("./observation_codec.py", import.meta.url));

export async function readObservations(path: string) {
  const { stdout } = await exec("python3", [decoder, path], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim().split("\n").map(line => JSON.parse(line));
}
