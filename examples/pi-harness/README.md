# pi Harness

`harness.mjs` plugs the [pi](https://github.com/badlogic/pi-mono) agent loop into the benchmark. pi owns the
model calls, the message history and the tool loop. Its tools are the Runtime Tools, unchanged.

It is an example of the interface, not a tuned agent: it has no plan, skills, hazard handling or context
management of its own. The reference Harness in `apps/agent` has all of those.

Install its two dependencies once (the repository's own packages must already be installed and built):

```bash
cd examples/pi-harness && npm install
```

Run it on a task from the repository root. The model must be an OpenAI-compatible chat-completions endpoint:

```bash
echo '{ "baseUrl": "http://127.0.0.1:30000/v1", "model": "served-model-name" }' > pi.json
npx evicraft run tasks/minecraft-survival/config/quickstart/batch.yaml --harness-config pi.json \
  -- node examples/pi-harness/harness.mjs
```

In a task config of your own, the same Harness is

```json
"harness": {
  "command": ["node", "<relative path from the config to>/examples/pi-harness/harness.mjs"],
  "config": { "baseUrl": "http://127.0.0.1:30000/v1", "model": "served-model-name" }
}
```

Optional settings: `contextWindow` (default 128000) and `maxTokens` (default 8192). The API key is read from `OPENAI_API_KEY`.
