"""Task-owned Discovery aggregation: final breadth, time-average breadth and exact curves."""
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'minecraft-common/eval'))
from scoring_common import harness_label, integer, read_json, write_json


def close(actual, expected, context):
    if not math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-10):
        raise ValueError(f'{context}: {actual} != {expected}')


def curve_area(points):
    return math.fsum(a['value'] * (b['tick'] - a['tick']) for a, b in zip(points, points[1:]))


def validate_curve(score, curve, path):
    for field in ('scorerVersion', 'rubricRevision', 'rubricSha256',
                  'rawLogSha256', 'tickBudget', 'metric', 'primaryEligible', 'attempt',
                  'terminalClassification', 'observationSchemaVersion'):
        if score[field] != curve[field]:
            raise ValueError(f'Score/curve {field} mismatch: {path}')
    budget, total, first = score['tickBudget'], score['total'], score['firstConfirmationTicks']
    if not integer(budget) or budget <= 0 or not integer(total) or total < 0:
        raise ValueError(f'Invalid budget/total: {path}')
    if len(first) != total or score['uObsAtBudget'] != total:
        raise ValueError(f'Final breadth does not match item confirmations: {path}')
    increments = defaultdict(int)
    increments[0] = 0
    for tick in first.values():
        if not integer(tick) or not 0 <= tick <= budget:
            raise ValueError(f'Invalid first confirmation tick: {path}')
        increments[tick] += 1
    expected, value = [], 0
    for tick in sorted(increments):
        value += increments[tick]
        expected.append(dict(tick=tick, value=value))
    if expected[-1]['tick'] < budget:
        expected.append(dict(tick=budget, value=total))
    points = curve['points']
    if points != expected:
        raise ValueError(f'Curve does not match item confirmations: {path}')
    area = curve_area(points)
    close(area, sum(budget - tick for tick in first.values()), f'Integrated breadth {path}')
    return points, area / budget


def conditions(run):
    """Use frozen task configurations, not instance-name conventions."""
    run = Path(run)
    plan = read_json(run / 'dry-run.json')
    result = {}
    for execution in plan['executions']:
        instance = execution['instance']
        if instance['id'] in result:
            continue
        path = Path(instance['configPath'])
        config = read_json(path)
        profile = {'grounded_evidence': 'G', 'loaded_world_state': 'L'}[config['profile']]
        snapshot = Path(config['snapshotPath'])
        if not snapshot.is_absolute():
            snapshot = path.parent / snapshot
        world = read_json(snapshot / 'manifest.json')
        model, mode = harness_label(config)
        result[instance['id']] = dict(model=model, mode=mode,
                                       profile=profile, worldKnowledgeProfile=config['profile'],
                                       seed=str(world['seed']), worldSha256=world['sha256'],
                                       tickBudget=config['tickBudget'])
    if len({(c['model'], c['mode']) for c in result.values()}) != 1:
        raise ValueError('Evaluate one model and execution mode per run directory')
    return plan, result


def select_attempts(run):
    """Adopt the first eligible Attempt for each planned execution, preserving diagnostics."""
    chosen, diagnostics = [], []
    for execution in sorted((Path(run) / 'raw').glob('*/execution-*')):
        records = [(path.parent.parent, read_json(path)) for path in execution.glob('*/runner/attempt.json')]
        records.sort(key=lambda item: (item[1].get('startedAt', ''), str(item[0])))
        eligible = []
        for path, record in records:
            ok = (record.get('runnerStatus') == 'completed'
                  and record.get('cleanup', {}).get('status') == 'completed'
                  and (record.get('taskOutcome') or {}).get('status') == 'timeout')
            if ok:
                eligible.append(path)
            diagnostics.append(dict(attempt=str(path), runnerStatus=record.get('runnerStatus'), eligible=ok))
        if eligible:
            chosen.append(eligible[0])
    return chosen, diagnostics


def publish_groups(run, score_paths, output, source_evaluation, diagnostics):
    run, output = Path(run).resolve(), Path(output).resolve()
    plan, configs = conditions(run)
    groups, inputs, signatures, seen = defaultdict(list), {}, set(), set()
    for path in score_paths:
        path = Path(path).resolve()
        score = read_json(path)
        terminal = score['terminalClassification']
        if (not score.get('primaryEligible') or terminal.get('runnerStatus') != 'completed'
                or terminal.get('cleanupStatus') != 'completed'
                or (terminal.get('taskOutcome') or {}).get('status') != 'timeout'):
            raise ValueError(f'Invalid primary terminal state: {path}')
        identity = score['attempt']
        if identity['attemptId'] != path.parent.name or identity['attemptId'] in seen:
            raise ValueError(f'Wrong or duplicate Attempt: {path}')
        seen.add(identity['attemptId'])
        config = configs[identity['instanceId']]
        if score['tickBudget'] != config['tickBudget'] or score['metric'] != 'observed_unique_item_ids':
            raise ValueError(f'Score does not match frozen task configuration: {path}')
        curve_path = path.with_name('curve.json')
        points, time_average = validate_curve(score, read_json(curve_path), path)
        signatures.add((score['tickBudget'], score['rubricSha256'], score['scorerVersion']))
        if len(signatures) != 1:
            raise ValueError('Cannot aggregate mixed budgets, rubrics or scorer implementations')
        for source in (path, curve_path):
            inputs[str(source)] = hashlib.sha256(source.read_bytes()).hexdigest()
        groups[config['profile']].append(dict(config=config, score=score, points=points,
            timeAverageBreadth=time_average, scorePath=str(path), curvePath=str(curve_path)))
    if not groups:
        raise ValueError('No eligible scores to aggregate')
    summaries, datasets = {}, {}
    for profile, rows in sorted(groups.items()):
        config, budget = rows[0]['config'], rows[0]['score']['tickBudget']
        changes = defaultdict(list)
        for row in rows:
            previous = 0
            for point in row['points']:
                changes[point['tick']].append(point['value'] - previous)
                previous = point['value']
        changes[budget]
        total, points = 0, []
        for tick in sorted(changes):
            total += math.fsum(changes[tick])
            points.append(dict(tick=tick, value=total / len(rows)))
        scores = [r['score']['total'] for r in rows]
        averages = [r['timeAverageBreadth'] for r in rows]
        summary = dict(n=len(rows), nWorlds=len({r['config']['worldSha256'] for r in rows}),
            scoreMean=statistics.fmean(scores), scoreSD=statistics.stdev(scores) if len(scores) > 1 else None,
            scoreMedian=statistics.median(scores), scoreMin=min(scores), scoreMax=max(scores),
            timeAverageBreadthMean=statistics.fmean(averages),
            timeAverageBreadthSD=statistics.stdev(averages) if len(averages) > 1 else None)
        close(points[-1]['value'], summary['scoreMean'], 'Mean final breadth')
        close(curve_area(points) / budget, summary['timeAverageBreadthMean'], 'Mean curve integral')
        datasets[profile] = dict(schemaVersion=1, taskId='minecraft-item-discovery',
            model=config['model'], mode=config['mode'], profile=profile,
            worldKnowledgeProfile=config['worldKnowledgeProfile'], tickBudget=budget,
            weighting='equal eligible run weights; sample SD uses ddof=1', summary=summary,
            curve=dict(points=points),
            runs=[dict(attemptId=r['score']['attempt']['attemptId'], seed=r['config']['seed'],
                worldSha256=r['config']['worldSha256'], score=r['score']['total'],
                timeAverageBreadth=r['timeAverageBreadth'], scorePath=r['scorePath'],
                curvePath=r['curvePath']) for r in rows],
            source=dict(run=str(run), evaluation=str(source_evaluation),
                rubricSha256=rows[0]['score']['rubricSha256']))
        summaries[profile] = summary
    output.mkdir(parents=True, exist_ok=True)
    (output / 'groups').mkdir()
    for profile, dataset in datasets.items():
        write_json(output / f'groups/{profile}.json', dataset)
    write_json(output / 'summary.json', dict(schemaVersion=1, plannedExecutions=len(plan['executions']),
        adoptedRuns=len(seen), groups=summaries))
    write_json(output / 'manifest.json', dict(schemaVersion=1,
        generatedAt=datetime.now(timezone.utc).isoformat(), run=str(run),
        scoresFrom=str(source_evaluation),
        inputSha256=inputs, attempts=diagnostics, groupFiles=[f'groups/{p}.json' for p in sorted(groups)]))
    return summaries
