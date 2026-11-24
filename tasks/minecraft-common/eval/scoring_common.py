"""Shared streaming observation reader for Python task scorers (schema v1)."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import observation_codec


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and abs(value) <= 2**53 - 1


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_bytes())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


class Observations:
    def __init__(self, attempt, rubric):
        self.directory = Path(attempt)
        raw = Path(rubric).read_bytes()
        self.rubric = json.loads(raw)
        if (self.rubric.get('schemaVersion') != '1' or not self.rubric.get('revision')
                or not integer(self.rubric.get('tickBudget')) or self.rubric['tickBudget'] < 1):
            raise ValueError('Invalid rubric')
        self.rubric_digest = digest(raw)
        runner_path = self.directory / 'runner/attempt.json'
        self.runner = read_json(runner_path) if runner_path.exists() else None
        self.eligible = bool(self.runner and self.runner.get('runnerStatus') == 'completed'
                             and self.runner.get('cleanup', {}).get('status') == 'completed'
                             and (self.runner.get('taskOutcome') or {}).get('status') == 'timeout')
        self.identity = None
        self.raw_digest = None
        self.skipped_errors = 0

    def rows(self):
        path = self.directory / 'task/observations.jsonl.gz'
        raw_hash = hashlib.sha256()
        prior_fence = -1
        start_tick = prior_tick = None
        count = 0
        with gzip.open(path, 'rb') as stream:
            def encoded_records():
                for raw in stream:
                    raw_hash.update(raw)
                    yield json.loads(raw)
            for count, row in enumerate(observation_codec.decode_observations(encoded_records()), 1):
                if (row.get('schemaVersion') != '2' or row.get('kind') not in ('initial', 'scheduled')
                        or not row.get('attempt') or not isinstance(row.get('capturedAt'), str)):
                    raise ValueError(f'Invalid observation at line {count}')
                if count == 1:
                    if row['kind'] != 'initial' or row.get('error'):
                        raise ValueError('Successful initial observation required')
                    start_tick = row.get('receipt', {}).get('serverTick')
                    if not integer(start_tick):
                        raise ValueError('Initial receipt missing')
                    prior_tick = start_tick
                    self.identity = row['attempt']
                if row['attempt'] != self.identity:
                    raise ValueError(f'Attempt identity changed at line {count}')
                if row.get('error'):
                    self.skipped_errors += 1
                    continue
                evaluation = row.get('evaluation') or {}
                if (not row.get('actor') or 'inventory' not in row or not evaluation
                        or any(evaluation.get(s, {}).get('status') not in ('ok', 'unavailable')
                               for s in ('location', 'advancements', 'nearbyPortals'))):
                    raise ValueError(f'Missing fact sections at line {count}')
                tick = row.get('receipt', {}).get('serverTick')
                fence = row.get('receipt', {}).get('fenceSequence')
                if (not integer(tick) or not integer(fence) or tick < prior_tick or fence <= prior_fence
                        or row.get('elapsedTick') != tick - start_tick):
                    raise ValueError(f'Invalid receipt at line {count}')
                prior_tick, prior_fence = tick, fence
                if row['elapsedTick'] <= self.rubric['tickBudget']:
                    yield row
        if not count:
            raise ValueError('Successful initial observation required')
        self.raw_digest = raw_hash.hexdigest()

    def metadata(self):
        terminal = ({'runnerStatus': 'unknown'} if self.runner is None else {
            'runnerStatus': self.runner['runnerStatus'], 'taskOutcome': self.runner.get('taskOutcome'),
            'cleanupStatus': self.runner.get('cleanup', {}).get('status', 'unknown')})
        return dict(scorerVersion='2', observationSchemaVersion='2',
                    observationEncoding=observation_codec.FORMAT['encoding'],
                    observationEncodingVersion=observation_codec.FORMAT['encodingVersion'],
                    rubricRevision=self.rubric['revision'], rubricSha256=self.rubric_digest,
                    rawLogSha256=self.raw_digest, tickBudget=self.rubric['tickBudget'],
                    terminalClassification=terminal, primaryEligible=self.eligible,
                    skippedCollectionErrors=self.skipped_errors, attempt=self.identity)


def held_ids(row):
    inventory = row['inventory']
    if not inventory:
        return set()
    slots = inventory.get('slots')
    if not isinstance(slots, list) or len(slots) != 36:
        raise ValueError('Invalid scoring inventory')
    if any(slot.get('slot') != index for index, slot in enumerate(slots)):
        raise ValueError('Invalid inventory slot order')
    armor = inventory.get('armor') or {}
    stacks = [s.get('item') for s in slots] + [inventory.get('mainhand'), inventory.get('offhand')]
    stacks += [armor.get(key) for key in ('head', 'chest', 'legs', 'feet')]
    for stack in stacks:
        if stack is not None and (not integer(stack.get('count')) or stack['count'] < 0
                                  or not isinstance(stack.get('itemId'), str)
                                  or not re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9/._-]+', stack['itemId'])):
            raise ValueError('Invalid canonical item stack')
    return {s['itemId'] for s in stacks if s and s['count'] > 0}


def write_score(output, score, curve):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / 'score.json', score)
    write_json(output / 'curve.json', curve)


def harness_label(config):
    """Name the agent a config runs: the reference Harness by its model and tool mode, any other by its command."""
    harness = config.get('harness') or {}
    settings = harness.get('config') or {}
    model = settings.get('model') if isinstance(settings, dict) else None
    if isinstance(model, dict):
        model = model.get('model')
    if not isinstance(model, str):
        model = ' '.join(harness.get('command') or ['unnamed-harness'])
    mode = settings.get('mode', 'code') if isinstance(settings, dict) else 'custom'
    return model, mode
