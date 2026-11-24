"""Check breadth statistics and serial/process equivalence on small artificial logs."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('evaluate_discovery', HERE / 'evaluate-discovery.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from observation_fixtures import write_observations


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class EvaluationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.run = Path(self.temp.name) / 'run'
        self.plan = []
        self.add_execution(0, 'world-one', 'grounded_evidence', ['minecraft:iron_pickaxe'], 2)
        self.add_execution(1, 'world-two', 'grounded_evidence', ['minecraft:iron_ingot', 'minecraft:coal'], 6)
        self.add_execution(2, 'world-three', 'loaded_world_state', ['minecraft:diamond_pickaxe'], 4)
        write(self.run / 'dry-run.json', {'executions': self.plan})
        self.output = self.run / 'eval/scored'

    def add_execution(self, index, instance, profile, items, tick):
        snapshot = self.run / f'worlds/{index}'
        write(snapshot / 'manifest.json', {'seed': str(index), 'sha256': f'world-{index}'})
        config = self.run / f'inputs/configs/{instance}.json'
        write(config, dict(snapshotPath=str(snapshot), profile=profile, tickBudget=20,
                           model={'model': 'fixture-model'}, mode='code'))
        self.plan.append({'instance': {'id': instance, 'configPath': str(config)}, 'repetition': 0})
        attempt = self.run / f'raw/batch/execution-{index}/attempt-{index}'
        identity = dict(attemptId=attempt.name, instanceId=instance, directory=str(attempt))
        write(attempt / 'runner/attempt.json', dict(identity=identity, runnerStatus='completed',
              cleanup={'status': 'completed'}, taskOutcome={'status': 'timeout'}, startedAt='2026-01-02'))

        def row(kind, t, ids):
            return dict(schemaVersion='2', attempt=identity, kind=kind, capturedAt='now',
                elapsedTick=t, receipt={'serverTick': t, 'fenceSequence': t + 1},
                actor={'present': True, 'dimension': 'minecraft:overworld'},
                inventory={'slots': [dict(slot=i, item={'itemId': ids[i], 'count': 1} if i < len(ids) else None)
                                     for i in range(36)]},
                evaluation={s: {'status': 'unavailable'} for s in ['location', 'advancements', 'nearbyPortals']})

        rows = [row('initial', 0, []), row('scheduled', tick, items),
                row('scheduled', 10, [])]
        write_observations(attempt / 'task/observations.jsonl.gz', rows)

    def evaluate(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return module.evaluate(self.run, self.output, workers=1)

    def test_raw_scoring_exact_integration_and_independent_profiles(self):
        result = self.evaluate()
        self.assertEqual(result['G']['n'], 2)
        self.assertEqual(result['G']['scoreMean'], 1.5)
        self.assertAlmostEqual(result['G']['scoreSD'], 2 ** -0.5)
        self.assertAlmostEqual(result['G']['timeAverageBreadthMean'], (18 + 2 * 14) / 40)
        self.assertAlmostEqual(result['G']['timeAverageBreadthSD'], 0.5 / 2 ** 0.5)
        self.assertEqual(result['L']['scoreMean'], 1)
        self.assertEqual(result['L']['timeAverageBreadthMean'], 0.8)
        self.assertIsNone(result['L']['scoreSD'])
        g = json.loads((self.output / 'groups/G.json').read_text())
        self.assertEqual(g['curve']['points'], [dict(tick=0, value=0), dict(tick=2, value=0.5),
                                              dict(tick=6, value=1.5), dict(tick=20, value=1.5)])
        self.assertEqual(g['worldKnowledgeProfile'], 'grounded_evidence')
        self.assertNotIn('maximumScore', g)


    def test_process_outputs_match_serial(self):
        outputs = [self.run / 'eval/serial', self.run / 'eval/parallel']
        for workers, output in zip([1, 2], outputs):
            result = subprocess.run([sys.executable, str(HERE / 'evaluate-discovery.py'),
                '--run', str(self.run), '--out', str(output), '--workers', str(workers)],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
        for path in outputs[0].glob('attempts/*/*.json'):
            self.assertEqual(path.read_bytes(), (outputs[1] / path.relative_to(outputs[0])).read_bytes())
        self.assertEqual((outputs[0] / 'summary.json').read_bytes(), (outputs[1] / 'summary.json').read_bytes())


if __name__ == '__main__':
    unittest.main()
