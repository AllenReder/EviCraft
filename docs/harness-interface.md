# Bringing your own Harness

The benchmark has three parts that meet only at two interfaces:

```
 Benchmark Runner ──(process contract)──▶ Harness ──(Runtime SDK protocol)──▶ Runtime (Minecraft server mod)
        └──────────────(Benchmark Authority protocol)──────────────────────────▶ Runtime
```

- The **Runtime** is the NeoForge mod in `runtime/`. It owns the Bot, the world, game time and the facts
  that scoring reads.
- The **Benchmark Runner** (`packages/benchmark`, `apps/cli`, `tasks/`) starts a server, sets the world
  up, starts the Harness, and records what the Runtime samples.
- The **Harness** is the agent under test. `apps/agent` is the reference Harness used in the paper. Its
  Abilities, prompts, plan and skill tools are its own design; nothing in this document depends on them.

To evaluate another agent, write a program that follows the process contract and speaks the Runtime SDK
protocol. Any language works: the protocol is JSON-RPC 2.0 over a WebSocket. `examples/scripted-harness` is a
complete Harness in one file, with no model; `examples/pi-harness` plugs an existing agent framework in.

## 1. Process contract

The Runner starts the Harness as a child process once the world is ready and the Bot exists.

Task configs select the Harness:

```json
"harness": {
  "command": ["python3", "my_agent.py"],
  "config": { "anything": "the Harness needs" }
}
```

`command` is required, and `config` is passed through unread. The paper configs name the reference Harness,
`["node", "<path to>/apps/agent/dist/cli.js"]`.

You need not edit a config to swap the Harness. `npx evicraft run <batch.yaml> -- <command…>` runs your
command in place of each config's Harness, from the current directory, and `--harness-config <file>` supplies its
`config`. For development, `npx evicraft world <task-dir> --config <file>` holds one config's world open and
`npx evicraft harness -- <command…>` starts your command on it with the same inputs. See the
[root README](../README.md#evaluating-your-own-harness).

| Input | Value |
| --- | --- |
| Working directory | `harness.workingDirectory`, by default the directory of the task config file, so relative paths in `command` and `config` resolve against it |
| `EVICRAFT_TASK_FILE` | path to a JSON file, described below |
| `EVICRAFT_RUNTIME_URL` | the Runtime SDK endpoint, for example `ws://127.0.0.1:8765/rpc` |
| `EVICRAFT_RUNTIME_BEARER_TOKEN` | the credential for that endpoint |

The task file:

```json
{
  "assignment": "the task prompt, as plain text",
  "bot": { "id": "<uuid>", "username": "bot" },
  "runtime": { "url": "ws://127.0.0.1:8765/rpc" },
  "outputDirectory": "/…/attempt-0/task",
  "config": { "anything": "the Harness needs" }
}
```

Rules:

- The Bot already exists. Do not create one; control the one named in `bot`.
- Play until the Runner sends `SIGINT` (followed by `SIGTERM`, then `SIGKILL`, if the process stays). The
  Runner sends it when the tick budget ends.
- Exiting earlier, with any exit code, ends the attempt as a failure. An agent that has nothing left to do
  should keep calling `wait`.
- Standard output and standard error are saved as `harness.log` in `outputDirectory`. The Harness may write
  its own files there too.
- The Harness is not told the tick budget or the scoring rules.

## 2. Game time

The Runtime owns the clock. One tick is 1/20 s of game time.

With `pauseWhenIdle` on (the default in every task config), the world advances only while:

- a tool call is in progress, including `wait`; or
- the Bot is dead or respawning.

At every other moment the world stands still: model latency and Harness overhead cost no game time. Two agents
with different thinking speed get the same world.

With `pauseWhenIdle` off, the world runs at real-time speed whatever the Harness does.

The only way to let time pass without acting is the `wait` tool. `runtime.time.await_tick` only watches the
clock and never makes it move.

The Runtime counts the tick budget, takes the scoring samples, and stops the world on the budget tick. The
Harness cannot extend, shorten or observe the budget.

## 3. Runtime SDK protocol (version 4)

### Transport

- WebSocket, path `/rpc`, loopback only. Default port 8765.
- The handshake carries `Authorization: Bearer <token>`.
- One controller at a time. A second connection is refused with HTTP 409 while the first is open.
- Text frames, one JSON-RPC 2.0 message each. Requests need a numeric or string `id`.
- When the connection closes, the Runtime cancels that connection's pending waits and running tasks. A
  Harness that reconnects starts from a fresh `observation.observe`.

### Methods

| Method | Params | Result |
| --- | --- | --- |
| `runtime.info` | `{}` | versions, `world_knowledge_profile`, expiry settings, `simulation_suspended`, `pause_when_idle` |
| `actor.get` | `{}` | the Bot, or `null` |
| `actor.create` | `{username}` | the Bot (not needed under the Benchmark Runner) |
| `observation.observe` | `{}` | `{observation_revision, server_tick, game_time}` |
| `observation.capture_view` | `{}`, `{yaw, pitch}` or `{target_block}` | a first-person PNG frame |
| `knowledge.query` | `{operation, …}` | what the Bot knows about blocks and entities |
| `tool.list` | `{}` | `{tools: [{name, description, parameters, execution}]}` |
| `tool.call` | `{name, arguments}` | a task result |
| `task.cancel` | `{task_id}` | `{task_id, cancelled}` |
| `runtime.time.await_tick` | `{after_tick}` or `{ticks}` | `{server_tick}` |

`runtime.info` answers `protocol_version: 4`. A client should refuse any other version.

**Observation.** `observation.observe` refreshes what the Bot knows from what it currently perceives and
returns the tick it did so on. It works while the world stands still and costs no game time. Call it before
each decision.

**Knowledge.** `knowledge.query` reads the Bot's accumulated knowledge; it never reads the live world.
Operations: `block.get {dimension, positions}`, `block.find {dimension, block_id_glob, origin?, limit?}`,
`block.region {dimension, min, max}`, `entity.get {uuid}`, `entity.list {dimension?, entity_id_glob?,
item_id_glob?}`. A block cell is `UNKNOWN`, `KNOWN_AIR` or `KNOWN_BLOCK`. Under the `grounded_evidence`
profile the Bot knows only what it has observed, and facts expire; under `loaded_world_state` it knows every
loaded chunk. The profile is fixed per world and reported by `runtime.info`.

**View.** `observation.capture_view` needs a camera client attached to the server (the `camera` section of a
task config). Without one it fails with error `-32010`.

**Tools.** `tool.list` is the catalogue: every action the Bot can take (move, mine, place, craft, fight, use
containers, …) and every status query, each with a description and a JSON Schema for its arguments.
`execution` is `body` for actions that use the Bot's body and `query` for the rest. The catalogue is the same
for every Harness. Its conventions:

- A block position is `{x, y, z}` with integers, in arguments and in results. Tools act in the Bot's current
  dimension; only `knowledge.query` names a dimension.
- Tools that act on a block (`break_block`, `activate_block`, `use_item_on_block`, `place_block`, `enter_bed`)
  do not travel; `goto`, `goto_block_interaction_pose` and `goto_block_placement_pose` do. Tools that act on
  an entity (`interact_entity`, `attack`, `collect_items`) walk to it themselves.
- `goto` takes one explicit goal:

  ```json
  { "goal": { "kind": "column", "x": 10, "z": 20 } }
  { "goal": { "kind": "cell", "position": { "x": 10, "y": 64, "z": 20 }, "exact": true } }
  { "goal": { "kind": "elevation", "y": 12 } }
  { "goal": { "kind": "block", "block_id_glob": "minecraft:crafting_table" } }
  ```

- `use_item` uses a carried item in open air (a bow, a shield, a snowball, a fishing rod); items used on a
  block or an entity go through `use_item_on_block` and `interact_entity`.
- Menus: `activate_block` opens one; `inspect_gui` reads it (`menu_type` is its registry id, each slot has a
  `role` such as `input`, `fuel`, `output`, `crafting_grid`, `container`, `hotbar`, `inventory`);
  `transfer` moves items between slots; `menu_button` presses a button (an enchanting option, a stonecutter
  recipe); `close_gui` closes it.

`tool.call` answers when the task ends, however long that takes in wall-clock time:

```json
{ "success": false, "message": "…", "failure_type": "no_path", "timed_out": true, "interrupted": true,
  "data": { }, "start_tick": 4310, "end_tick": 4352 }
```

- `start_tick` and `end_tick` are the server ticks the call spanned; their difference is the game time it
  cost. A query costs none.
- `timed_out` and `interrupted` appear only when true. Each task has a deadline in game ticks set by the
  Runtime; a client needs no wall-clock timeout of its own.
- `data` is specific to the tool.
- A failed action is a normal result, not a JSON-RPC error. That includes a call the Runtime refuses outright:
  an unknown tool name, arguments that do not fit the schema, or a body action sent while another is running.

**Failure types.** Every result with `success: false` carries one `failure_type`. Branch on it, not on
`message`.

| `failure_type` | Meaning |
| --- | --- |
| `unknown_tool`, `invalid_arguments` | the call itself was wrong |
| `busy` | a body action is already running; wait for it or cancel it |
| `actor_unavailable` | the Bot does not exist yet |
| `timed_out`, `interrupted` | the task hit its deadline, or was cancelled |
| `internal` | a fault inside the Runtime; the state of the action is unknown |
| `unspecified` | the tool gave no more specific cause; read `message` |
| `target_not_known_block`, `target_unknown`, `aim_not_known_air`, `unknown_not_known` | the target is not in the Bot's knowledge in the state the tool needs |
| `target_changed`, `target_lost`, `target_occupied` | the target is no longer what the Bot knew |
| `out_of_reach`, `occluded`, `unreachable`, `no_path`, `boxed_in`, `stance_dud`, `no_interaction_pose`, `no_placement_pose` | the Bot cannot get to the target, or cannot reach or see it from where it stands |
| `no_effect`, `verification_failed`, `unbreakable`, `unsupported_shape`, `not_fluid_source` | the action was performed but the world did not change as it should |
| `item_not_found`, `no_material`, `item_not_supported`, `item_not_block`, `multi_cell_item`, `wrong_tool` | the item is missing or cannot be used this way |
| `no_support`, `entity_blocked`, `body_in_target`, `second_cell_not_free` | a block cannot be placed there |
| `menu_open`, `menu_not_open`, `menu_changed` | a menu is open when none may be, none is open, or it changed since `inspect_gui` |
| `no_space`, `inventory_full`, `missing_ingredients`, `needs_crafting_table`, `no_recipe`, `crafted_nothing` | inventory and crafting |
| `not_sleep_time`, `occupied`, `obstructed`, `unsafe_nearby_monster`, `bed_not_usable_in_dimension`, `accepted_but_not_sleeping` | beds |
| `no_block_item_match`, `too_many_item_id_globs`, `too_many_effective_items` | `manage_scaffold_materials` |

Tools that had a `failure_type` before protocol 4 also repeat it inside `data`.

**Cancel.** The `id` of a `tool.call` request is its task id. `task.cancel {task_id}` asks the Runtime to stop
it; the original `tool.call` then answers with `interrupted: true`.

**Wait.** `tool.call {name: "wait", arguments: {ticks}}` lets `ticks` game ticks pass (0 to 6000) and answers
`success: true`. It does not use the body, so it may overlap a body task. It can be cancelled like any task.

**Clock.** `runtime.time.await_tick` answers once the server tick passes `after_tick`, or once `ticks` further
ticks have run. It has no deadline and does not make time pass.

### Notifications

The Runtime pushes `runtime.occurrence` without being asked:

```json
{ "jsonrpc": "2.0", "method": "runtime.occurrence",
  "params": { "type": "damage_received", "sequence": 12, "server_tick": 4310, "data": { } } }
```

| `type` | `data` |
| --- | --- |
| `body_state_changed` | `health`, `max_health`, `air`, `max_air`, `underwater`, `in_lava`, `on_fire`, `suffocating`, `intersecting_blocks` |
| `damage_received` | `amount`, `health`, `max_health`, `damage_type` |
| `actor_lifecycle_changed` | `uuid`, `name`, `lifecycle_state` (`starting`, `alive`, `dead`, `respawning`) |

Occurrences are facts, not instructions. Whether to interrupt a running action when one arrives is the
Harness's decision. They are not replayed after a reconnect.

### Errors

| Code | Meaning |
| --- | --- |
| `-32700`, `-32600`, `-32601`, `-32602` | standard JSON-RPC: parse error, invalid request, unknown method, invalid params |
| `-32603` | the operation failed or was cancelled inside the Runtime |
| `-32009` | `actor.create` conflicts with the existing Bot |
| `-32010` | no view can be captured |

### TypeScript client

`@evicraft/runtime-sdk` (`runtime/sdk/typescript`) wraps the protocol and carries the full result types.
It is a convenience, not part of the contract.

### Reusing the reference Abilities

The reference Harness's Abilities (`collect_blocks`, `craft`, `smelt_at_furnace`, `mine_down`,
`tunnel_for_blocks`, …) are routines written over the Runtime Tools. A TypeScript Harness can use them without
the rest of `apps/agent`, which keeps the action set fixed when two agent loops are compared:

```js
import { AbilityRuntime, RuntimeAdapter, selectHarnessAbilities } from "@evicraft/harness";

const info = await client.runtimeInfo();                 // client: a connected RuntimeClient
const abilities = new AbilityRuntime();
for (const definition of selectHarnessAbilities(info.world_knowledge_profile, "profile-default").definitions) {
  await abilities.register(definition);
}
const runtime = new RuntimeAdapter(client);
abilities.modelTools();                                   // [{ name, description, inputSchema }]
await abilities.dispatch("collect_blocks", { block_id_glob: "minecraft:*_log", count: 4 }, { runtime, signal });
```

A Harness in another language has the Runtime Tools only.

## 4. Benchmark Authority protocol

The Runner talks to the Runtime over a second endpoint (default port 8766, same transport, its own token). The
Harness never receives this token. Task authors use it through `TaskContext.world` in `packages/benchmark`;
the wire format matters only to someone replacing the Runner.

It has two jobs.

**World setup**, while the world is held: `actor.create`, `actor.teleport`, `actor.respawn.set`,
`actor.item.give`, `actor.inventory.set`, `actor.equipment.set`, `world.block.get`, `world.block.set`,
`world.command.execute`, `world.time.pause`, `world.time.resume`, `world.time.get`, and the reads
`benchmark.info`, `benchmark.snapshot.get`, `benchmark.advancement_definitions.get`, `benchmark.diagnostics`.

**The run.**

1. `benchmark.run.start {tick_budget, sample_interval_ticks}` answers `{start_tick, sample}`. `sample` is the
   sample at elapsed tick 0. The call releases the world: from here it advances as section 2 describes.
2. After every tick whose elapsed count is a multiple of `sample_interval_ticks`, and on the budget tick, the
   Runtime pushes `benchmark.sample`. A sample holds `elapsed_tick`, the Bot's state and inventory, its
   location, advancements and nearby portals, the death and portal-activation counts, and the server tick it
   was taken on. Samples fall on exact game ticks whatever the wall-clock speed of the server or the Harness.
   The Runtime pushes one more `benchmark.sample` each time the world comes to rest: nothing needs game time
   any more, and a tick ran or a Tool call finished since the last rest. It carries the tick the world stopped
   on, so it may repeat the tick of the sample before it. It records a change made after the last interval
   sample, which would otherwise go unseen for as long as the world stays idle.
3. On the budget tick the Runtime holds the world and pushes `benchmark.run.finished {reason: "tick_budget",
   elapsed_tick}`.

The task configs set `sampleIntervalTicks` (default 20, one second of game time). The Runner writes each
sample to `task/observations.jsonl.gz`; scoring reads only that file.

## 5. Checking an installation

`npx evicraft check` runs `apps/cli/test/integration/`. Its `benchmark-run.mjs` runs three attempts against real servers, two with the
scripted Harness and one with the reference Harness driven by a scripted model endpoint
(`scripts/verify/mock-model-server.mjs`). It needs no GPU and no model. It asserts that thinking costs no
ticks, that a `wait` costs exactly its ticks, that samples fall on the interval, and that the run stops on the
budget tick.
