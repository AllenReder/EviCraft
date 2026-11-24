# Minecraft Survival

The Bot starts in Survival mode on Easy difficulty with an empty inventory and advances through the game on
its own; the milestones include iron ingots, an activated Nether portal, and an End portal. After a death it
respawns within the same Attempt. The experiment configs (the per-model folders under `config/`, such as
`config/deepseek-v4-1-flash/`) run for 72,000 simulation ticks (one hour of game time) in code mode. Without
`tickBudget`, a config defaults to 36,000 ticks. The task prompt states no budget and
no scoring rule.

Configs are listed in [config/README.md](./config/README.md). Relative paths in a config JSON resolve against
the file's directory. `profile` selects G (`grounded_evidence`) or L (`loaded_world_state`), and `mode`
selects `code` or `native`. The config sets the tick budget, Snapshot, skills, and model.

Before a batch, build the server and camera client templates (see the [root README](../../README.md)).
Rebuild them after the Runtime source or build settings change, and keep the build unchanged while a batch
runs.

Each Attempt's `task/` directory holds `observations.jsonl.gz` (the authoritative observations),
`advancement-definitions.json` (the static advancement definitions), and `result.json` (the effective
conditions and the termination state). Observations use the
[partition-replace encoding](../minecraft-common/observation-format.md): every sample keeps its metadata,
and only the partitions that changed are written again. The Harness and the Runner each keep their own logs.

## Scoring

The v1 rubric has 22 independent milestones. Scoring reports the highest score reached, the tick at which each
milestone was first confirmed, and nAUC. Score a whole run, including Attempt selection, per-Attempt scores,
and separate G and L group data, with:

```bash
npx evicraft score <run-directory>        # runs eval/evaluate-survival.py into <run-directory>/eval/<time>/
```

The batch entry point copies the rubric with its budget matched to the run's configs. To score one Attempt,
pass a rubric whose `tickBudget` matches that Attempt; the rubric in the repository is set to 72,000 ticks, so
an Attempt with another budget needs a copy set to that budget:

```bash
python3 tasks/minecraft-survival/eval/score-survival.py \
  --attempt <attempt-directory> \
  --rubric <budget-matched-rubric.json> \
  --out <new-score-directory>
```

See [Survival scoring and group data](./eval/README.md) for the outputs, and
[offline scoring](../minecraft-common/eval/README.md) for sampling and Attempt eligibility. The worlds and
their spawns are described in the [spawn screening report](./snapshots/spawn-screening.md).
