import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createLocalTaskPlatform, idleHarness } from '../../../packages/benchmark/dist/index.js';
import { prepareNeoForgeServerTemplate } from '../../../scripts/maintenance/prepare-neoforge-server-template.mjs';
import { snapshotDigest } from '../../minecraft-common/config.ts';
import { initialize } from '../../minecraft-common/initialize.ts';

if (process.argv.length < 3) {
  throw new Error('Usage: node tasks/minecraft-survival/tools/check-snapshot-spawn.mjs <snapshot-directory>...');
}

for (const argument of process.argv.slice(2)) {
  const snapshotDirectory = resolve(argument);
  const manifest = JSON.parse(await readFile(join(snapshotDirectory, 'manifest.json'), 'utf8'));
  const worldDirectory = join(snapshotDirectory, 'world');
  assert.equal(await snapshotDigest(worldDirectory), manifest.sha256, 'Frozen world digest');

  const work = await mkdtemp(join(tmpdir(), 'survival-spawn-check-'));
  let prepared;
  try {
    const template = join(work, 'server-template');
    await prepareNeoForgeServerTemplate(template);
    const identity = {
      taskId: 'survival-spawn-check', taskRevision: '1', attemptIndex: 0, repetitions: 1,
      directory: join(work, 'attempt'), taskDirectory: join(work, 'attempt', 'task'),
      runnerDirectory: join(work, 'attempt', 'runner'),
    };
    await mkdir(identity.taskDirectory, { recursive: true });
    const platform = createLocalTaskPlatform({
      serverWorkingDirectoryTemplate: template,
      serverCommand: [process.execPath, 'launch.mjs'],
      world: { source: { kind: 'copied_snapshot', worldDirectory }, worldKnowledgeProfile: 'grounded_evidence' },
      difficulty: 'easy',
      createHarness: idleHarness,
    });
    prepared = await platform.prepare({ identity, signal: AbortSignal.timeout(600_000) });
    await initialize(prepared.world, manifest.spawn);
    const { x, y, z, dimension } = manifest.spawn;
    const positions = [-1, 0, 1].map(offset => ({ dimension, x: Math.floor(x), y: Math.floor(y) + offset, z: Math.floor(z) }));
    const observed = await prepared.world.snapshot({ actor: true, inventory: true, blocks: positions, evaluation: true });
    assert.equal(observed.actor.present, true);
    assert.equal(observed.actor.lifecycle, 'alive');
    assert.deepEqual(observed.actor.position, { x, y, z });
    assert.equal(observed.actor.health, 20);
    assert.equal(observed.actor.food, 20);
    assert.ok(observed.inventory?.slots.every(slot => !slot.item));
    assert.equal(observed.evaluation?.location.status, 'ok');
    const blockIds = observed.blocks.map(entry => entry.blockState.split('[')[0]);
    assert.equal(blockIds.length, 3);
    assert.ok(!['minecraft:water', 'minecraft:lava', 'minecraft:air'].includes(blockIds[0]) && !blockIds[0].endsWith('_leaves'), 'Solid non-leaf ground');
    assert.ok(['minecraft:air', 'minecraft:short_grass', 'minecraft:fern', 'minecraft:snow'].includes(blockIds[1]), 'Passable feet');
    assert.equal(blockIds[2], 'minecraft:air', 'Clear headroom');
    const receipt = {
      schemaVersion: 1, seed: manifest.seed, worldRevision: manifest.revision,
      worldSha256: manifest.sha256, spawn: manifest.spawn,
      biomeId: observed.evaluation.location.value.biomeId,
      blocks: observed.blocks, serverTick: observed.serverTick,
      gameTime: observed.gameTime,
      actor: observed.actor,
    };
    await writeFile(join(snapshotDirectory, 'provenance', 'reload-check.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify({ event: 'survival_spawn_reload_checked', seed: manifest.seed, spawn: manifest.spawn,
      biomeId: receipt.biomeId, blocks: blockIds }));
  } finally {
    await prepared?.close();
    await rm(work, { recursive: true, force: true });
  }
}
