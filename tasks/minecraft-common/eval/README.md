# Offline scoring

Survival and Discovery each have one scoring rule set, v1 (rubric and scorer version `1`). The Task revision
and the observation schema are `2`: from this version on, the Runtime takes samples on game ticks. The
current scorers cannot read schema `1` logs.

| Task | Rubric | Rubric budget in the repository | Metrics |
| --- | --- | --- | --- |
| Survival | [survival-rubric.v1.json](../../minecraft-survival/eval/survival-rubric.v1.json) | 72,000 ticks (1 hour) | highest score over 22 independent milestones, first confirmation tick, nAUC |
| Discovery | [discovery-rubric.v1.json](../../minecraft-item-discovery/eval/discovery-rubric.v1.json) | 144,000 ticks (2 hours) | number of distinct item IDs held in any scoring sample, first confirmation tick |

The configs run Survival for 72,000 ticks and Discovery for 144,000 ticks. The budget in a rubric file must match the run it
scores. When it does not, save a copy of the v1 rubric in that evaluation's `inputs/` directory, change only
its `tickBudget` to the run's budget, and pass the copy to the scorer. The batch entry points do this
themselves.

There are only two kinds of samples: the initial observation (elapsed tick 0) and scheduled samples. The
Runtime takes scheduled samples on game ticks: every `sampleIntervalTicks` (default 20), once more on the
budget tick, and each time the world comes to rest (an action ends and nothing needs game time), whatever the
wall-clock speed of the server or the Harness. An item obtained and lost between two samples is not
confirmed. A failed capture contributes no facts, and a missing partition does not affect the partitions that
are present.

A scorer reads only the Attempt's `task/observations.jsonl.gz`, requires the `observation-partition-replace`
encoding version 1, and restores every logical observation before scoring. Older full JSONL or gzip logs must
be converted first; there is no reader for the old format. The partitions, the format, and the converter are
described in the [observation format](../observation-format.md). The Task finishes the gzip stream when it
ends; a corrupt or truncated stream fails scoring.

Every scoring writes `score.json` and `curve.json`. They record the encoding name and version, the size of the
decompressed log, the SHA-256 of the rubric and the scorer (including the shared decoder and the format
definition), the budget, the termination state, and the number of capture errors. Converting a log's encoding
changes its hash but not the scored facts or the sample ticks. Only an Attempt whose Runner and cleanup
completed and whose Task outcome is the budget `timeout` has `primaryEligible: true`.

Commands are in the [Survival](../../minecraft-survival/README.md) and
[Discovery](../../minecraft-item-discovery/README.md) READMEs. Rescoring always writes to a new output
directory.

## Python entry points

- Survival, one Attempt: `python3 tasks/minecraft-survival/eval/score-survival.py`.
- Survival, a whole run with per-profile groups: `python3 tasks/minecraft-survival/eval/evaluate-survival.py`;
  see [Survival scoring](../../minecraft-survival/eval/README.md).
- Discovery, one Attempt: `python3 tasks/minecraft-item-discovery/eval/score-item-discovery.py`.
- Discovery, a whole run with Dbar and per-profile groups:
  `python3 tasks/minecraft-item-discovery/eval/evaluate-discovery.py`; see
  [Discovery scoring](../../minecraft-item-discovery/eval/README.md).
- `scoring_common.py`: the streaming observation reader and scoring metadata shared by both tasks. The task
  scoring scripts use only the Python standard library.

Group statistics and mean curves are produced here. Figures and tables read the finished group data; they do
not select Attempts or recompute group means from per-Attempt results.
