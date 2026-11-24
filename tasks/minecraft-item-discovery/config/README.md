# Item Discovery experiment configs

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

- Each batch is ordered s100-g, s100-l, s101-g, …. DeepSeek, GLM, and Qwen repeat each of the 20 instances 5 times, for 100 Attempts (G50/L50) at a shared concurrency of 50. Kimi runs each instance once, for 20 Attempts at a concurrency of 20, and its JSON files also set `retries: 90` and `retryMaxDelayMs: 60000`.
- The game budget is 144,000 ticks (2 hours of game time at 20 TPS), and `mode` is `code`.
- `harness.command` is `["node", "../../../../apps/agent/dist/cli.js"]`, the reference Harness; it starts in the config's folder and reads its settings from `harness.config`.
- Every config targets an OpenAI-compatible endpoint at `http://127.0.0.1:30000/v1` (for example, a local SGLang server) with a 262144 context and a 65536 maximum output; the total request, first output, and output stall timeouts are 2 hours, 10 minutes, and 2 hours. DeepSeek is served with a DSML tool-call parser that returns tool arguments only after they are fully generated. Before starting a batch, the server must serve the matching model ID and support these context and output limits.
- Relative paths in a JSON resolve against its folder. `evicraft run` copies each JSON into the run's `inputs/configs/` with those paths made absolute, and the Harness keeps running in this folder. To use another endpoint or model, override the copy rather than editing the JSON: `--set harness.config.model.baseUrl=… --set harness.config.model.model=…`. `--concurrency N` sizes a batch to a smaller host, and `--instance <id> --repetitions 1` runs a single world. Discovery uses the same `build/survival-server` template as Survival.
- All configs enable first-person vision (`vision`, the `capture_view` tool); see the [Survival config notes](../../minecraft-survival/config/README.md#first-person-vision) for the fields and the setup before launch.

The model routing, request timeouts, Snapshot, skills, and server template in each JSON are authoritative.
