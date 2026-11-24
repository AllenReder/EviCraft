"""Task-owned validation and aggregation of Survival scores into independent profile datasets."""
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "minecraft-common/eval"))
from scoring_common import harness_label, read_json, write_json


def close(actual, expected, context):
    if not math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-10):
        raise ValueError(f"{context}: {actual} != {expected}")


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_curve(score, curve, path):
    """Reject mismatched or corrupt snapshots before they can enter a mean."""
    for field in ("scorerVersion", "rubricRevision", "rubricSha256",
                  "rawLogSha256", "tickBudget", "metric", "primaryEligible", "attempt",
                  "terminalClassification", "observationSchemaVersion"):
        if score[field] != curve[field]:
            raise ValueError(f"Score/curve {field} mismatch: {path}")
    budget, maximum = score["tickBudget"], score["maximum"]
    if (not isinstance(budget, int) or isinstance(budget, bool) or budget <= 0
            or not finite(maximum) or maximum <= 0):
        raise ValueError(f"Invalid budget/maximum: {path}")
    points = curve["points"]
    if not points or points[0]["tick"] != 0 or points[-1]["tick"] != budget:
        raise ValueError(f"Curve must span [0, {budget}]: {path}")
    prior_tick, prior_value, area = -1, 0, 0
    for point in points:
        tick, value = point["tick"], point["value"]
        if (not isinstance(tick, int) or isinstance(tick, bool)
                or not 0 <= tick <= budget or tick <= prior_tick
                or not finite(value) or not prior_value <= value <= maximum):
            raise ValueError(f"Invalid/nonmonotone curve point: {path}: {point}")
        if prior_tick >= 0:
            area += prior_value * (tick - prior_tick)
        prior_tick, prior_value = tick, value
    for key in ("score", "nAUC"):
        if not finite(score[key]):
            raise ValueError(f"Nonfinite {key}: {path}")
    close(prior_value, score["score"], f"Final score {path}")
    close(area / (budget * maximum), score["nAUC"], f"Integrated nAUC {path}")
    return [(p["tick"], p["value"]) for p in points]


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
    groups = defaultdict(list)
    signatures = set()
    seen = set()
    inputs = {}
    for path in score_paths:
        path = Path(path).resolve()
        score = read_json(path)
        if not score.get('primaryEligible'):
            continue
        terminal = score['terminalClassification']
        if (terminal.get('runnerStatus') != 'completed' or terminal.get('cleanupStatus') != 'completed'
                or (terminal.get('taskOutcome') or {}).get('status') != 'timeout'):
            raise ValueError(f'Invalid primary terminal state: {path}')
        identity = score['attempt']
        if identity['attemptId'] in seen:
            raise ValueError(f'Duplicate Attempt: {path}')
        seen.add(identity['attemptId'])
        config = configs[identity['instanceId']]
        if score['tickBudget'] != config['tickBudget'] or score['metric'] != 'highest_confirmed_survival_node':
            raise ValueError(f'Score does not match frozen task configuration: {path}')
        curve_path = path.with_name('curve.json')
        curve = read_json(curve_path)
        points = validate_curve(score, curve, path)
        signatures.add((score['tickBudget'], score['maximum'], score['rubricSha256'], score['scorerVersion']))
        if len(signatures) != 1:
            raise ValueError('Cannot aggregate mixed budgets, rubrics or scorer implementations')
        for input_path in (path, curve_path):
            inputs[str(input_path)] = hashlib.sha256(input_path.read_bytes()).hexdigest()
        groups[config['profile']].append(dict(config=config, score=score, points=points,
                                              scorePath=str(path), curvePath=str(curve_path)))
    if not groups:
        raise ValueError('No eligible scores to aggregate')
    output.mkdir(parents=True, exist_ok=True)
    (output / 'groups').mkdir()
    summaries = {}
    for profile, rows in sorted(groups.items()):
        budget, maximum = rows[0]['score']['tickBudget'], rows[0]['score']['maximum']
        changes = defaultdict(list)
        for row in rows:
            previous = 0
            for tick, value in row['points']:
                changes[tick].append(value - previous)
                previous = value
        changes[budget]
        total, points = 0, []
        for tick in sorted(changes):
            total += math.fsum(changes[tick])
            points.append(dict(tick=tick, value=total / len(rows)))
        scores = [r['score']['score'] for r in rows]
        aucs = [r['score']['nAUC'] for r in rows]
        summary = dict(n=len(rows), nWorlds=len({r['config']['worldSha256'] for r in rows}),
                       scoreMean=statistics.fmean(scores), scoreSD=statistics.stdev(scores) if len(scores) > 1 else None,
                       scoreMedian=statistics.median(scores), scoreMin=min(scores), scoreMax=max(scores),
                       nAUCMean=statistics.fmean(aucs), nAUCSD=statistics.stdev(aucs) if len(aucs) > 1 else None)
        close(points[-1]['value'], summary['scoreMean'], 'Mean final score')
        area = math.fsum(a['value'] * (b['tick'] - a['tick']) for a, b in zip(points, points[1:]))
        close(area / (maximum * budget), summary['nAUCMean'], 'Mean curve integral')
        config = rows[0]['config']
        dataset = dict(schemaVersion=1, taskId='minecraft-survival', model=config['model'], mode=config['mode'],
                       profile=profile, worldKnowledgeProfile=config['worldKnowledgeProfile'], tickBudget=budget,
                       maximumScore=maximum, weighting='equal eligible run weights; sample SD uses ddof=1',
                       summary=summary, curve=dict(points=points),
                       runs=[dict(attemptId=r['score']['attempt']['attemptId'], seed=r['config']['seed'],
                                  worldSha256=r['config']['worldSha256'], score=r['score']['score'], nAUC=r['score']['nAUC'],
                                  scorePath=r['scorePath'], curvePath=r['curvePath']) for r in rows],
                       source=dict(run=str(run), evaluation=str(source_evaluation),
                                   rubricSha256=rows[0]['score']['rubricSha256']))
        write_json(output / f'groups/{profile}.json', dataset)
        summaries[profile] = summary
    write_json(output / 'summary.json', dict(schemaVersion=1, plannedExecutions=len(plan['executions']),
                                             adoptedRuns=len(seen), groups=summaries))
    write_json(output / 'manifest.json', dict(schemaVersion=1, generatedAt=datetime.now(timezone.utc).isoformat(),
               run=str(run), scoresFrom=str(source_evaluation),
               inputSha256=inputs, attempts=diagnostics, groupFiles=[f'groups/{p}.json' for p in sorted(groups)]))
    return summaries
