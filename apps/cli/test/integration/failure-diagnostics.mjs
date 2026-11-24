import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createLocalTaskPlatform, idleHarness } from '../../../../packages/benchmark/dist/index.js';
import { runTask } from '../../../../packages/benchmark/dist/task-runner.js';
import { prepareNeoForgeServerTemplate } from '../../../../scripts/maintenance/prepare-neoforge-server-template.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const output = resolve(process.env.TASK_RUNTIME_INTEGRATION_OUTPUT
  ?? join(root, 'build/task-runtime-integration/failure-diagnostics'));
const { template, command } = await prepareNeoForgeServerTemplate(join(output, 'server-template'), {
  serverProperties: {
    'level-type': 'minecraft:flat',
    'generate-structures': 'false',
    'view-distance': '2',
    'simulation-distance': '2',
  },
});

const task = {
  id: 'failure-diagnostics',
  revision: '1',
  platform: createLocalTaskPlatform({
    serverWorkingDirectoryTemplate: template,
    serverCommand: command,
    world: {
      source: { kind: 'generated', seed: 'failure-diagnostics' },
      worldKnowledgeProfile: 'grounded_evidence',
    },
    difficulty: 'peaceful',
    createHarness: idleHarness,
  }),
  async run(context) {
    assert.equal(await context.world.time.isPaused(), true);
    await context.world.snapshot();
    throw new Error('Intentional Task Runtime diagnostics failure');
  },
};

const [record] = await runTask({
  task,
  outputDirectory: output,
  repetitions: 1,
  concurrency: 1,
  watchdogMs: 600_000,
  cleanupTimeoutMs: 30_000,
});
assert.equal(record.runnerStatus, 'process_failure', JSON.stringify(record));
assert.match(record.error, /Intentional Task Runtime diagnostics failure/u);
assert.equal(record.cleanup.status, 'completed', JSON.stringify(record));

const diagnostics = JSON.parse(await readFile(
  join(record.identity.runnerDirectory, 'runtime-diagnostics.json'),
  'utf8',
));
assert.equal(diagnostics.value.paused, true);
assert.equal(typeof diagnostics.value.pendingAuthorityRequests, 'number');
if (process.platform === 'linux') {
  assert.match(
    await readFile(join(record.identity.runnerDirectory, 'runtime-threads.txt'), 'utf8'),
    /Server thread/u,
  );
  assert.ok((await stat(join(record.identity.runnerDirectory, 'runtime-failure.jfr'))).size > 0);
}

console.log(JSON.stringify({
  event: 'task_runtime_failure_diagnostics_passed',
  record,
}));
