# Survival scoring and group data

This directory holds all scoring and group statistics code for Survival. The scripts use only the Python
standard library.

```text
raw Attempt logs → per-Attempt score and curve → model × execution mode × profile group data
                                                          ↓
                                              figures and tables only display it
```

## Scoring a run

```bash
python3 tasks/minecraft-survival/eval/evaluate-survival.py \
  --run /absolute/path/to/run \
  --out /absolute/path/to/run/eval/<new-evaluation-id>
```

The entry point:

1. Reads the model, mode, profile, world identity, and budget from `dry-run.json` and the frozen configs. It
   never infers the profile from directory names.
2. For each execution, takes the first Attempt whose Runner and cleanup completed and whose Task ended in
   `timeout`. Earlier failed Attempts are kept as diagnostics.
3. Calls `score-survival.py`, which stream-decodes the gzip observation log in the
   [partition-replace encoding](../../minecraft-common/observation-format.md). The rubric copy's budget is
   matched to the configs.
4. Writes, separately for each profile, the mean, sample standard deviation, median, and range of the final
   score, the mean nAUC, the numbers of Attempts and worlds, and the full mean step curve.

Scoring runs in up to 32 worker processes by default (fewer when the CPU affinity allows fewer).
`--workers N` changes the number; the effective count never exceeds the number of eligible Attempts, and
`--workers 1` scores sequentially in the main process. Progress and a rough ETA go to stderr; the final JSON
goes to stdout. The order in which Attempts finish does not affect selection, scores, curves, or statistics.
If any step fails, no group summary is published; rerun into a new output directory.

One run directory holds one model and one execution mode. G and L are independent groups, and either may be
absent.

### Reusing existing scores

```bash
python3 tasks/minecraft-survival/eval/evaluate-survival.py \
  --run /absolute/path/to/run \
  --scores-from /absolute/path/to/run/eval/<existing-evaluation-id> \
  --out /absolute/path/to/run/eval/<new-grouped-evaluation-id>
```

This reuses each `score.json` and `curve.json` and writes only the group outputs, without reading the
observations again or rewriting the earlier evaluation. It fails if the first eligible Attempt has no score.
The new manifest and group files record the evaluation they came from.

### Scoring one Attempt

```bash
python3 tasks/minecraft-survival/eval/score-survival.py \
  --attempt /absolute/path/to/attempt \
  --rubric /absolute/path/to/budget-matched-rubric.json \
  --out /absolute/path/to/new-score-directory
```

This scores one Attempt and computes no cross-Attempt statistics. Pass a rubric whose `tickBudget` matches
the Attempt; the batch entry point makes that copy itself.

## Outputs

```text
eval/<evaluation-id>/
├── inputs/survival-rubric.v1.json  # written when scoring from raw logs
├── attempts/<attempt-id>/
│   ├── score.json                  # score, nAUC, first confirmation tick per milestone, input hashes
│   └── curve.json                  # the Attempt's step curve
├── groups/
│   ├── G.json                      # one complete group, ready to display
│   └── L.json                      # the other, independent group
├── summary.json                    # planned executions, adopted Attempts, and per-group statistics
└── manifest.json                   # sources, input hashes, and diagnostics
```

With `--scores-from`, only `groups/`, `summary.json`, and `manifest.json` are written; the per-Attempt scores
stay in the original evaluation, which the group files point back to.

Each group file (`schemaVersion` 1) contains:

- `model`, `mode`, `profile` (G or L), `worldKnowledgeProfile`: the experimental condition.
- `tickBudget`, `maximumScore`, `weighting`: the budget, the score range, and the within-group weighting.
- `summary`: `n`, `nWorlds`, `scoreMean`, `scoreSD`, `scoreMedian`, `scoreMin`, `scoreMax`, `nAUCMean`,
  `nAUCSD`. SD is the sample standard deviation, and `null` for a single Attempt.
- `curve.points`: the full mean step curve as `{tick, value}` points.
- `runs`: each adopted Attempt's seed, world identity, score, nAUC, and score path.
- `source`: the run and evaluation directories and the rubric hash.

A figure or table reads one group file as-is, for example DeepSeek G and DeepSeek L as two entries, without
re-aggregating.

## Rules

- Each of the 22 milestones counts once, at the highest score ever reached; scores are not summed across
  samples. Only `initial` and `scheduled` samples are used.
- Eligible Attempts in a group are weighted equally. Failed Attempts are excluded rather than scored 0, and
  worlds are not reweighted.
- The mean curve keeps every tick at which any Attempt changed, so its exact integral equals the mean nAUC.
  Each Attempt's score and curve are checked against each other.
- G/L differences and world-paired tests are further analysis, not part of the group scoring.

## Files

- `score-survival.py`: scores one Attempt.
- `evaluate-survival.py`: the command-line entry point; scores a run or reuses existing scores.
- `survival_results.py`: config reading, Attempt selection, group statistics, and mean curves.
- `survival_worker.py`: the importable per-Attempt job for worker processes.
- `benchmark_scoring.py`: times thread- and process-based scoring on the same logs and compares the outputs
  byte for byte.
- `test_evaluation.py`: regression tests for scores, group statistics, and curve integrals on synthetic logs,
  and for agreement between sequential and parallel scoring.
- `survival-rubric.v1.json`: the scoring rules.
- `../../minecraft-common/eval/scoring_common.py`: the shared observation reader and scoring metadata.

```bash
python3 -m unittest discover -s tasks/minecraft-survival/eval -p test_evaluation.py -v
npx vitest run tasks/minecraft-common/scoring.test.ts
```

To compare scoring speed on real logs:

```bash
python3 tasks/minecraft-survival/eval/benchmark_scoring.py \
  --run /absolute/path/to/run \
  --out /absolute/path/to/comparisons/<new-benchmark-id> --limit 6 --workers 6
```

Both implementations score the same raw logs in full with the same scorer and rubric. The output holds both
sets of per-Attempt results and `benchmark.json` (wall-clock and CPU time, speedup, and byte-level agreement).
Threads run first and processes second, so the latter may benefit from the file system cache; the ratio
reflects only that run's machine load and sample.
