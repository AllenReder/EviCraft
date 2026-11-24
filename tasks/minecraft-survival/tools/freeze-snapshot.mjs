import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createLocalTaskPlatform, idleHarness } from '../../../packages/benchmark/dist/index.js';
import { prepareNeoForgeServerTemplate } from '../../../scripts/maintenance/prepare-neoforge-server-template.mjs';
import { snapshotDigest } from '../../minecraft-common/config.ts';
import { initialize } from '../../minecraft-common/initialize.ts';

const destinationArgument = process.argv[2];
if (!destinationArgument) {
  throw new Error('Usage: node tasks/minecraft-survival/tools/freeze-snapshot.mjs <snapshot-directory> [seed]');
}

const destination = resolve(destinationArgument);
const seed = process.argv[3] ?? '100';
if (await stat(destination).then(() => true, () => false)) {
  throw new Error(`Snapshot destination already exists: ${destination}`);
}

const work = await mkdtemp(join(tmpdir(), 'survival-snapshot-'));
const template = join(work, 'server-template');
await prepareNeoForgeServerTemplate(template);
const identity = {
  taskId: 'survival-snapshot-builder',
  taskRevision: '1',
  attemptIndex: 0,
  repetitions: 1,
  directory: join(work, 'attempt'),
  taskDirectory: join(work, 'attempt', 'task'),
  runnerDirectory: join(work, 'attempt', 'runner'),
};
await mkdir(identity.taskDirectory, { recursive: true });

let prepared;
try {
  const platform = createLocalTaskPlatform({
    serverWorkingDirectoryTemplate: template,
    serverCommand: [process.execPath, 'launch.mjs'],
    world: {
      source: { kind: 'generated', seed },
      worldKnowledgeProfile: 'grounded_evidence',
    },
    difficulty: 'easy',
    createHarness: idleHarness,
  });
  prepared = await platform.prepare({ identity, signal: AbortSignal.timeout(600_000) });
  const world = prepared.world;
  const command = async text => await world.executeMinecraftCommand(text);
  await command('gamemode survival @a');
  const initial = await world.snapshot();
  assert.equal(initial.actor.present, true);
  const spawn = {
    dimension: initial.actor.dimension,
    ...initial.actor.position,
    yaw: initial.actor.yaw,
    pitch: initial.actor.pitch,
  };
  await command('time set 12345');
  await initialize(world, spawn);
  assert.equal((await command('time query daytime')).result, 0);
  const initialized = await world.snapshot();
  assert.equal(initialized.actor.health, 20);
  assert.equal(initialized.actor.food, 20);
  assert.ok(initialized.inventory.slots.every(slot => !slot.item || slot.item.count === 0));
  assert.equal((await command('difficulty')).result, 1);
  assert.equal((await command('execute if entity @a[gamemode=survival]')).result, 1);
  const fortress = await command('execute in minecraft:the_nether positioned 0 64 0 run locate structure minecraft:fortress');
  assert.equal(fortress.success, true);
  await command('time set 0');
  await command('weather clear');
  await command('save-all flush');
  const worldDirectory = join(identity.runnerDirectory, 'server', 'world');
  await prepared.close();
  prepared = undefined;

  await mkdir(join(destination, 'provenance'), { recursive: true });
  await cp(worldDirectory, join(destination, 'world'), { recursive: true, errorOnExist: true, force: false });
  for (const name of ['playerdata', 'advancements', 'stats', 'session.lock']) {
    await rm(join(destination, 'world', name), { recursive: true, force: true });
  }
  const manifest = {
    revision: '1',
    seed,
    sha256: await snapshotDigest(join(destination, 'world')),
    spawn,
    feasibility: { status: 'pending', receipt: null },
  };
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(destination, 'provenance', 'spawn-receipt.json'), `${JSON.stringify(initial, null, 2)}\n`);
  console.log(JSON.stringify({ event: 'survival_snapshot_frozen', destination, manifest, fortress }));
} finally {
  await prepared?.close();
  await rm(work, { recursive: true, force: true });
}
