#!/usr/bin/env python3
"""Score one Discovery Attempt's observations using the v1 rubric."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'minecraft-common/eval'))
from scoring_common import Observations, held_ids, write_score


def score_attempt(attempt, rubric, output):
    loaded = Observations(attempt, rubric)
    if loaded.rubric['metric'] != 'observed_unique_item_ids':
        raise ValueError('Wrong Discovery rubric')
    first, points = {}, []
    for row in loaded.rows():
        for item in sorted(held_ids(row)):
            first.setdefault(item, row['elapsedTick'])
        if not points or points[-1]['value'] != len(first):
            point = {'tick': row['elapsedTick'], 'value': len(first)}
            if points and points[-1]['tick'] == row['elapsedTick']:
                points[-1] = point
            else:
                points.append(point)
    if points[-1]['tick'] < loaded.rubric['tickBudget']:
        points.append({'tick': loaded.rubric['tickBudget'], 'value': len(first)})
    meta = {**loaded.metadata(), 'metric': loaded.rubric['metric']}
    score = dict(meta, total=len(first), uObsAtBudget=len(first), firstConfirmationTicks=dict(sorted(first.items())))
    write_score(output, score, dict(meta, points=points))
    return score


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('attempt', 'rubric', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    score_attempt(args.attempt, args.rubric, args.out)
