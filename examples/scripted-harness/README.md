# Scripted Harness

`harness.mjs` is the smallest program the benchmark can run as a Harness. It uses no model: it alternates a
pause ("thinking") with a `wait` tool call ("acting") and logs how many game ticks passed in each.

It exists for two reasons:

- to show the whole contract between the benchmark and a Harness in one file;
- to check a Runtime and benchmark installation without a model server.

[`tasks/minecraft-survival/config/quickstart/`](../../tasks/minecraft-survival/config/quickstart/) has ready
configs and a batch that use it: `npx evicraft run tasks/minecraft-survival/config/quickstart/batch.yaml`. To
run it on any other batch, name it after `--`:

```bash
echo '{ "thinkMs": 1000, "waitTicks": 40 }' > scripted.json
npx evicraft run <batch.yaml> --harness-config scripted.json -- node examples/scripted-harness/harness.mjs
```

In a task config of your own:

```json
"harness": {
  "command": ["node", "<relative path from the config to>/examples/scripted-harness/harness.mjs"],
  "config": { "thinkMs": 1000, "waitTicks": 40 }
}
```

With `pauseWhenIdle` on (the default), every step should log `ticksWhileThinking: 0` and
`ticksWhileActing` equal to `waitTicks`.
