// Plays real attempts on real Minecraft servers, without a model or credentials, and checks what the
// benchmark promises: game time stands still while the agent thinks, samples fall on exact ticks and each
// time the world comes to rest, the run stops on the budget tick, and concurrent attempts do not disturb each other.
//
// Needs a prepared server template: TASK_RUNTIME_INTEGRATION_TEMPLATE (default build/survival-server).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const template = resolve(process.env.TASK_RUNTIME_INTEGRATION_TEMPLATE ?? join(repo, 'build/survival-server'));
const output = process.env.TASK_RUNTIME_INTEGRATION_OUTPUT
  ? resolve(process.env.TASK_RUNTIME_INTEGRATION_OUTPUT)
  : await mkdtemp(join(tmpdir(), 'benchmark-run-'));
await mkdir(output, { recursive: true });
const modelPort = 30000 + (process.pid % 2000);

const base = {
  serverTemplatePath: template,
  serverCommand: ['node', 'launch.mjs'],
  snapshotPath: join(repo, 'tasks/minecraft-survival/snapshots/seed-100-v1'),
  profile: 'grounded_evidence',
  deathPolicy: 'respawn',
};
const configs = {
  // A Harness with no model: 1 s of "thinking", then a 40-tick wait, over and over.
  scripted: { ...base, tickBudget: 400, harness: {
    command: ['node', join(repo, 'examples/scripted-harness/harness.mjs')], config: { thinkMs: 1000, waitTicks: 40 } } },
  // The reference Harness against a scripted model endpoint that also sends three unusable responses.
  reference: { ...base, tickBudget: 600, harness: { command: ['node', join(repo, 'apps/agent/dist/cli.js')], config: {
    mode: 'code', abilitySet: 'shared', hazardDecisions: 'enabled',
    model: { provider: 'openai-compatible', name: 'mock', model: 'mock', baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      protocol: 'chat-completions', limits: { contextWindowTokens: 262144, maxOutputTokens: 32768 } } } } },
};
for (const [name, config] of Object.entries(configs)) await writeFile(join(output, `${name}.json`), JSON.stringify(config, null, 2));
await writeFile(join(output, 'turns.json'), JSON.stringify([
  { tool: 'run_code', arguments: { description: 'Read the current position', code: 'const self = await abilities.observe_self({}); return self.ok;' } },
  { text: 'I will think about what to do next.' },
  { tool: 'run_code', raw: '{"description": "Broken call", "code": "await abil' },
  { tool: 'open_door', arguments: {} },
  { tool: 'run_code', arguments: { description: 'Walk four blocks east', code: 'const f = (await abilities.observe_self({})).data.feet; const moved = await abilities.goto({ x: f.x + 4, z: f.z }); return moved.ok;' } },
  { tool: 'run_code', arguments: { description: 'Wait three seconds of game time', code: 'return (await abilities.wait({ seconds: 3 })).message;' } },
]));
const taskPath = join(repo, 'tasks/minecraft-survival');
await writeFile(join(output, 'batch.yaml'), [
  'concurrency: 3', 'instances:',
  ...['scripted', 'scripted', 'reference'].flatMap((name, index) => [
    `  - id: ${name}-${index}`, `    taskPath: ${taskPath}`, `    configPath: ${name}.json`, '    repetitions: 1']),
].join('\n') + '\n');

const model = spawn(process.execPath, [join(repo, 'scripts/verify/mock-model-server.mjs'), String(modelPort), join(output, 'turns.json')], { stdio: 'ignore' });
let batch;
try {
  const runner = await promisify(execFile)(process.execPath, [join(repo, 'apps/cli/dist/index.js'), 'run', join(output, 'batch.yaml'),
    '--out', join(output, 'raw'), '--watchdog-ms', '900000'], { maxBuffer: 16_000_000 }).catch(error => error);
  batch = JSON.parse(runner.stdout);
} finally { model.kill(); }

assert.equal(batch.status, 'completed', JSON.stringify(batch.attempts.map(attempt => attempt.error)));
const decode = join(repo, 'tasks/minecraft-common/observation_codec.py');
for (const attempt of batch.attempts) {
  const id = attempt.identity.instanceId;
  const budget = id.startsWith('scripted') ? 400 : 600;
  assert.deepEqual([attempt.runnerStatus, attempt.taskOutcome?.status, attempt.cleanup?.status], ['completed', 'timeout', 'completed'], id);
  const task = attempt.identity.taskDirectory;
  const result = JSON.parse(await readFile(join(task, 'result.json'), 'utf8'));
  assert.equal(result.elapsedTerminalTick, budget, `${id} stops on the budget tick`);
  const rows = (await promisify(execFile)('python3', [decode, join(task, 'observations.jsonl.gz')], { maxBuffer: 64_000_000 })).stdout
    .trim().split('\n').map(line => JSON.parse(line));
  const ticks = rows.map(row => row.elapsedTick);
  assert.deepEqual([...new Set(ticks.filter(tick => tick % 20 === 0))], Array.from({ length: budget / 20 + 1 }, (_, index) => index * 20), `${id} samples every 20 ticks`);
  assert.ok(ticks.every((tick, index) => index === 0 || tick >= ticks[index - 1]), `${id} samples in tick order`);
  // The world comes to rest after each 40-tick wait (scripted) and after the first observation, which needs
  // no game time (reference): each rest adds a sample on the tick the world stopped on.
  if (id.startsWith('scripted')) assert.ok(ticks.filter(tick => tick === 40).length >= 2, `${id} samples when the wait ends`);
  else assert.ok(ticks.filter(tick => tick === 0).length >= 2, `${id} samples a change that took no game time`);
  assert.deepEqual([rows[0].kind, ...new Set(rows.slice(1).map(row => row.kind))], ['initial', 'scheduled'], id);
  const log = (await readFile(join(task, 'harness.log'), 'utf8')).trim().split('\n');
  if (id.startsWith('scripted')) {
    const steps = log.map(line => JSON.parse(line)).filter(event => event.event === 'step');
    assert.ok(steps.length >= 8, `${id} played ${steps.length} steps`);
    assert.ok(steps.every(step => step.ticksWhileThinking === 0), `${id} lost no game time while thinking`);
    assert.ok(steps.every(step => step.ticksWhileActing === 40), `${id} waits exactly 40 ticks`);
  } else {
    const [run] = await readdir(join(task, 'harness'));
    const events = (await readFile(join(task, 'harness', run, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.filter(event => event.type === 'model_protocol_error').map(event => [event.code, event.willRetry]),
      [['missing_tool_call', true], ['invalid_tool_call_arguments', true], ['invalid_tool_call_name', true]], 'unusable responses are corrected');
    const calls = events.filter(event => event.type === 'outer_call_finished');
    assert.ok(calls.length >= 4 && calls.every(call => call.outcome === 'ok'), 'every committed Tool call succeeded');
    assert.ok(JSON.stringify(calls).includes('waited 60 ticks'), 'three seconds are sixty ticks');
    assert.equal(events.at(-1).endReason, 'external_stop');
  }
}
console.log(JSON.stringify({ status: 'passed', attempts: batch.attempts.length, output }));
