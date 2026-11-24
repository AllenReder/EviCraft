import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Build a camera client template: the NeoForge client with the camera mod, launched under its own Xvfb.
 * Each World Run copies the template, so the client's game directory (options, logs) is per run.
 *
 * launch.mjs reads:
 *   EVICRAFT_CAMERA_SERVER          host:port of the Minecraft server to join
 *   EVICRAFT_CAMERA_USERNAME        camera player name (must match the server's EVICRAFT_CAMERA_USERNAME)
 *   EVICRAFT_CAMERA_PORT            loopback control port of the camera mod
 *   EVICRAFT_CAMERA_VIEW_DISTANCE   client render distance in chunks
 *   EVICRAFT_CAMERA_WIDTH/HEIGHT    image size in pixels
 *   EVICRAFT_CAMERA_JAVA            optional Java executable overriding the exported one
 *   EVICRAFT_CAMERA_XVFB            optional Xvfb executable (default Xvfb on PATH)
 */
export async function prepareCameraClientTemplate(directory, options = {}) {
  directory = resolve(directory);
  const runtime = fileURLToPath(new URL('../../runtime/', import.meta.url));
  await mkdir(directory, {recursive: true});
  const launchPath = join(directory, 'client-launch.json');
  await promisify(execFile)(join(runtime, 'gradlew'), ['-p', runtime,
    ':camera:neoforge:classes', ':camera:neoforge:exportClientLaunch', '--console=plain',
    '-PclientLaunchOutput='+launchPath, ...(options.offline ? ['--offline'] : [])],
  { cwd: runtime, maxBuffer: 16_000_000 });
  const launch = JSON.parse(await readFile(launchPath, 'utf8'));
  await Promise.all([
    copyFile(launch.classpathArgsFile, join(directory, 'client-classpath-args.txt')),
    copyFile(launch.vmArgsFile, join(directory, 'client-vm-args.txt')),
    copyFile(launch.programArgsFile, join(directory, 'client-program-args.txt')),
  ]);
  const vmArgument = '@'+launch.vmArgsFile.replaceAll('\\', '\\\\');
  await writeFile(launchPath, JSON.stringify({ javaExecutable: launch.javaExecutable,
    jvmArguments: launch.jvmArguments.map(argument => argument === vmArgument ? '@client-vm-args.txt' : argument),
    mainClass: launch.mainClass, environment: launch.environment }, null, 2)+'\n');
  // The camera renders what the Bot's client would show; chat, sound and first-run screens are not part of it.
  await writeFile(join(directory, 'options.template.txt'), [
    'onboardAccessibility:false', 'skipMultiplayerWarning:true', 'pauseOnLostFocus:false', 'tutorialStep:none',
    // guiScale 0 (auto) keeps the HUD at the same share of the image across resolutions.
    // maxFps is the frame rate while a capture is pending; between captures the camera mod idles at 2.
    'narrator:0', 'chatVisibility:2', 'maxFps:20', 'fov:0.0', 'bobView:false', 'guiScale:0',
    'soundCategory_master:0.0', 'joinedFirstServer:true', 'renderDistance:${VIEW_DISTANCE}', 'simulationDistance:5', '',
  ].join('\n'));
  await mkdir(join(directory, 'config'), {recursive: true});
  // The early loading window waits on stdin for a y/n answer when it cannot open; the camera is unattended.
  await writeFile(join(directory, 'config', 'fml.toml'), 'disableConfigWatcher = true\nearlyWindowControl = false\n');
  await writeFile(join(directory, 'launch.mjs'), `
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const required = name => { const value = process.env[name]; if (!value) throw new Error(name+' is required'); return value; };
const launch = JSON.parse(readFileSync('client-launch.json', 'utf8'));
const server = required('EVICRAFT_CAMERA_SERVER');
const username = required('EVICRAFT_CAMERA_USERNAME');
const port = required('EVICRAFT_CAMERA_PORT');
const viewDistance = required('EVICRAFT_CAMERA_VIEW_DISTANCE');
const width = required('EVICRAFT_CAMERA_WIDTH');
const height = required('EVICRAFT_CAMERA_HEIGHT');
writeFileSync('options.txt', readFileSync('options.template.txt', 'utf8').replace('\${VIEW_DISTANCE}', viewDistance));
// -displayfd lets Xvfb choose a free display and report it, so concurrent World Runs never collide.
// The window must fit the virtual screen, or the window manager-less X server clamps the framebuffer.
const xvfbArguments = ['-displayfd', '1', '-screen', '0', width+'x'+height+'x24', '-nolisten', 'tcp'];
const xvfb = spawn(process.env.EVICRAFT_CAMERA_XVFB ?? 'Xvfb', xvfbArguments, {stdio: ['ignore', 'pipe', 'inherit']});
let client;
const stop = signal => { client?.kill(signal); xvfb.kill(signal); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
xvfb.once('exit', code => { if (!client) { console.error('Xvfb exited before the camera client started: '+code); process.exit(1); } client.kill('SIGTERM'); });
let display = '';
xvfb.stdout.on('data', chunk => {
  if (client) return;
  display += chunk.toString();
  if (!display.includes('\\n')) return;
  const number = display.trim();
  client = spawn(process.env.EVICRAFT_CAMERA_JAVA ?? launch.javaExecutable, [
    // Offline nodes must not wait for the OS TCP timeout on Mojang services (session blocklist, profile keys)
    // that HttpURLConnection opens without explicit timeouts before every server connection.
    '-Xmx2G', '-Dsun.net.client.defaultConnectTimeout=3000', '-Dsun.net.client.defaultReadTimeout=3000',
    '-Dmcagent.camera.port='+port,
    ...launch.jvmArguments, '@'+resolve('client-classpath-args.txt'),
    launch.mainClass, '@'+resolve('client-program-args.txt'),
    '--username', username, '--quickPlayMultiplayer', server,
    '--width', width, '--height', height,
  ], {stdio: 'inherit', env: {...process.env, ...launch.environment, DISPLAY: ':'+number}});
  client.once('error', error => { console.error('Camera client failed to start: '+error.message); xvfb.kill('SIGTERM'); process.exitCode = 1; });
  client.once('exit', code => { xvfb.kill('SIGTERM'); process.exit(code ?? 1); });
});
`);
  return {template: directory, command: [process.execPath, 'launch.mjs']};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/maintenance/prepare-camera-client-template.mjs <template-directory> [--offline]');
  console.log(JSON.stringify(await prepareCameraClientTemplate(resolve(process.argv[2]), {offline: process.argv.includes('--offline')})));
}
