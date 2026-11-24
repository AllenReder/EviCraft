# Survival experiment configs

## Main experiment

Each model has a folder with 20 task JSON files (seeds 100–109 × G/L) and one `batch.yaml`:

| Folder | Served model ID | Reasoning effort |
| --- | --- | --- |
| [`deepseek-v4-1-flash/`](./deepseek-v4-1-flash/) | `deepseek-ai/DeepSeek-V4.1-Flash` | `high` |
| [`glm-5-3-flash/`](./glm-5-3-flash/) | `zai-org/GLM-5.3-Flash` | `high` |
| [`kimi-k3-1-pro/`](./kimi-k3-1-pro/) | `kimi-k3.1-pro` | `high` |
| [`qwen-3-8-flash/`](./qwen-3-8-flash/) | `Qwen/Qwen3.8-Flash-Next` | `xhigh` |
| [`qwen-3-8-27b/`](./qwen-3-8-27b/) | `Qwen/Qwen3.8-27B` | `xhigh` |
| [`qwen-3-5-9b/`](./qwen-3-5-9b/) | `Qwen/Qwen3.5-9B` | Not sent; the server template default applies |

- Each batch is ordered s100-g, s100-l, s101-g, …. DeepSeek, GLM, and Qwen repeat each of the 20 instances 5 times, for 100 Attempts (G50/L50) at a shared concurrency of 50. Kimi repeats each instance twice, for 40 Attempts at a concurrency of 20, and its JSON files also set `retries: 90` and `retryMaxDelayMs: 60000`.
- The game budget is 72,000 ticks (1 hour of game time at 20 TPS), and `mode` is `code`.
- G forgets block and entity knowledge after 400 ticks without a new observation (`groundedBlockExpiryTicks` and `groundedEntityExpiryTicks` are both 400).
- G's line of sight covers all directions (`groundedFieldOfViewDegrees` defaults to 360).
- `harness.command` is `["node", "../../../../apps/agent/dist/cli.js"]`, the reference Harness; it starts in the config's folder and reads its settings from `harness.config`.
- Every config targets an OpenAI-compatible endpoint at `http://127.0.0.1:30000/v1` (for example, a local SGLang server) with a 262144 context and a 65536 maximum output; the total request, first output, and output stall timeouts are 2 hours, 10 minutes, and 2 hours. Before starting a batch, the server must serve the matching model ID and support these context and output limits.
- Relative paths in a JSON resolve against its folder. `evicraft run` copies each JSON into the run's `inputs/configs/` with those paths made absolute, and the Harness keeps running in this folder. To use another endpoint or model, override the copy rather than editing the JSON: `--set harness.config.model.baseUrl=… --set harness.config.model.model=…`. `--concurrency N` sizes a batch to a smaller host, and `--instance <id> --repetitions 1` runs a single world.

### First-person vision

Every config in this directory enables `camera` and `harness.config.vision`: each Attempt starts an extra first-person camera client, and the Harness provides the `capture_view` tool.

```json
"camera": { "clientTemplatePath": "../../../../build/camera-client", "viewDistance": 4, "width": 854, "height": 480 },
"harness": { "config": { "vision": { "retainedImages": 3 } } }
```

Before launch:

1. Build the camera client template with `npx evicraft setup --accept-eula` (run it again after the camera mod
   changes).
2. The host that runs the Task needs Xvfb and Mesa software rendering (see [host settings](../../../README.md#host-settings) for `EVICRAFT_CAMERA_XVFB` and `LP_NUM_THREADS`). Without them, the camera fails to start and the Attempt fails during preparation.
3. Each Attempt uses one extra client JVM (`-Xmx2G`), one Xvfb, and CPU software rendering. The camera client renders at 2 FPS when no screenshot is requested.

The model routing, request timeouts, Snapshot, skills, and server template in each JSON are authoritative.

## Quickstart

[`quickstart/`](./quickstart/) is for checking an installation, not for results. Its `batch.yaml` runs the
scripted Harness (no model) on seed 100, G and L once each, for 2,400 ticks without the camera.
`reference-s100-g.json` runs the reference Harness on the same world with `deepseek-v4-1-flash` through the
DeepSeek API, which reads `DEEPSEEK_API_KEY`:

```bash
npx evicraft run tasks/minecraft-survival/config/quickstart/batch.yaml --out runs/quickstart
DEEPSEEK_API_KEY=... npx evicraft run tasks/minecraft-survival \
  --config tasks/minecraft-survival/config/quickstart/reference-s100-g.json
```
