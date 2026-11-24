# Running benchmarks

Run `npx evicraft setup --accept-eula` to prepare the server and camera templates under `build/`.
Use `--no-camera` for a setup that only runs configs without a camera. `--offline` uses Gradle's
existing cache. Rerun setup after changing the Runtime or camera source.

## Host settings

Set `--concurrency` based on the memory and CPU available to the server JVMs and camera clients.
Host settings are supplied through the environment when you launch the CLI.

| Variable | Default | Effect |
| --- | --- | --- |
| `EVICRAFT_SERVER_HEAP` | JVM default | Maximum heap per server JVM, as a JVM size such as `4G`. |
| `EVICRAFT_SERVER_JAVA`, `EVICRAFT_CAMERA_JAVA` | Java selected during setup | Java executable for each server and camera client. |
| `EVICRAFT_CAMERA_XVFB` | `Xvfb` on `PATH` | Xvfb executable for each camera client. |
| `LP_NUM_THREADS` | Mesa default | Rendering threads per camera client. |
| `EVICRAFT_PYTHON` | `python3` on `PATH` | Interpreter used by `evicraft score`. |

Gradle uses `GRADLE_USER_HOME` for its cache and reads `systemProp.https.proxyHost` and
`systemProp.https.proxyPort` from `gradle.properties`.

## Run lifecycle

1. The Runner freezes the batch's effective configs under `<run>/inputs/`, including `--set` overrides and
   any replacement Harness. It resolves paths and writes the inspected plan to `<run>/dry-run.json`.
2. Each Attempt copies the server template and world snapshot, starts the server, creates the Bot, and
   launches the camera client if configured. The Runner resets game time and puts the Bot at the configured
   spawn with an empty inventory.
3. The Runtime starts the benchmark clock and records the initial sample. The Harness starts in its working
   directory with the task file. The Runtime records samples through the budget tick, and the Runner cleans up
   the processes. Samples and logs go under `<run>/raw/`.
4. For the built-in tasks, `evicraft score <run>` reads the recorded data and writes `<run>/eval/<time>/`.

Use `--dry-run` to inspect a configured plan without starting servers, `--instance <id> --repetitions 1` to
try one world, and `evicraft resume <run>` to continue an interrupted batch. `npx evicraft help` lists the CLI
options.

For a development world, `world` prepares the same environment and holds it open. The `harness` command
starts the configured Harness, or your own command after `--`, on that world. Start `world` with the
[reference quickstart config](../tasks/minecraft-survival/config/quickstart/reference-s100-g.json) to use
`npx evicraft harness manual` and call the reference Harness's Abilities interactively.

## Reference Harness and model endpoints

The reference Harness accepts `openai-compatible`, `openai`, and `deepseek` in
`harness.config.model.provider`. An OpenAI-compatible endpoint can speak Chat Completions or Responses and can
name a key environment variable in `model.apiKeyEnvironmentVariable`. The other providers read
`OPENAI_API_KEY` or `DEEPSEEK_API_KEY`.

Each model directory has `batch-g.yaml` and `batch-l.yaml` with the corresponding instances from its
paper `batch.yaml`. To run the configured reference Harness, serve the model in those configs or set
`harness.config.model.baseUrl` and `harness.config.model.model` for your endpoint. The endpoint must support
the configured context and output limits. When you supply your own command after `--`, the CLI replaces the
entire Harness configuration.

For a short run with the reference Harness and the DeepSeek API, see the
[Survival quickstart configs](../tasks/minecraft-survival/config/README.md#quickstart).
