# Building your own benchmark tasks

The example below measures whether an agent obtains a wooden pickaxe. It uses the shared Minecraft Runner and
its existing inventory samples. The same structure works for a new goal built on the
[recorded observation fields](../tasks/minecraft-common/observation-format.md).

## Define the assignment

Create `tasks/wooden-pickaxe/task.ts` with a default export. The Runner loads this file from the task directory.
The Harness receives `assignment` in its task file. Update `promptRevision` when the assignment changes.

```ts
import { defineMinecraftTask } from "../minecraft-common/task.ts";

export default defineMinecraftTask({
  id: "wooden-pickaxe",
  revision: "1",
  promptRevision: "1",
  assignment: "Obtain a wooden pickaxe before the time limit.",
});
```

## Configure and run one world

Save this as `tasks/wooden-pickaxe/config/s100-g.json`. Paths in the JSON are relative to the config file.
The snapshot may come from another task or from your own [frozen world](../tasks/minecraft-survival/snapshots/spawn-screening.md).

```json
{
  "serverTemplatePath": "../../../build/survival-server",
  "serverCommand": ["node", "launch.mjs"],
  "snapshotPath": "../../minecraft-survival/snapshots/seed-100-v1",
  "profile": "grounded_evidence",
  "tickBudget": 2400,
  "harness": {
    "command": ["node", "../../../examples/scripted-harness/harness.mjs"]
  }
}
```

After [setup](../README.md#quick-start), run the config from the repository root. The scripted Harness
exercises the pipeline. To attempt the goal, supply a Harness that can explore and craft with `-- <command>`.

```bash
npx evicraft run tasks/wooden-pickaxe --config tasks/wooden-pickaxe/config/s100-g.json \
  --out runs/wooden-pickaxe
```

## Score the Attempt

Use the decoded observations to define a score. This example scores success on the first sample that contains
a wooden pickaxe. Save the rubric below as `tasks/wooden-pickaxe/eval/rubric.v1.json`. Its budget matches the
task config.

```json
{"schemaVersion": "1", "revision": "1", "tickBudget": 2400}
```

Save the scorer as `tasks/wooden-pickaxe/eval/score.py`. The shared reader decodes the observation log and
checks Attempt eligibility. The scorer streams all samples and reports the first confirmation tick.

```python
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "minecraft-common/eval"))
from scoring_common import Observations, held_ids

observations = Observations(sys.argv[1], Path(__file__).with_name("rubric.v1.json"))
if not observations.eligible:
    raise SystemExit("Choose a completed Attempt that reached its tick budget.")

first_tick = None
for sample in observations.rows():
    if first_tick is None and "minecraft:wooden_pickaxe" in held_ids(sample):
        first_tick = sample["elapsedTick"]

print(json.dumps({"success": first_tick is not None, "firstConfirmationTick": first_tick}))
```

Call `python3 tasks/wooden-pickaxe/eval/score.py "$attempt"`, where `$attempt` is the directory containing
`task/observations.jsonl.gz` and `runner/attempt.json` under `runs/wooden-pickaxe/raw/`. The CLI's `score`
command dispatches by task ID to the bundled Survival and Item Discovery scorers. For a full reference
implementation with per-Attempt results and batch summaries, see
[Item Discovery scoring](../tasks/minecraft-item-discovery/eval/README.md).

## Define a batch

Save `tasks/wooden-pickaxe/config/batch.yaml`. The paths in the batch are relative to the batch file.
Add an instance for each world and set its repeat count. Use the same batch and scorer when comparing Harnesses.

```yaml
concurrency: 1
instances:
  - id: wooden-pickaxe-s100-g
    taskPath: ..
    configPath: s100-g.json
    repetitions: 1
```

Use `npx evicraft run tasks/wooden-pickaxe/config/batch.yaml` to run the batch. For a benchmark others can
repeat, version the assignment, world snapshots, configs, rubric, and scorer together.
