import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Build a world-free NeoForge server template for Tasks and development tools. */
export async function prepareNeoForgeServerTemplate(directory, options = {}) {
  directory = resolve(directory);
  const runtime = fileURLToPath(new URL('../../runtime/', import.meta.url));
  const serverProperties = {
    'view-distance': '4',
    'simulation-distance': '4',
    ...options.serverProperties,
  };
  await mkdir(directory, {recursive: true});
  const launchPath = join(directory, 'server-launch.json');
  await promisify(execFile)(join(runtime, 'gradlew'), ['-p', runtime,
    // The exported classpath names the smokeFixture outputs, so compile them too.
    ':core:neoforge:smokeFixtureClasses', ':core:neoforge:exportServerLaunch', '--console=plain',
    '-PruntimeServerGameDir='+directory, '-PserverLaunchOutput='+launchPath, ...(options.offline ? ['--offline'] : [])],
  { cwd: runtime, maxBuffer: 16_000_000 });
  const launch = JSON.parse(await readFile(launchPath, 'utf8'));
  await Promise.all([
    copyFile(launch.classpathArgsFile, join(directory, 'server-classpath-args.txt')),
    copyFile(launch.vmArgsFile, join(directory, 'server-vm-args.txt')),
    copyFile(launch.programArgsFile, join(directory, 'server-program-args.template.txt')),
  ]);
  const vmArgument = '@'+launch.vmArgsFile.replaceAll('\\', '\\\\');
  await writeFile(launchPath, JSON.stringify({ javaExecutable: launch.javaExecutable,
    jvmArguments: launch.jvmArguments.map(argument => argument === vmArgument ? '@server-vm-args.txt' : argument),
    mainClass: launch.mainClass, environment: launch.environment }, null, 2)+'\n');
  await writeFile(join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(join(directory, 'server.properties'), `${Object.entries(serverProperties)
    .map(([name, value]) => `${name}=${value}`).join('\n')}\n`);
  await mkdir(join(directory, 'config'), {recursive: true});
  // Experiment configs stay fixed; avoid one inotify instance per Minecraft JVM.
  await writeFile(join(directory, 'config', 'fml.toml'), 'disableConfigWatcher = true\n');
  await writeFile(join(directory, 'launch.mjs'), `
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const launch = JSON.parse(readFileSync('server-launch.json', 'utf8'));
const port = readFileSync('server.properties','utf8').match(/^server-port=(\\d+)$/m)?.[1];
if (!port) throw new Error('Attempt server.properties must specify server-port');
const program = readFileSync('server-program-args.template.txt', 'utf8');
if (!/^--port\\r?\\n[^\\r\\n]+/m.test(program)) throw new Error('Prepared server arguments must contain --port');
writeFileSync('server-program-args.txt', program.replace(/^--port\\r?\\n[^\\r\\n]+/m, '--port\\n'+port));
// Host settings, read on every launch: another Java than the one setup found, and a maximum heap.
const java = process.env.EVICRAFT_SERVER_JAVA || launch.javaExecutable;
const heap = process.env.EVICRAFT_SERVER_HEAP || '';
if (heap && !/^[1-9]\\d*[kKmMgG]?$/.test(heap)) throw new Error('EVICRAFT_SERVER_HEAP must be a JVM size such as 4G, got '+JSON.stringify(heap));
console.error('launch: java '+java+', heap '+(heap || 'JVM default'));
const child = spawn(java, [
  ...launch.jvmArguments, ...(heap ? ['-Xmx'+heap] : []), '@'+resolve('server-classpath-args.txt'),
  launch.mainClass, '@'+resolve('server-program-args.txt'),
], {stdio:'inherit', env:{...process.env, ...launch.environment}});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error('Prepared Java server failed to start: '+error.message); process.exitCode = 1; });
child.once('exit', code => process.exit(code ?? 1));
`);
  return {template: directory, command: [process.execPath, 'launch.mjs']};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = 'Usage: node scripts/maintenance/prepare-neoforge-server-template.mjs <template-directory> --accept-eula [--offline]';
  if (!process.argv[2] || process.argv[2].startsWith('--')) throw new Error(usage);
  if (!process.argv.includes('--accept-eula')) {
    throw new Error('The server template writes eula=true. Pass --accept-eula to accept the Minecraft EULA (https://www.minecraft.net/eula).\n'+usage);
  }
  console.log(JSON.stringify(await prepareNeoForgeServerTemplate(resolve(process.argv[2]), {offline: process.argv.includes('--offline')})));
}
