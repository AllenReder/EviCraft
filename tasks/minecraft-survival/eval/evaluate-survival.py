#!/usr/bin/env python3
"""Score a frozen Survival run and publish one ready-to-use dataset per G/L profile."""
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import json
import multiprocessing
import os
from pathlib import Path
import sys
import time

from survival_results import conditions, publish_groups, select_attempts
from survival_worker import score_job

HERE = Path(__file__).resolve().parent
DEFAULT_WORKERS = min(32, len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else (os.cpu_count() or 1))


def evaluate(run, output, scores_from=None, workers=DEFAULT_WORKERS):
    if workers < 1:
        raise ValueError('workers must be positive')
    run, output = Path(run).resolve(), Path(output).resolve()
    selected, diagnostics = select_attempts(run)
    if not selected:
        raise ValueError('No eligible completed Attempts in run')
    if output.exists():
        raise ValueError(f'Choose a new evaluation directory: {output}')
    if scores_from:
        source = Path(scores_from).resolve()
        paths = [source / 'attempts' / attempt.name / 'score.json' for attempt in selected]
        for path in paths:
            if not path.is_file():
                raise FileNotFoundError(f'Selected Attempt has no existing score: {path}')
    else:
        _, configs = conditions(run)
        budgets = {c['tickBudget'] for c in configs.values()}
        if len(budgets) != 1:
            raise ValueError('All configurations in this evaluation must use the same budget')
        output.mkdir(parents=True)
        (output / 'inputs').mkdir()
        rubric = json.loads((HERE / 'survival-rubric.v1.json').read_bytes())
        rubric['tickBudget'] = budgets.pop()
        rubric_path = output / 'inputs/survival-rubric.v1.json'
        rubric_path.write_text(json.dumps(rubric, indent=2) + '\n')
        workers = min(workers, len(selected))
        started = time.monotonic()
        print(f'Scoring {len(selected)} Attempts: workers={workers} executor=process', file=sys.stderr, flush=True)
        jobs = [(str(attempt), str(rubric_path), str(output)) for attempt in selected]
        paths = [output / 'attempts' / attempt.name / 'score.json' for attempt in selected]

        def progress(done, path):
            elapsed = time.monotonic() - started
            eta = elapsed / done * (len(selected) - done)
            print(f'[{done}/{len(selected)}] {path.parent.name} elapsed={elapsed:.1f}s ETA={eta:.1f}s',
                  file=sys.stderr, flush=True)

        if workers == 1:
            for done, job in enumerate(jobs, 1):
                progress(done, score_job(job))
        else:
            # Separate interpreters bypass the GIL during JSON parsing and scoring.
            # An importable worker also works with spawn and programmatic callers.
            with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context('spawn')) as pool:
                futures = [pool.submit(score_job, job) for job in jobs]
                try:
                    for done, future in enumerate(as_completed(futures), 1):
                        progress(done, future.result())
                except BaseException:
                    for future in futures:
                        future.cancel()
                    raise
        source = output
    summaries = publish_groups(run, paths, output, source, diagnostics)
    print(json.dumps({'output': str(output), 'groups': summaries}, indent=2))
    return summaries


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True, help='Run directory containing dry-run.json, inputs and raw')
    parser.add_argument('--out', type=Path, required=True, help='New evaluation directory')
    parser.add_argument('--scores-from', type=Path, help='Reuse an existing evaluation instead of rescoring observations')
    parser.add_argument('--workers', type=int, default=DEFAULT_WORKERS,
                        help=f'Scoring processes (default: {DEFAULT_WORKERS}; capped at eligible Attempt count)')
    args = parser.parse_args()
    if args.workers < 1:
        parser.error('--workers must be positive')
    evaluate(args.run, args.out, args.scores_from, args.workers)
