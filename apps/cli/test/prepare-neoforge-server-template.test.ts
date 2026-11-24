import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { prepareNeoForgeServerTemplate } from "../../../scripts/maintenance/prepare-neoforge-server-template.mjs";

const gradle = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: (...args: unknown[]) => gradle(...args),
}));

const roots: string[] = [];
afterEach(async () => {
  gradle.mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("prepares a relocatable template that starts the exported Java with each Attempt's port and environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepared server "));
  roots.push(root);
  const artifacts = join(root, "build outputs");
  await mkdir(artifacts);
  const java = join(root, "java.mjs");
  await writeFile(java, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const programFile = process.argv.at(-1).slice(1);
console.log(JSON.stringify({
  arguments: process.argv.slice(2, -1),
  program: readFileSync(programFile, 'utf8'),
  cwd: process.cwd(),
  modClasses: process.env.MOD_CLASSES,
  runtimePort: process.env.EVICRAFT_RUNTIME_PORT,
  paused: process.env.EVICRAFT_TASK_START_PAUSED,
}));
`, { mode: 0o755 });
  const classpath = join(artifacts, "classpath.txt");
  const vm = join(artifacts, "vm.txt");
  const program = join(artifacts, "program.txt");
  await writeFile(classpath, '-classpath\n"/known/classes:/known/devlaunch.jar"\n');
  await writeFile(vm, "-Dknown.setting=unchanged\n");
  await writeFile(program, "# Main Class\ncpw.mods.bootstraplauncher.BootstrapLauncher\n--launchTarget\nforgeserverdev\n--port\n25565\n--nogui\n");
  gradle.mockImplementation((_command, args, _options, callback) => {
    const output = args.find((arg: string) => arg.startsWith("-PserverLaunchOutput="))?.split("=").slice(1).join("=");
    void writeFile(output, JSON.stringify({ javaExecutable: java, classpathArgsFile: classpath,
      vmArgsFile: vm, programArgsFile: program, modFolders: "-Dfml.modFolders=mc_agent%%/known/mod",
      mainClass: "net.neoforged.devlaunch.Main", jvmArguments: ["-Duser.language=known-test-language",
        "@" + vm, "-Dfml.modFolders=mc_agent%%/known/mod"],
      environment: { MOD_CLASSES: "known-mod-classes" } }))
      .then(() => callback(null, "prepared", ""), callback);
  });
  const prepared = await prepareNeoForgeServerTemplate(join(root, "template"));
  const launch = JSON.parse(await readFile(join(prepared.template, "server-launch.json"), "utf8"));
  expect(launch.javaExecutable).toBe(java);
  await writeFile(vm, "-Dknown.setting=changed-after-preparation\n");
  expect(await readFile(join(prepared.template, "server-vm-args.txt"), "utf8")).toBe("-Dknown.setting=unchanged\n");
  // Launching the returned command must not use the preparation-only Gradle boundary.
  gradle.mockImplementation(() => { throw new Error("Gradle must not run inside an Attempt"); });
  const nativeExecFile = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).execFile;
  for (const port of [40123, 40124]) {
    const attempt = join(root, `attempt ${port}`);
    await cp(prepared.template, attempt, { recursive: true });
    await writeFile(join(attempt, "server.properties"), `server-port=${port}\n`);
    const { stdout } = await promisify(nativeExecFile)(prepared.command[0], prepared.command.slice(1), {
      cwd: attempt, env: { ...process.env, EVICRAFT_RUNTIME_PORT: "40125", EVICRAFT_TASK_START_PAUSED: "true" },
    });
    const actual = JSON.parse(stdout);
    expect(actual).toMatchObject({ cwd: attempt, runtimePort: "40125", paused: "true", modClasses: "known-mod-classes" });
    // Preserve the exported argument sequence without duplicate VM files or providers.
    expect(actual.arguments).toEqual(["-Duser.language=known-test-language", "@server-vm-args.txt",
      "-Dfml.modFolders=mc_agent%%/known/mod", "@" + join(attempt, "server-classpath-args.txt"),
      "net.neoforged.devlaunch.Main"]);
    expect(actual.program).toContain(`--port\n${port}\n`);
    expect(actual.program).toContain("forgeserverdev");
  }
  // Host settings: another Java and a maximum heap, read when each server starts.
  const attempt = join(root, "attempt host settings");
  await cp(prepared.template, attempt, { recursive: true });
  await writeFile(join(attempt, "server.properties"), "server-port=40130\n");
  const otherJava = join(root, "other java.mjs");
  await writeFile(otherJava, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ other: true, arguments: process.argv.slice(2, -1) }));\n`, { mode: 0o755 });
  const hosted = await promisify(nativeExecFile)(prepared.command[0], prepared.command.slice(1), {
    cwd: attempt, env: { ...process.env, EVICRAFT_SERVER_JAVA: otherJava, EVICRAFT_SERVER_HEAP: "3G" },
  });
  expect(JSON.parse(hosted.stdout)).toEqual({ other: true, arguments: ["-Duser.language=known-test-language", "@server-vm-args.txt",
    "-Dfml.modFolders=mc_agent%%/known/mod", "-Xmx3G", "@" + join(attempt, "server-classpath-args.txt"), "net.neoforged.devlaunch.Main"] });
  await expect(promisify(nativeExecFile)(prepared.command[0], prepared.command.slice(1), {
    cwd: attempt, env: { ...process.env, EVICRAFT_SERVER_HEAP: "lots" },
  })).rejects.toMatchObject({ stderr: expect.stringContaining("EVICRAFT_SERVER_HEAP must be a JVM size") });
  expect(await readFile(program, "utf8")).toContain("--port\n25565\n");
  await rm(join(prepared.template, "server-launch.json"));
  await expect(promisify(nativeExecFile)(prepared.command[0], prepared.command.slice(1), {
    cwd: prepared.template,
  })).rejects.toThrow("server-launch.json");
});

it("reports failed prebuilding before publishing a launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "failed-server-preparation-"));
  roots.push(root);
  gradle.mockImplementation((_command, _args, _options, callback) => callback(new Error("Gradle compilation failed")));
  await expect(prepareNeoForgeServerTemplate(root)).rejects.toThrow("Gradle compilation failed");
  await expect(readFile(join(root, "launch.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
});
