"""Compare thread/process throughput and exact outputs on the same real Attempts."""
import argparse
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
import json
import multiprocessing
from pathlib import Path
import resource
import time

from survival_results import conditions, select_attempts
from survival_worker import score_job


def cpu_seconds():
    return time.process_time() + resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime + resource.getrusage(resource.RUSAGE_CHILDREN).ru_stime


def benchmark(run, output, limit, workers):
    selected, _ = select_attempts(run)
    selected = selected[:limit]
    if not selected:
        raise ValueError('No eligible Attempts')
    _, configs = conditions(run)
    budgets = {c['tickBudget'] for c in configs.values()}
    if len(budgets) != 1:
        raise ValueError('Expected one budget')
    output.mkdir(parents=True)
    rubric = json.loads(Path(__file__).with_name('survival-rubric.v1.json').read_text())
    rubric['tickBudget'] = budgets.pop()
    rubric_path = output / 'rubric.json'
    rubric_path.write_text(json.dumps(rubric, indent=2) + '\n')
    report = dict(run=str(run), attempts=[str(a) for a in selected], workers=min(workers, len(selected)), measurements={})
    for name, executor in [('threads', ThreadPoolExecutor), ('processes', ProcessPoolExecutor)]:
        jobs = [(str(a), str(rubric_path), str(output / name)) for a in selected]
        options = dict(max_workers=report['workers'])
        if name == 'processes':
            options['mp_context'] = multiprocessing.get_context('spawn')
        started, cpu = time.perf_counter(), cpu_seconds()
        with executor(**options) as pool:
            list(pool.map(score_job, jobs))
        wall = time.perf_counter() - started
        report['measurements'][name] = dict(wallSeconds=wall, cpuSeconds=cpu_seconds() - cpu)
        print(json.dumps({name: report['measurements'][name]}), flush=True)
    for attempt in selected:
        for filename in ['score.json', 'curve.json']:
            files = [output / name / 'attempts' / attempt.name / filename for name in ['threads', 'processes']]
            if files[0].read_bytes() != files[1].read_bytes():
                raise AssertionError(f'Output mismatch: {attempt.name}/{filename}')
    report['outputsByteIdentical'] = True
    report['speedup'] = report['measurements']['threads']['wallSeconds'] / report['measurements']['processes']['wallSeconds']
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
