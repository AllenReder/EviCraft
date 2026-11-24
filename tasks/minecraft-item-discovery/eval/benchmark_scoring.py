"""Measure serial/process scoring on identical real Attempts and compare every output byte."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import json
import multiprocessing
from pathlib import Path
import resource
import time

from discovery_results import conditions, select_attempts
from discovery_worker import score_job


def cpu_seconds():
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return time.process_time() + children.ru_utime + children.ru_stime


def benchmark(run, output, limit, workers):
    selected, _ = select_attempts(run)
    selected = selected[:limit]
    if not selected:
        raise ValueError('No eligible Attempts')
    _, configs = conditions(run)
    budgets = {c['tickBudget'] for c in configs.values()}
    if len(budgets) != 1:
        raise ValueError('Expected one budget')
    if output.exists():
        raise ValueError(f'Choose a new benchmark directory: {output}')
    output.mkdir(parents=True)
    rubric = json.loads(Path(__file__).with_name('discovery-rubric.v1.json').read_text())
    rubric['tickBudget'] = budgets.pop()
    rubric_path = output / 'rubric.json'
    rubric_path.write_text(json.dumps(rubric, indent=2) + '\n')
    report = dict(run=str(run), attempts=[str(a) for a in selected], workers=min(workers, len(selected)),
                  order=['serial', 'processes'], measurements={})
    for name in report['order']:
        jobs = [(str(a), str(rubric_path), str(output / name)) for a in selected]
        started, cpu = time.perf_counter(), cpu_seconds()
        if name == 'serial':
            for index, job in enumerate(jobs, 1):
                score_job(job)
                print(f'serial [{index}/{len(jobs)}]', flush=True)
        else:
            with ProcessPoolExecutor(max_workers=report['workers'],
                                     mp_context=multiprocessing.get_context('spawn')) as pool:
                list(pool.map(score_job, jobs))
        report['measurements'][name] = dict(wallSeconds=time.perf_counter() - started,
                                            cpuSeconds=cpu_seconds() - cpu)
        print(json.dumps({name: report['measurements'][name]}), flush=True)
    for attempt in selected:
        for filename in ('score.json', 'curve.json'):
            paths = [output / name / 'attempts' / attempt.name / filename for name in report['order']]
            if paths[0].read_bytes() != paths[1].read_bytes():
                raise AssertionError(f'Output mismatch: {attempt.name}/{filename}')
    report['outputsByteIdentical'] = True
    report['speedup'] = report['measurements']['serial']['wallSeconds'] / report['measurements']['processes']['wallSeconds']
    report['note'] = 'Serial first, processes second; file cache and concurrent node load may affect timings.'
    (output / 'benchmark.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=6)
    parser.add_argument('--workers', type=int, default=6)
    args = parser.parse_args()
    if min(args.limit, args.workers) < 1:
        parser.error('--limit and --workers must be positive')
    benchmark(args.run.resolve(), args.out.resolve(), args.limit, args.workers)
