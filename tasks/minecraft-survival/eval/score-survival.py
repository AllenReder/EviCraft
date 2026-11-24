#!/usr/bin/env python3
"""Score one Survival Attempt's observations using the v1 rubric."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'minecraft-common/eval'))
from scoring_common import Observations, held_ids, integer, write_score


def confirmed(node, row, ids):
    p = node['predicate']
    kind = p['kind']
    if kind == 'held_item':
        return bool(ids.intersection(p['itemIds']))
    if kind == 'dimension':
        return row['actor'].get('present') is True and row['actor'].get('dimension') == p['dimension']
    if kind == 'inside_structure':
        location = row['evaluation']['location']
        return location['status'] == 'ok' and any(s['id'] == p['structureId'] for s in location['value']['structuresContainingActor'])
    if kind in ('portal_frame', 'portal_active', 'end_portal_approach'):
        portals = row['evaluation']['nearbyPortals']
        if portals['status'] != 'ok':
            return False
        for c in portals['value']['candidates']:
            if c['kind'] != p['portal']:
                continue
            if kind == 'portal_frame' and c['frameComplete']:
                return True
            if kind == 'portal_active' and c['active']:
                return True
            if kind == 'end_portal_approach' and any(b['blockState'].startswith('minecraft:end_portal_frame') for b in c['evidence']):
                return True
        return False
    raise ValueError(f'Unknown predicate: {kind}')


def score_attempt(attempt, rubric, output):
    loaded = Observations(attempt, rubric)
    nodes = loaded.rubric.get('nodes')
    if loaded.rubric['metric'] != 'highest_confirmed_survival_node' or not isinstance(nodes, list):
        raise ValueError('Wrong Survival rubric')
    if (not nodes or len({n['id'] for n in nodes}) != len(nodes)
            or any(not isinstance(n['id'], str) or not integer(n['points']) or n['points'] <= 0 for n in nodes)):
        raise ValueError('Invalid nodes')
    first = {}
    highest = 0
    points = [{'tick': 0, 'value': 0}]
    for row in loaded.rows():
        ids = held_ids(row)
        for node in nodes:
            if node['id'] not in first and confirmed(node, row, ids):
                first[node['id']] = row['elapsedTick']
                highest = max(highest, node['points'])
        if points[-1]['value'] != highest:
            point = {'tick': row['elapsedTick'], 'value': highest}
            if points[-1]['tick'] == row['elapsedTick']:
                points[-1] = point
            else:
                points.append(point)
    budget = loaded.rubric['tickBudget']
    auc = sum(point['value'] * ((points[i + 1]['tick'] if i + 1 < len(points) else budget) - point['tick'])
              for i, point in enumerate(points))
    maximum = max(n['points'] for n in nodes)
    if points[-1]['tick'] < budget:
        points.append({'tick': budget, 'value': highest})
    meta = {**loaded.metadata(), 'metric': loaded.rubric['metric']}
    score = dict(meta, score=highest, maximum=maximum, sAtBudget=highest, normalizedScore=highest / maximum,
                 auc=auc, nAUC=auc / (maximum * budget), firstConfirmationTicks=first)
    write_score(output, score, dict(meta, points=points))
    return score


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('attempt', 'rubric', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    score_attempt(args.attempt, args.rubric, args.out)
