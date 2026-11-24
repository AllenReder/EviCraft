# Discovery scoring and group data

This directory holds per-Attempt scoring, parallel scoring of a whole run, and separate G and L group data,
all written with the Python standard library.

## Scoring a run

```bash
python3 tasks/minecraft-item-discovery/eval/evaluate-discovery.py \
  --run /absolute/path/to/run \
  --out /absolute/path/to/run/eval/<new-evaluation-id> \
  --workers 32
```

- Reads the model, execution mode, profile, world identity, and budget from `dry-run.json`, the frozen
  configs, and the Snapshot manifests.
- For each execution, takes the first Attempt whose Runner and cleanup completed and whose Task ended in
  `timeout`. Failed Attempts are kept as diagnostics, not scored 0.
- Copies the v1 rubric with its budget set to the configs' actual budget, and saves the copy as an input of
  this evaluation.
- Scores from the gzip observation log in the
  [partition-replace encoding](../../minecraft-common/observation-format.md). It never reuses or rewrites an
  earlier evaluation.
- Runs up to 32 worker processes by default (capped by the CPU affinity and the number of eligible Attempts);
  an explicit `--workers` is capped only by the number of eligible Attempts. `--workers 1` scores
  sequentially. Progress, elapsed time, and a rough ETA go to stderr; the group summary goes to stdout.
- If any score or group check fails, no group summary is published. The failed directory keeps its
  diagnostics; rerun into a new output directory.

Concurrency affects only offline CPU scoring; it starts neither a model nor Minecraft.

## Metrics

- **Final breadth D(T)**: the number of distinct canonical item IDs confirmed held in the `initial` and
  `scheduled` samples. The 36 inventory slots, the main hand, the off hand, and the armor slots are
  deduplicated together; consuming or losing an item does not revoke its confirmation.
- **Time-averaged breadth Dbar**: `sum(D_i * (tick_(i+1) - tick_i)) / tickBudget`, the rectangle integral of
  the right-continuous step curve. Its unit is still a number of item kinds; it is not normalized by the
  Attempt's final value.
- `score-item-discovery.py` produces each Attempt's final value, first confirmation ticks, and curve.
  `discovery_results.py` computes Dbar from that curve and checks it against the integral of the first
  confirmation ticks.
- Eligible Attempts in a group are weighted equally. The sample standard deviation uses ddof=1 and is `null`
  for a single Attempt.
- The mean curve keeps every tick at which any Attempt changed; its final value equals the group's mean final
  value, and its integral divided by the budget equals the group's mean Dbar.
- There is no maximum item count, so there is no Survival-style nAUC. G/L paired differences, confidence
  intervals, and hypothesis tests are not part of this group summary.

## Outputs

```text
eval/<evaluation-id>/
├── inputs/discovery-rubric.v1.json
├── attempts/<attempt-id>/
│   ├── score.json
│   └── curve.json
├── groups/
│   ├── G.json
│   └── L.json
├── summary.json
└── manifest.json
```

- `score.json`: the final value, the first confirmation tick of each item, the termination state, the number
  of capture errors, and the hashes of the raw log and rubric.
- `curve.json`: the Attempt's full cumulative step curve, with the same source metadata.
- `groups/G.json` and `groups/L.json`: one independent group per model × mode × profile; both profiles need
  not be present. `summary` contains `n`, `nWorlds`, `scoreMean`, `scoreSD`, `scoreMedian`, `scoreMin`,
  `scoreMax`, `timeAverageBreadthMean`, and `timeAverageBreadthSD`. `curve.points` is the full mean curve;
  `runs` keeps each Attempt's score, Dbar, seed, world hash, and score and curve paths.
- `summary.json`: planned executions, adopted Attempts, and per-group statistics.
- `manifest.json`: scoring sources, input hashes, Attempt selection
  diagnostics, and the list of group files.

Figures and tables read the group files directly; they do not parse raw logs, select Attempts, or recompute
means, SDs, or Dbar.

## Tests and speed comparison

`test_evaluation.py` covers cumulative breadth, group statistics, and the Dbar integral on synthetic logs,
and agreement between sequential and parallel scoring.

```bash
python3 -m unittest discover -s tasks/minecraft-item-discovery/eval -p test_evaluation.py -v
npx vitest run tasks/minecraft-common/scoring.test.ts
python3 tasks/minecraft-item-discovery/eval/benchmark_scoring.py \
  --run /absolute/path/to/run \
  --out /absolute/path/to/comparisons/<new-benchmark-id> --limit 6 --workers 6
```

The speed comparison scores the same real logs first sequentially and then in parallel, writes both sets of
results and `benchmark.json` (wall-clock and CPU time, speedup), and checks each Attempt's score and curve
byte for byte. The sequential pass runs first, so file caching favors the parallel one; a small measurement
does not predict the speedup of a full 32-process run.

Files: `evaluate-discovery.py` is the CLI, `discovery_worker.py` the importable worker, `discovery_results.py`
handles configs, Attempt selection, integrals, and groups, and `benchmark_scoring.py` the speed comparison.
The shared observation reader is `../../minecraft-common/eval/scoring_common.py`.
