import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLocalTaskPlatform } from '../../../../packages/benchmark/dist/local-task-platform.js';
import { idleHarness } from '../../../../packages/benchmark/dist/index.js';
import { prepareNeoForgeServerTemplate } from '../../../../scripts/maintenance/prepare-neoforge-server-template.mjs';
import { runtimeCommand } from '../../../agent/dist/smoke/rcon.js';

const root = resolve(import.meta.dirname, '../../../..');
const output = resolve(process.env.AUTHORITY_FACTS_OUTPUT ?? join(root, `build/task-runtime-integration/authority-facts-${Date.now()}`));
await mkdir(output, { recursive: true });
const rconPort = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (address === null || typeof address === 'string') return reject(new Error('Missing RCON port'));
    probe.close(() => resolve(address.port));
  });
});
const rconPassword = `benchmark-facts-${process.pid}`;
const { template, command } = await prepareNeoForgeServerTemplate(join(output, 'template'), {
  serverProperties: { 'enable-rcon': 'true', 'rcon.port': rconPort, 'rcon.password': rconPassword },
});
const identity = { taskId: 'authority-facts', taskRevision: '1', attemptIndex: 0, repetitions: 1,
  directory: output, taskDirectory: join(output, 'task'), runnerDirectory: join(output, 'runner') };
await mkdir(identity.taskDirectory, { recursive: true });
const platform = createLocalTaskPlatform({ serverWorkingDirectoryTemplate: template, serverCommand: command,
  world: { source: { kind: 'generated', seed: 'authority-facts' }, worldKnowledgeProfile: 'grounded_evidence' },
  difficulty: 'easy', readinessTimeoutMs: 600_000,
  createHarness: idleHarness,
});
const resources = await platform.prepare({ identity, signal: AbortSignal.timeout(900_000) });
try {
  const world = resources.world;
  await world.time.pause();
  await world.executeMinecraftCommand('fill -6 99 -6 6 105 6 minecraft:air');
  await world.executeMinecraftCommand('fill -6 99 -6 6 99 6 minecraft:stone');
  await world.teleportActor({ dimension: 'minecraft:overworld', x: .5, y: 100, z: .5, yaw: 0, pitch: 0 });
  const block = (x, y, z, blockId) => world.setBlock({ dimension: 'minecraft:overworld', x, y, z, blockId });
  for (const x of [0, 1]) for (const y of [99, 103]) await block(x, y, 3, 'minecraft:obsidian');
  for (const x of [-1, 2]) for (const y of [100, 101, 102]) await block(x, y, 3, 'minecraft:obsidian');
  const snapshot = () => world.snapshot({ actor: true, inventory: true, blocks: [], evaluation: true });
  const frame = await snapshot();
  assert.equal(frame.evaluation?.nearbyPortals.status, 'ok', JSON.stringify(frame.evaluation?.nearbyPortals));
  assert.ok(frame.evaluation.nearbyPortals.value.candidates.some(candidate => candidate.kind === 'nether' && candidate.frameComplete && !candidate.active),
    'complete unlit Nether frame, including optional corners');
  await block(0, 100, 3, 'minecraft:nether_portal');
  const active = await snapshot();
  assert.ok(active.evaluation.nearbyPortals.value.candidates.some(candidate => candidate.kind === 'nether' && candidate.active),
    'active Nether portal block');
  await block(3, 100, 0, 'minecraft:end_portal_frame');
  const endFrame = await snapshot();
  assert.ok(endFrame.evaluation.nearbyPortals.value.candidates.some(candidate => candidate.kind === 'end'
    && candidate.evidence.some(witness => witness.blockState.startsWith('minecraft:end_portal_frame'))), 'End frame vicinity');
  await block(3, 100, 1, 'minecraft:end_portal');
  const endActive = await snapshot();
  assert.ok(endActive.evaluation.nearbyPortals.value.candidates.some(candidate => candidate.kind === 'end' && candidate.active
    && candidate.evidence.some(witness => witness.blockState === 'minecraft:end_portal')), 'active End portal block');
  const definitions = await world.advancementDefinitions();
  assert.ok(definitions.definitions.some(entry => entry.id === 'minecraft:story/root'));
  const beforeGrant = await snapshot();
  const repeated = await snapshot();
  assert.deepEqual(repeated.evaluation.advancements, beforeGrant.evaluation.advancements,
    'read-only advancement projection must not award criteria');
  await world.executeMinecraftCommand('advancement grant @a only minecraft:story/root');
  const advanced = await snapshot();
  assert.equal(advanced.evaluation.advancements.status, 'ok');
  assert.ok(advanced.evaluation.advancements.value.some(entry => entry.id === 'minecraft:story/root' && entry.done
    && entry.criteria.some(criterion => criterion.done && typeof criterion.obtainedAt === 'string')));
  assert.equal(advanced.evaluation.location.status, 'ok');
  const located = await runtimeCommand({ rconPort, rconPassword }, 'execute in minecraft:the_nether run locate structure minecraft:fortress');
  const match = /\[(-?\d+),\s*~,\s*(-?\d+)\]/u.exec(located);
  assert.ok(match, `Fortress locate returned no position: ${located}`);
  const fortressX = Number(match[1]);
  const fortressZ = Number(match[2]);
  await world.teleportActor({ dimension: 'minecraft:the_nether', x: fortressX + .5, y: 64, z: fortressZ + .5, yaw: 0, pitch: 0 });
  const fortressProbe = await snapshot();
  assert.equal(fortressProbe.evaluation.location.status, 'ok');
  const fortress = fortressProbe.evaluation.location.value.structuresContainingActor.find(entry => entry.id === 'minecraft:fortress');
  assert.ok(fortress, `Located fortress was not projected: ${JSON.stringify(fortressProbe.evaluation.location)}`);
  const cornerX = Math.abs(fortress.bounds.min.x - fortressX) > Math.abs(fortress.bounds.max.x - fortressX)
    ? fortress.bounds.min.x : fortress.bounds.max.x;
  const cornerZ = Math.abs(fortress.bounds.min.z - fortressZ) > Math.abs(fortress.bounds.max.z - fortressZ)
    ? fortress.bounds.min.z : fortress.bounds.max.z;
  await world.teleportActor({ dimension: 'minecraft:the_nether', x: cornerX + .5, y: fortress.bounds.max.y, z: cornerZ + .5, yaw: 0, pitch: 0 });
  const corner = await snapshot();
  assert.equal(corner.evaluation.location.status, 'ok');
  assert.deepEqual(corner.evaluation.location.value.structuresContainingActor.find(entry => entry.id === 'minecraft:fortress')?.bounds,
    fortress.bounds, 'the whole fortress bounding corner must remain inside the structure');
  assert.deepEqual(corner.evaluation.nearbyPortals, { status: 'unavailable', reason: 'Portal scan reached an unloaded chunk' },
    'portal evaluation must report unavailable instead of loading the neighboring chunk');
  console.log(JSON.stringify({ event: 'authority_facts_passed', output, frameCandidates: frame.evaluation.nearbyPortals.value.candidates.length,
    activeCandidates: active.evaluation.nearbyPortals.value.candidates.length, advancementDefinitions: definitions.definitions.length }));
} finally { await resources.close(); }
