# Minecraft Item Discovery

The Bot starts with an empty inventory and explores to obtain as many distinct items as it can. The task
reuses Survival's Snapshots, initialization, respawn policy, and sampling. The main code-mode experiment (the
per-model folders under `config/`, such as `config/deepseek-v4-1-flash/`) runs for 144,000 simulation ticks
(two hours of game time). Both G and L world knowledge profiles and
both `code` and `native` modes are supported.

Configs are listed in [config/README.md](./config/README.md). The task uses the same `build/survival-server` template as Survival; see the
[Survival README](../minecraft-survival/README.md) for the Attempt outputs.

The main experiment runs one batch per model: seeds 100–109 × G/L. DeepSeek, GLM, and Qwen run 5 repetitions
each, 100 Attempts at concurrency 50; Kimi runs one, 20 Attempts at concurrency 20.

## Scoring

The v1 rubric counts the distinct canonical item IDs held with a positive count in the scoring samples,
across the 36 inventory slots, the main hand, the off hand, and the armor slots; each ID counts once. One
Attempt yields the total, the first confirmation tick of each item, and a cumulative curve; there are no
categories and no nAUC. Observations use the
[partition-replace encoding](../minecraft-common/observation-format.md); sampling and Attempt eligibility are
described in [offline scoring](../minecraft-common/eval/README.md).

Score a whole run, including the time-averaged breadth Dbar and separate G and L group data, in up to 32
worker processes by default:

```bash
npx evicraft score <run-directory>        # runs eval/evaluate-discovery.py into <run-directory>/eval/<time>/
```

The batch entry point copies the rubric with its budget matched to the run's configs. To score one Attempt,
pass a rubric whose `tickBudget` matches that Attempt; the rubric in the repository is set to 144,000 ticks,
so an Attempt with another budget needs a copy set to that budget:

```bash
python3 tasks/minecraft-item-discovery/eval/score-item-discovery.py \
  --attempt <attempt-directory> \
  --rubric <budget-matched-rubric.json> \
  --out <new-score-directory>
```

See [Discovery scoring and group data](eval/README.md) for the outputs.
